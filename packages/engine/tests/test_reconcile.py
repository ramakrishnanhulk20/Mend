# Not covered here: the real PayPal duplicate refusal and the batch webhook that
# resolves exists_unresolved (prove_m5 shows both live), the scheduler that runs
# reconcile, and a sender that is still alive after 10 minutes (submit_batch gives
# up within about 52 seconds, so none can be).
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

from mend_engine.campaigns.approval import approve, review_hash
from mend_engine.campaigns.reconcile import RECONCILE_LOCK, reconcile
from mend_engine.campaigns.submission import REFUSED_REASON, submit
from mend_engine.config import SANDBOX_API_HOST, Config
from mend_engine.db.connect import PGDATA, SCHEMA_PATH
from mend_engine.members.consent import DEMO_SHOP_NAME
from mend_engine.members.membership import join_member
from mend_engine.paypal import payouts
from mend_engine.paypal.http import PayPalHttp

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
            connection.execute(SCHEMA_PATH.read_text(encoding="utf-8"))
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
    """

    def __init__(self, lose_answers: int = 0, refuse: Callable[[], httpx.Response] | None = None) -> None:
        self.batches: dict[str, str] = {}
        self.posts: list[str] = []
        self.lose_answers = lose_answers
        self.refuse = refuse
        self.lock = threading.Lock()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 32000})
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


def test_a_refusal_follows_submits_rules_and_a_bad_snapshot_is_left_alone(conn: psycopg.Connection) -> None:
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

    actions = reconcile(conn, paypal.http()).actions
    assert {a.after for a in actions} == {"voided"}
    assert conn.execute("select void_reason from campaigns where campaign_id = %s", (refused,)).fetchone()[0] == REFUSED_REASON


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
