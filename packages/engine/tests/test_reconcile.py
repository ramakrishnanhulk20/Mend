# Not covered here: the real PayPal duplicate refusal and the batch webhook that
# resolves exists_unresolved (prove_m5 shows both live), the scheduler that runs
# reconcile, a sender that is still alive after 10 minutes (submit_batch gives
# up within about 52 seconds, so none can be), and PayPal's reporting balance
# lagging behind payouts it has already taken (the floor is what absorbs that).
import json
import threading
import uuid
from collections.abc import Callable, Iterator
from dataclasses import replace

import httpx
import pgserver
import psycopg
import pytest
from psycopg import sql

from mend_engine.campaigns import reconcile as reconcile_module
from mend_engine.campaigns.approval import approve, review_hash
from mend_engine.campaigns.reconcile import RECONCILE_LOCK, reconcile
from mend_engine.campaigns.spend import database_now, spent_last_24h_minor
from mend_engine.campaigns.submission import submit
from mend_engine.config import SANDBOX_API_HOST, Config
from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema
from mend_engine.members.consent import DEMO_SHOP_NAME
from mend_engine.members.membership import join_member, leave_member
from mend_engine.paypal import payouts
from mend_engine.paypal.http import PayPalHttp
from mend_engine.paypal.payouts import BatchSnapshot, PayoutItemSpec, canonical_json, sender_batch_id_for, snapshot_hash

# The lock every demo send takes (tasks.DEMO_SPEND_LOCK), written out so the test does not lean on the code under test.
DEMO_SPEND_LOCK = 7731300005

CONFIG = Config(
    paypal_client_id="cid",
    paypal_client_secret="csecret",
    paypal_api_host=SANDBOX_API_HOST,
    database_url=None,
    dev=True,
    test_receiver=None,
    item_cap_minor=1000,
    campaign_cap_minor=10000,
    daily_cap_minor=20000,
)
NOTE = "Thank you for being a regular at Wolf and Wren Gifts. Here is a small thank-you from us."


@pytest.fixture(scope="module")
def server_url() -> Iterator[str]:
    server = pgserver.get_server(PGDATA)
    yield server.get_uri()


@pytest.fixture
def conn(server_url: str) -> Iterator[psycopg.Connection]:
    name = sql.Identifier("m5_recon_" + uuid.uuid4().hex[:12])
    with psycopg.connect(server_url, autocommit=True) as connection:
        connection.execute(sql.SQL("create schema {}").format(name))
        try:
            connection.execute(sql.SQL("set search_path to {}").format(name))
            apply_schema(connection)
            yield connection
        finally:
            connection.execute(sql.SQL("drop schema {} cascade").format(name))


@pytest.fixture(autouse=True)
def no_waiting(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(payouts, "_sleep", lambda _seconds: None)


def approved_campaign(conn: psycopg.Connection, first: int = 1) -> uuid.UUID:
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values (%s, 'goal', '2026-10-16', 1000, 300, 0.5, 'draft') returning campaign_id",
        (DEMO_SHOP_NAME,),
    ).fetchone()[0]
    for rank in (1, 2, 3):
        n = first + rank - 1
        conn.execute("insert into shop_customers values (%s, 'Maya R.', %s, 'UK')", (f"C{n}", f"c{n}@shop.example"))
        conn.execute("insert into shop_orders values (%s, %s, '2026-06-01 12:00+00', 1000, 'USD')", (f"o{n}", f"C{n}"))
        member_id = join_member(
            conn, paypal_email=f"c{n}@shop.example", paypal_payer_id=None, email_verified=True,
            shop_name=DEMO_SHOP_NAME, client_id="cid",
        )
        reward = rank < 3
        conn.execute(
            "insert into campaign_members values (%s, %s, %s, %s, %s, 0.1, %s, %s)",
            (campaign_id, f"R{rank}", member_id, "reward" if reward else "holdout", rank,
             250 if reward else None, NOTE if reward else None),
        )
    approve(conn, campaign_id, approver="owner", presented_hash=review_hash(conn, campaign_id), config=CONFIG)
    return campaign_id


class Payouts:
    """A fake Payouts API that, like PayPal, holds at most one batch per sender_batch_id.

    lose_answers makes the next that many POSTs time out after PayPal has acted on them.
    balance is the USD available balance as PayPal writes it, or an HTTP status to fail with.
    """

    def __init__(
        self, lose_answers: int = 0, refuse: Callable[[], httpx.Response] | None = None, balance: str | int = "5033.32"
    ) -> None:
        self.batches: dict[str, str] = {}
        self.posts: list[str] = []
        self.lose_answers = lose_answers
        self.refuse = refuse
        self.balance = balance
        self.lock = threading.Lock()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 32000})
        if request.method == "GET" and request.url.path == "/v1/reporting/balances":
            if isinstance(self.balance, int):
                return httpx.Response(self.balance, json={"name": "SERVICE_UNAVAILABLE"})
            money = {"currency_code": "USD", "value": self.balance}
            return httpx.Response(200, json={"balances": [{"currency": "USD", "available_balance": money}]})
        if request.method == "GET":
            payout_batch_id = request.url.path.rsplit("/", 1)[1]
            sender = next(s for s, b in self.batches.items() if b == payout_batch_id)
            return httpx.Response(200, json={"batch_header": {"payout_batch_id": payout_batch_id,
                                                              "sender_batch_header": {"sender_batch_id": sender}}})
        sender = json.loads(request.content)["sender_batch_header"]["sender_batch_id"]
        with self.lock:
            self.posts.append(sender)
            if self.refuse is not None:
                return self.refuse()
            if sender in self.batches:
                answer = httpx.Response(400, json={"name": "USER_BUSINESS_ERROR", "links": [],
                                                   "details": [{"issue": "Batch with given sender_batch_id already exists"}]})
            else:
                self.batches[sender] = f"BATCH{len(self.batches) + 1}"
                answer = httpx.Response(201, json={"batch_header": {"payout_batch_id": self.batches[sender],
                                                                    "sender_batch_header": {"sender_batch_id": sender}}})
            if self.lose_answers:
                self.lose_answers -= 1
                raise httpx.ReadTimeout("answer lost")
        return answer

    def http(self) -> PayPalHttp:
        return PayPalHttp(CONFIG, transport=httpx.MockTransport(self))


def state(conn: psycopg.Connection, campaign_id: uuid.UUID) -> tuple:
    status = conn.execute("select status from campaigns where campaign_id = %s", (campaign_id,)).fetchone()[0]
    ledger = conn.execute(
        "select sender_batch_id, payout_batch_id from payout_batches where campaign_id = %s", (str(campaign_id),)
    ).fetchall()
    return status, ledger


def backdate_submitting(conn: psycopg.Connection, campaign_id: uuid.UUID, minutes: int) -> None:
    # The record of moves is append-only; the guard is off only to stage an old move.
    conn.execute("alter table campaign_status_moves disable trigger campaign_status_moves_append_only")
    conn.execute(
        "update campaign_status_moves set moved_at = moved_at - make_interval(mins => %s) where campaign_id = %s",
        (minutes, campaign_id),
    )
    conn.execute("alter table campaign_status_moves enable trigger campaign_status_moves_append_only")


class SenderDied(BaseException):
    """Stands in for the process being killed: no handler in submit() sees it."""


def died() -> httpx.Response:
    raise SenderDied()


def claim_without_sending(conn: psycopg.Connection, campaign_id: uuid.UUID) -> str:
    """What a sender killed right after its claim leaves behind: submitting and a ledger row."""
    with pytest.raises(SenderDied):
        submit(conn, Payouts(refuse=died).http(), campaign_id, CONFIG)
    status, [(sender_batch_id, _payout_batch_id)] = state(conn, campaign_id)
    assert status == "submitting"
    return sender_batch_id


def test_a_batch_whose_answer_was_lost_is_found_never_sent_twice(conn: psycopg.Connection) -> None:
    campaign_id = approved_campaign(conn)
    paypal = Payouts(lose_answers=3)
    first = submit(conn, paypal.http(), campaign_id, CONFIG)
    assert first.status == "submission_unknown" and len(paypal.batches) == 1

    report = reconcile(conn, paypal.http())

    [action] = report.actions
    assert (action.before, action.after, action.sent) == ("submission_unknown", "exists_unresolved", True)
    assert report.waiting == (campaign_id,)
    # PayPal holds one batch; every request carried the ledger's one sender_batch_id.
    assert len(paypal.batches) == 1 and set(paypal.posts) == {first.sender_batch_id}
    assert state(conn, campaign_id) == ("exists_unresolved", [(first.sender_batch_id, None)])
    posts = len(paypal.posts)
    again = reconcile(conn, paypal.http())
    assert again.actions == () and again.waiting == (campaign_id,) and len(paypal.posts) == posts


def test_a_batch_that_never_reached_paypal_is_sent_once_under_the_same_id(conn: psycopg.Connection) -> None:
    campaign_id = approved_campaign(conn)
    down = Payouts(refuse=lambda: httpx.Response(503, json={"name": "SERVICE_UNAVAILABLE"}))
    first = submit(conn, down.http(), campaign_id, CONFIG)
    assert first.status == "submission_unknown"
    paypal = Payouts()

    [action] = reconcile(conn, paypal.http()).actions

    assert (action.after, action.payout_batch_id) == ("submitted", "BATCH1")
    assert paypal.posts == [first.sender_batch_id] and state(conn, campaign_id) == ("submitted", [(first.sender_batch_id, "BATCH1")])
    moves = conn.execute(
        "select from_status, to_status from campaign_status_moves where campaign_id = %s order by moved_at, ctid", (campaign_id,)
    ).fetchall()
    assert moves[-3:] == [("submitting", "submission_unknown"), ("submission_unknown", "submitting"), ("submitting", "submitted")]


def test_a_known_payout_batch_id_is_confirmed_at_paypal(conn: psycopg.Connection) -> None:
    campaign_id = approved_campaign(conn)
    paypal = Payouts(lose_answers=3)
    sender = submit(conn, paypal.http(), campaign_id, CONFIG).sender_batch_id
    conn.execute("update payout_batches set payout_batch_id = 'BATCH1' where sender_batch_id = %s", (sender,))

    [action] = reconcile(conn, paypal.http()).actions

    assert (action.after, action.payout_batch_id) == ("submitted", "BATCH1") and len(paypal.batches) == 1
    assert conn.execute("select status from payout_batches").fetchone()[0] == "already_existed"


def test_a_campaign_stuck_in_submitting_for_over_10_minutes_is_settled_and_a_younger_one_waits(conn: psycopg.Connection) -> None:
    old = approved_campaign(conn)
    young = approved_campaign(conn, first=10)
    old_sender = claim_without_sending(conn, old)
    claim_without_sending(conn, young)
    backdate_submitting(conn, old, 11)
    backdate_submitting(conn, young, 9)
    paypal = Payouts()

    report = reconcile(conn, paypal.http())

    assert [(a.campaign_id, a.after) for a in report.actions] == [(old, "submitted")]
    assert paypal.posts == [old_sender] and state(conn, young)[0] == "submitting"
    marked = conn.execute("select detail ->> 'campaign_id' from audit_log where action = 'reconcile_marked_unknown'").fetchall()
    assert marked == [(str(old),)]


def test_a_refusal_after_an_unclear_send_voids_nothing_and_a_bad_snapshot_is_left_alone(conn: psycopg.Connection) -> None:
    refused = approved_campaign(conn)
    submit(conn, Payouts(refuse=lambda: httpx.Response(503, json={})).http(), refused, CONFIG)
    capped = approved_campaign(conn, first=10)
    submit(conn, Payouts(refuse=lambda: httpx.Response(503, json={})).http(), capped, CONFIG)
    paypal = Payouts(refuse=lambda: httpx.Response(422, json={"name": "UNPROCESSABLE_ENTITY"}))

    # A cap lowered since approval: the stored batch no longer passes, so nothing is sent and nothing is voided.
    tight = PayPalHttp(replace(CONFIG, item_cap_minor=100), transport=httpx.MockTransport(paypal))
    skipped = reconcile(conn, tight).actions
    assert {a.reason for a in skipped} == {"the frozen snapshot fails its hash or a payout rule"} and paypal.posts == []
    assert state(conn, refused)[0] == state(conn, capped)[0] == "submission_unknown"

    # Each campaign had three unanswered attempts, so a batch may exist and a 422 now proves nothing.
    actions = reconcile(conn, paypal.http()).actions
    assert {a.after for a in actions} == {"submission_unknown"} and len(paypal.posts) == 2
    assert conn.execute("select void_reason from campaigns where campaign_id = %s", (refused,)).fetchone()[0] is None
    assert [row["status"] for row in audit_rows(conn, "payout_submission_unknown")][-2:] == [422, 422]


def unknown_after_503s(conn: psycopg.Connection, first: int = 1) -> uuid.UUID:
    campaign_id = approved_campaign(conn, first)
    submit(conn, Payouts(refuse=lambda: httpx.Response(503, json={})).http(), campaign_id, CONFIG)
    assert state(conn, campaign_id)[0] == "submission_unknown"
    return campaign_id


def audit_rows(conn: psycopg.Connection, action: str) -> list[dict]:
    return [row[0] for row in conn.execute("select detail from audit_log where action = %s order by id", (action,))]


def test_after_an_unclear_send_a_429_leaves_the_campaign_unknown(conn: psycopg.Connection) -> None:
    campaign_id = unknown_after_503s(conn)
    limited = Payouts(refuse=lambda: httpx.Response(429, json={"name": "RATE_LIMIT_REACHED"}))

    [action] = reconcile(conn, limited.http()).actions

    assert (action.after, len(limited.posts)) == ("submission_unknown", 1)
    assert state(conn, campaign_id)[0] == "submission_unknown"
    assert audit_rows(conn, "payout_submission_unknown")[-1]["status"] == 429


def test_a_member_who_left_after_an_unclear_send_is_never_resent(conn: psycopg.Connection) -> None:
    campaign_id = unknown_after_503s(conn)
    leaver = conn.execute("select member_id from members where paypal_email = 'c1@shop.example'").fetchone()[0]
    assert leave_member(conn, leaver).voided_campaigns == ()
    paypal = Payouts()

    [action] = reconcile(conn, paypal.http()).actions

    assert (action.after, action.sent, paypal.posts) == ("submission_unknown", False, [])
    assert audit_rows(conn, "send_blocked_member_left") == [{"campaign_id": str(campaign_id)}]
    # Rejoining is a new consent, not a reason to resend a batch PayPal may already hold.
    join_member(
        conn, paypal_email="c1@shop.example", paypal_payer_id=None, email_verified=True,
        shop_name=DEMO_SHOP_NAME, client_id="cid",
    )
    reconcile(conn, paypal.http())
    assert paypal.posts == [] and state(conn, campaign_id)[0] == "submission_unknown"
    assert len(audit_rows(conn, "send_blocked_member_left")) == 1


def test_a_batch_first_claimed_29_days_ago_is_never_resent(conn: psycopg.Connection) -> None:
    old = unknown_after_503s(conn)
    younger = unknown_after_503s(conn, first=10)
    for campaign_id, days in ((old, 29), (younger, 28)):
        conn.execute("update payout_batches set created_at = created_at - make_interval(days => %s) where campaign_id = %s",
                     (days, str(campaign_id)))
        backdate_submitting(conn, campaign_id, days * 24 * 60)
    paypal = Payouts()

    reconcile(conn, paypal.http())
    reconcile(conn, paypal.http())

    assert paypal.posts == [state(conn, younger)[1][0][0]] and state(conn, younger)[0] == "submitted"
    assert state(conn, old)[0] == "submission_unknown"
    assert [row["campaign_id"] for row in audit_rows(conn, "reconcile_too_old")] == [str(old)]


def test_a_resend_waits_while_the_balance_is_short_or_unreadable_and_goes_out_on_a_later_run(conn: psycopg.Connection) -> None:
    # Two items of 250 cents and 25 cents each: 550, on top of the 25000 floor.
    campaign_id = unknown_after_503s(conn)
    sender = state(conn, campaign_id)[1][0][0]

    for balance in ("255.49", 503, "255.49"):
        short = Payouts(balance=balance)
        [action] = reconcile(conn, short.http()).actions
        assert (action.after, action.sent, short.posts) == ("submission_unknown", False, [])

    assert state(conn, campaign_id)[0] == "submission_unknown" and audit_rows(conn, "reconcile_resubmitting") == []
    assert audit_rows(conn, "resend_waiting_on_balance") == [
        {"campaign_id": str(campaign_id), "sender_batch_id": sender, "reason": "low_balance"}
    ]
    paypal = Payouts(balance="255.50")
    [action] = reconcile(conn, paypal.http()).actions
    assert (action.after, action.sent, paypal.posts) == ("submitted", True, [sender])


def test_reconcile_skipped_is_written_once_per_campaign_not_on_every_run(conn: psycopg.Connection) -> None:
    first = unknown_after_503s(conn)
    second = unknown_after_503s(conn, first=10)
    paypal = Payouts()
    # A cap lowered since approval: both stored batches fail their payout rules on every run.
    tight = PayPalHttp(replace(CONFIG, item_cap_minor=100), transport=httpx.MockTransport(paypal))

    runs = [reconcile(conn, tight) for _ in range(3)]

    assert all(len(run.actions) == 2 and all(a.reason for a in run.actions) for run in runs) and paypal.posts == []
    assert sorted(row["campaign_id"] for row in audit_rows(conn, "reconcile_skipped")) == sorted([str(first), str(second)])


def test_a_campaign_unsettled_for_over_an_hour_is_flagged_once(conn: psycopg.Connection) -> None:
    stale = unknown_after_503s(conn)
    fresh = unknown_after_503s(conn, first=10)
    backdate_submitting(conn, stale, 61)
    backdate_submitting(conn, fresh, 59)
    down = Payouts(refuse=lambda: httpx.Response(503, json={}))

    reconcile(conn, down.http())
    reconcile(conn, down.http())

    assert state(conn, stale)[0] == state(conn, fresh)[0] == "submission_unknown"
    assert audit_rows(conn, "needs_attention") == [{"campaign_id": str(stale), "status": "submission_unknown"}]


def large_campaign(conn: psycopg.Connection, first: int) -> uuid.UUID:
    """An approved campaign paying 10000 cents: ten new members at 1000 each, plus one held back."""
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values (%s, 'goal', '2026-10-16', 10000, 1000, 0.5, 'draft') returning campaign_id",
        (DEMO_SHOP_NAME,),
    ).fetchone()[0]
    for rank in range(1, 12):
        n = first + rank - 1
        conn.execute("insert into shop_customers values (%s, 'Maya R.', %s, 'UK')", (f"C{n}", f"c{n}@shop.example"))
        conn.execute("insert into shop_orders values (%s, %s, '2026-06-01 12:00+00', 1000, 'USD')", (f"o{n}", f"C{n}"))
        member_id = join_member(
            conn, paypal_email=f"c{n}@shop.example", paypal_payer_id=None, email_verified=True,
            shop_name=DEMO_SHOP_NAME, client_id="cid",
        )
        reward = rank <= 10
        conn.execute(
            "insert into campaign_members values (%s, %s, %s, %s, %s, 0.1, %s, %s)",
            (campaign_id, f"R{rank}", member_id, "reward" if reward else "holdout", rank,
             1000 if reward else None, NOTE if reward else None),
        )
    approve(conn, campaign_id, approver="owner", presented_hash=review_hash(conn, campaign_id), config=CONFIG)
    return campaign_id


def first_claimed_hours_ago(conn: psycopg.Connection, campaign_id: uuid.UUID, hours: int) -> None:
    conn.execute(
        "update payout_batches set created_at = created_at - make_interval(hours => %s) where campaign_id = %s",
        (hours, str(campaign_id)),
    )
    backdate_submitting(conn, campaign_id, hours * 60)


def test_a_late_resend_waits_while_it_would_pass_the_daily_cap(conn: psycopg.Connection) -> None:
    # The auditor's repro: a 25-hour-old unknown campaign plus two new 10000 sends under a 20000 cap.
    late = large_campaign(conn, 1)
    submit(conn, Payouts(refuse=lambda: httpx.Response(503, json={})).http(), late, CONFIG)
    first_claimed_hours_ago(conn, late, 25)
    late_sender = state(conn, late)[1][0][0]
    paypal = Payouts()
    for first in (20, 40):
        assert submit(conn, paypal.http(), large_campaign(conn, first), CONFIG).status == "submitted"

    runs = [reconcile(conn, paypal.http()) for _ in range(2)]

    assert all((run.actions[0].after, run.actions[0].sent) == ("submission_unknown", False) for run in runs)
    assert late_sender not in paypal.posts and len(paypal.batches) == 2
    assert audit_rows(conn, "resend_waiting_on_cap") == [
        {"campaign_id": str(late), "sender_batch_id": late_sender, "reason": "daily_cap"}
    ]
    assert audit_rows(conn, "reconcile_resubmitting") == []
    assert spent_last_24h_minor(conn, database_now(conn)) == 20000


def demo_spent_now(conn: psycopg.Connection, items: int) -> uuid.UUID:
    """A demo campaign that took items 100-cent rewards from the demo pool just now."""
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 10000, 100, 0.5, 'submitted') returning campaign_id"
    ).fetchone()[0]
    snap = BatchSnapshot(
        str(campaign_id), "USD", "A thank-you", tuple(PayoutItemSpec(f"x{n}@shop.example", 100, "Thanks", f"R{n}") for n in range(1, items + 1))
    )
    conn.execute("insert into approved_snapshots values (%s, %s, %s, now(), 'owner')", (campaign_id, snapshot_hash(snap), canonical_json(snap)))
    conn.execute(
        "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, status) values (%s, %s, %s, 'created')",
        (sender_batch_id_for(snap), str(campaign_id), snapshot_hash(snap)),
    )
    conn.execute("insert into campaign_owners values (%s, 'demo', %s)", (campaign_id, "d" * 64))
    return campaign_id


def test_a_late_demo_resend_waits_for_the_demo_pool_and_the_demo_spend_lock(conn: psycopg.Connection, server_url: str) -> None:
    late = unknown_after_503s(conn)
    conn.execute("insert into campaign_owners values (%s, 'demo', %s)", (late, "e" * 64))
    first_claimed_hours_ago(conn, late, 25)
    late_sender = state(conn, late)[1][0][0]
    pool_taker = demo_spent_now(conn, 46)
    paypal = Payouts()

    # 4600 cents of the 5000 demo pool are out, and the resend carries 500.
    [waiting] = reconcile(conn, paypal.http()).actions
    assert (waiting.after, waiting.sent, paypal.posts) == ("submission_unknown", False, [])
    assert audit_rows(conn, "resend_waiting_on_cap") == [
        {"campaign_id": str(late), "sender_batch_id": late_sender, "reason": "demo_pool"}
    ]

    taker_sender = conn.execute("select sender_batch_id from payout_batches where campaign_id = %s", (str(pool_taker),)).fetchone()[0]
    conn.execute(
        "insert into payout_items (payout_item_id, sender_batch_id, sender_item_id, status) "
        "select 'BACK' || n, %s, 'R' || n, 'RETURNED' from generate_series(1, 46) n",
        (taker_sender,),
    )
    with psycopg.connect(server_url, autocommit=True) as other:
        other.execute("select pg_advisory_lock(%s)", (DEMO_SPEND_LOCK,))
        [busy] = reconcile(conn, paypal.http()).actions
        other.execute("select pg_advisory_unlock(%s)", (DEMO_SPEND_LOCK,))
    assert (busy.after, busy.sent, paypal.posts) == ("submission_unknown", False, [])

    [sent] = reconcile(conn, paypal.http()).actions
    assert (sent.after, sent.sent, paypal.posts) == ("submitted", True, [late_sender])
    assert len(audit_rows(conn, "resend_waiting_on_cap")) == 1


def test_an_unexpected_error_on_one_campaign_is_logged_scrubbed_and_the_run_goes_on(
    conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    broken = unknown_after_503s(conn)
    healthy = unknown_after_503s(conn, first=10)
    backdate_submitting(conn, broken, 61)
    real_frozen_snapshot = reconcile_module.frozen_snapshot

    def frozen_snapshot(connection: psycopg.Connection, campaign_id: uuid.UUID) -> object:
        if campaign_id == broken:
            raise RuntimeError(f"lost the database for {CONFIG.paypal_client_secret} and c1@shop.example")
        return real_frozen_snapshot(connection, campaign_id)

    monkeypatch.setattr(reconcile_module, "frozen_snapshot", frozen_snapshot)
    paypal = Payouts()

    report = reconcile(conn, paypal.http())

    assert [(a.campaign_id, a.after, a.sent) for a in report.actions] == [(broken, "submission_unknown", False), (healthy, "submitted", True)]
    assert audit_rows(conn, "needs_attention") == [{"campaign_id": str(broken), "status": "submission_unknown"}]
    logged = [json.loads(line) for line in capsys.readouterr().err.splitlines() if line.startswith("{")]
    [failure] = [entry for entry in logged if entry.get("outcome") == "failed"]
    assert (failure["task"], failure["campaign_id"], failure["exception"]) == ("reconcile", str(broken), "RuntimeError")
    text = json.dumps(logged)
    assert CONFIG.paypal_client_secret not in text and "c1@shop.example" not in text


def test_two_runs_never_overlap(conn: psycopg.Connection, server_url: str) -> None:
    campaign_id = approved_campaign(conn)
    submit(conn, Payouts(refuse=lambda: httpx.Response(503, json={})).http(), campaign_id, CONFIG)
    paypal = Payouts()
    with psycopg.connect(server_url, autocommit=True) as other:
        other.execute("select pg_advisory_lock(%s)", (RECONCILE_LOCK,))
        assert reconcile(conn, paypal.http()).ran is False
        other.execute("select pg_advisory_unlock(%s)", (RECONCILE_LOCK,))
    assert paypal.posts == [] and state(conn, campaign_id)[0] == "submission_unknown"
    assert reconcile(conn, paypal.http()).actions[0].after == "submitted"
    runs = conn.execute("select detail from audit_log where action = 'reconcile_run'").fetchall()
    assert runs == [({"looked_at": 1, "sent": 1, "waiting": 0},)]
