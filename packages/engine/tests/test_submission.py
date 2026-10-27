# Not covered here: real PayPal answers and timing (prove_m4b sends one real batch
# and races 20 real connections against it), reconciling a campaign left in
# submitting or submission_unknown (test_reconcile.py), a process killed between
# PayPal's answer and the ledger write, and PayPal's reporting balance lagging
# behind payouts it has already taken (the floor is what absorbs that).
import json
import threading
import time
import uuid
from collections.abc import Callable, Iterator

import httpx
import pgserver
import psycopg
import pytest
from psycopg import sql

from mend_engine.campaigns import submission
from mend_engine.campaigns.approval import approve, review_hash, set_amount
from mend_engine.campaigns.spend import CapExceeded
from mend_engine.campaigns.submission import REFUSED_REASON, submit
from mend_engine.config import SANDBOX_API_HOST, Config
from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema
from mend_engine.members.consent import DEMO_SHOP_NAME
from mend_engine.members.membership import LEFT_REASON, join_member, leave_member
from mend_engine.paypal import payouts
from mend_engine.paypal.balances import BalanceTooLow
from mend_engine.paypal.http import PayPalHttp
from mend_engine.paypal.payouts import BatchSnapshot, PayoutItemSpec, SnapshotRefused, canonical_json, snapshot_hash

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
def schema(server_url: str) -> Iterator[str]:
    name = "m4b_test_" + uuid.uuid4().hex[:12]
    with psycopg.connect(server_url, autocommit=True) as admin:
        admin.execute(sql.SQL("create schema {}").format(sql.Identifier(name)))
        try:
            yield name
        finally:
            admin.execute(sql.SQL("drop schema {} cascade").format(sql.Identifier(name)))


def open_conn(server_url: str, schema: str) -> psycopg.Connection:
    connection = psycopg.connect(server_url, autocommit=True)
    connection.execute(sql.SQL("set search_path to {}").format(sql.Identifier(schema)))
    return connection


@pytest.fixture
def conn(server_url: str, schema: str) -> Iterator[psycopg.Connection]:
    with open_conn(server_url, schema) as connection:
        apply_schema(connection)
        yield connection


@pytest.fixture(autouse=True)
def no_waiting(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(payouts, "_sleep", lambda _seconds: None)


def approved_campaign(conn: psycopg.Connection, amounts: tuple[int, ...] = (250, 300), first: int = 1) -> uuid.UUID:
    """An approved campaign paying amounts to new members numbered from first, plus one held back."""
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values (%s, 'goal', '2026-10-16', 1000, 300, 0.5, 'draft') returning campaign_id",
        (DEMO_SHOP_NAME,),
    ).fetchone()[0]
    for rank in range(1, len(amounts) + 2):
        n = first + rank - 1
        conn.execute("insert into shop_customers values (%s, 'Maya R.', %s, 'UK')", (f"C{n}", f"c{n}@shop.example"))
        conn.execute("insert into shop_orders values (%s, %s, '2026-06-01 12:00+00', 1000, 'USD')", (f"o{n}", f"C{n}"))
        member_id = join_member(
            conn, paypal_email=f"c{n}@shop.example", paypal_payer_id=None, email_verified=True,
            shop_name=DEMO_SHOP_NAME, client_id="cid",
        )
        reward = rank <= len(amounts)
        conn.execute(
            "insert into campaign_members values (%s, %s, %s, %s, %s, 0.1, %s, %s)",
            (campaign_id, f"R{rank}", member_id, "reward" if reward else "holdout", rank,
             amounts[rank - 1] if reward else None, NOTE if reward else None),
        )
    approve(conn, campaign_id, approver="owner", presented_hash=review_hash(conn, campaign_id), config=CONFIG)
    return campaign_id


BALANCES_PATH = "/v1/reporting/balances"


def balance_answer(balance: str | int) -> httpx.Response:
    """PayPal's balance answer in its live shape for a USD value, or an error with that HTTP status."""
    if isinstance(balance, int):
        return httpx.Response(balance, json={"name": "SERVICE_UNAVAILABLE"})
    money = {"currency_code": "USD", "value": balance}
    return httpx.Response(200, json={"balances": [{"currency": "USD", "available_balance": money, "total_balance": money}]})


class FakePayPal:
    """Answers the token, balance and batch calls; post decides each Payouts answer. Thread safe.

    balance is the USD available balance as PayPal writes it, or an HTTP status to fail
    with; it stays the same after a batch leaves, as PayPal's lagging report does.
    balance_delay is how long each balance read takes.
    """

    def __init__(
        self,
        post: Callable[[dict], httpx.Response],
        gets: dict[str, httpx.Response] | None = None,
        balance: str | int = "5033.32",
        balance_delay: float = 0.0,
    ) -> None:
        self.post = post
        self.gets = gets or {}
        self.balance = balance
        self.balance_delay = balance_delay
        self.payout_posts: list[dict] = []
        self.get_paths: list[str] = []
        self.balance_reads = 0
        self._lock = threading.Lock()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 32000})
        if request.method == "GET" and request.url.path == BALANCES_PATH:
            with self._lock:
                self.balance_reads += 1
            time.sleep(self.balance_delay)
            return balance_answer(self.balance)
        if request.method == "POST" and request.url.path == payouts.PAYOUTS_PATH:
            body = json.loads(request.content)
            with self._lock:
                self.payout_posts.append(body)
            return self.post(body)
        with self._lock:
            self.get_paths.append(request.url.path)
        return self.gets[request.url.path]

    def http(self) -> PayPalHttp:
        return PayPalHttp(CONFIG, transport=httpx.MockTransport(self))


def created(body: dict, payout_batch_id: str = "BATCH1") -> httpx.Response:
    sender_batch_id = body["sender_batch_header"]["sender_batch_id"]
    return httpx.Response(
        201, json={"batch_header": {"payout_batch_id": payout_batch_id, "sender_batch_header": {"sender_batch_id": sender_batch_id}}}
    )


def already_exists(_body: dict) -> httpx.Response:
    return httpx.Response(
        400,
        json={"name": "USER_BUSINESS_ERROR", "debug_id": "dbg", "links": [],
              "details": [{"issue": "Batch with given sender_batch_id already exists", "field": "SENDER_BATCH_ID"}]},
    )


def timeout(_body: dict) -> httpx.Response:
    raise httpx.ReadTimeout("slow")


def state(conn: psycopg.Connection, campaign_id: uuid.UUID) -> tuple:
    status = conn.execute("select status, void_reason from campaigns where campaign_id = %s", (campaign_id,)).fetchone()
    ledger = conn.execute(
        "select status, payout_batch_id from payout_batches where campaign_id = %s", (str(campaign_id),)
    ).fetchall()
    return status, ledger


def actions(conn: psycopg.Connection) -> list[str]:
    return [r[0] for r in conn.execute("select action from audit_log where action like 'payout%%' order by id")]


def member_id(conn: psycopg.Connection, email: str) -> uuid.UUID:
    return conn.execute("select member_id from members where paypal_email = %s", (email,)).fetchone()[0]


def test_an_approved_campaign_is_sent_once_from_its_frozen_snapshot(conn: psycopg.Connection) -> None:
    campaign_id = approved_campaign(conn)
    # A live change after approval must not reach the batch: only the frozen copy is read.
    # The rows are frozen by a trigger, so it is off for this one staged statement.
    conn.execute("alter table campaign_members disable trigger campaign_members_frozen")
    conn.execute("update campaign_members set amount_minor = 999 where campaign_id = %s and ref = 'R1'", (campaign_id,))
    conn.execute("alter table campaign_members enable trigger campaign_members_frozen")
    paypal = FakePayPal(created)

    result = submit(conn, paypal.http(), campaign_id, CONFIG)

    assert (result.status, result.payout_batch_id, result.sent) == ("submitted", "BATCH1", True)
    assert result.sender_batch_id.startswith("mend-")
    [body] = paypal.payout_posts
    assert [(i["receiver"], i["amount"]["value"], i["sender_item_id"]) for i in body["items"]] == [
        ("c1@shop.example", "2.50", "R1"),
        ("c2@shop.example", "3.00", "R2"),
    ]
    assert state(conn, campaign_id) == (("submitted", None), [("created", "BATCH1")])
    assert actions(conn) == ["payout_submitting", "payout_submitted"]

    again = submit(conn, paypal.http(), campaign_id, CONFIG)
    assert (again.status, again.payout_batch_id, again.sender_batch_id, again.sent) == (
        "submitted", "BATCH1", result.sender_batch_id, False,
    )
    assert len(paypal.payout_posts) == 1 and actions(conn) == ["payout_submitting", "payout_submitted"]
    # The balance is read once, before the claim; a campaign already sent needs no read.
    assert paypal.balance_reads == 1


def test_twenty_concurrent_submits_on_separate_connections_send_one_request(
    conn: psycopg.Connection, server_url: str, schema: str
) -> None:
    campaign_id = approved_campaign(conn)

    def slow_created(body: dict) -> httpx.Response:
        time.sleep(0.3)
        return created(body)

    paypal = FakePayPal(slow_created)
    connections = [open_conn(server_url, schema) for _ in range(20)]
    start = threading.Barrier(20)
    results: list = []

    def run(connection: psycopg.Connection) -> None:
        start.wait()
        results.append(submit(connection, paypal.http(), campaign_id, CONFIG))

    threads = [threading.Thread(target=run, args=(c,)) for c in connections]
    try:
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=60)
    finally:
        for connection in connections:
            connection.close()

    assert len(results) == 20 and len(paypal.payout_posts) == 1
    assert sum(r.sent for r in results) == 1
    assert {r.status for r in results if not r.sent} <= {"submitting", "submitted"}
    assert len({r.sender_batch_id for r in results}) == 1
    assert state(conn, campaign_id) == (("submitted", None), [("created", "BATCH1")])


def test_a_timeout_leaves_the_campaign_submission_unknown_and_nothing_is_resent(conn: psycopg.Connection) -> None:
    campaign_id = approved_campaign(conn)
    paypal = FakePayPal(timeout)

    result = submit(conn, paypal.http(), campaign_id, CONFIG)

    assert (result.status, result.payout_batch_id, result.sent) == ("submission_unknown", None, True)
    # submit_batch's own retries resend the identical request, never a new id.
    assert len(paypal.payout_posts) == 3
    assert {p["sender_batch_header"]["sender_batch_id"] for p in paypal.payout_posts} == {result.sender_batch_id}
    assert state(conn, campaign_id) == (("submission_unknown", None), [("submission_unknown", None)])
    again = submit(conn, paypal.http(), campaign_id, CONFIG)
    assert (again.status, again.sent, len(paypal.payout_posts)) == ("submission_unknown", False, 3)


def test_a_batch_already_in_the_ledger_is_confirmed_not_sent_again(conn: psycopg.Connection) -> None:
    campaign_id = approved_campaign(conn)
    first = FakePayPal(created)
    sender_batch_id = submit(conn, first.http(), campaign_id, CONFIG).sender_batch_id
    # The campaign row lost its update (say, a restore from backup); the ledger kept the batch.
    # The status guard refuses submitted to approved, so it is off for this one staged statement.
    conn.execute("alter table campaigns disable trigger campaigns_status_guard")
    conn.execute("update campaigns set status = 'approved' where campaign_id = %s", (campaign_id,))
    conn.execute("alter table campaigns enable trigger campaigns_status_guard")
    view = httpx.Response(
        200, json={"batch_header": {"payout_batch_id": "BATCH1", "sender_batch_header": {"sender_batch_id": sender_batch_id}}}
    )
    paypal = FakePayPal(already_exists, {"/v1/payments/payouts/BATCH1": view})

    result = submit(conn, paypal.http(), campaign_id, CONFIG)

    assert (result.status, result.payout_batch_id, result.sent) == ("submitted", "BATCH1", True)
    assert paypal.get_paths == ["/v1/payments/payouts/BATCH1"]
    assert state(conn, campaign_id) == (("submitted", None), [("already_existed", "BATCH1")])


def test_paypal_holding_the_batch_with_no_ledger_id_is_exists_unresolved(conn: psycopg.Connection) -> None:
    campaign_id = approved_campaign(conn)
    paypal = FakePayPal(already_exists)
    result = submit(conn, paypal.http(), campaign_id, CONFIG)
    assert (result.status, result.payout_batch_id) == ("exists_unresolved", None)
    assert paypal.get_paths == [] and state(conn, campaign_id) == (("exists_unresolved", None), [("exists_unresolved", None)])
    assert actions(conn) == ["payout_submitting", "payout_exists_unresolved"]


def test_a_refusal_voids_the_campaign_and_a_failed_token_leaves_it_unknown(conn: psycopg.Connection) -> None:
    refused = approved_campaign(conn)
    paypal = FakePayPal(lambda _b: httpx.Response(422, json={"name": "UNPROCESSABLE_ENTITY", "debug_id": "d1"}))
    assert submit(conn, paypal.http(), refused, CONFIG).status == "voided"
    assert state(conn, refused) == (("voided", REFUSED_REASON), [("refused", None)])
    audit = conn.execute("select detail from audit_log where action = 'payout_voided'").fetchone()[0]
    assert (audit["status"], audit["name"], audit["debug_id"]) == (422, "UNPROCESSABLE_ENTITY", "d1")

    unknown = approved_campaign(conn, first=10)
    tokens: list[int] = []

    def no_second_token(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/oauth2/token":
            tokens.append(1)
            if len(tokens) == 1:
                # A token PayPal says lasts 60 seconds is never reused, so the send needs a second one.
                return httpx.Response(200, json={"access_token": "tok", "expires_in": 60})
            return httpx.Response(500, json={"name": "INTERNAL_SERVER_ERROR"})
        if request.url.path == BALANCES_PATH:
            return balance_answer("5033.32")
        raise AssertionError("nothing but the token and the balance may be asked for")

    result = submit(conn, PayPalHttp(CONFIG, transport=httpx.MockTransport(no_second_token)), unknown, CONFIG)
    assert state(conn, unknown) == (("submission_unknown", None), [("submission_unknown", None)]) and result.sent


@pytest.mark.parametrize(
    ("status", "outcome"),
    [(400, "voided"), (422, "voided"), (401, "submission_unknown"), (403, "submission_unknown"), (429, "submission_unknown")],
)
def test_with_no_unclear_attempt_only_400_and_422_void_the_campaign(conn: psycopg.Connection, status: int, outcome: str) -> None:
    campaign_id = approved_campaign(conn)
    paypal = FakePayPal(lambda _b: httpx.Response(status, json={"name": "REFUSED", "debug_id": "d1"}))

    result = submit(conn, paypal.http(), campaign_id, CONFIG)

    assert (result.status, len(paypal.payout_posts)) == (outcome, 1)
    if outcome == "voided":
        assert state(conn, campaign_id) == (("voided", REFUSED_REASON), [("refused", None)])
    else:
        assert state(conn, campaign_id) == (("submission_unknown", None), [("submission_unknown", None)])


def test_a_refusal_after_a_timeout_leaves_the_campaign_unknown(conn: psycopg.Connection) -> None:
    campaign_id = approved_campaign(conn)
    answers: list = [httpx.ReadTimeout("slow"), httpx.Response(429, json={"name": "RATE_LIMIT_REACHED", "debug_id": "d2"})]

    def post(_body: dict) -> httpx.Response:
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    paypal = FakePayPal(post)
    result = submit(conn, paypal.http(), campaign_id, CONFIG)

    assert (result.status, result.sent, len(paypal.payout_posts)) == ("submission_unknown", True, 2)
    assert state(conn, campaign_id) == (("submission_unknown", None), [("submission_unknown", None)])
    audit = conn.execute("select detail from audit_log where action = 'payout_submission_unknown'").fetchone()[0]
    assert (audit["status"], audit["debug_id"]) == (429, "d2")


def test_a_member_who_leaves_before_the_first_post_voids_the_campaign_and_nothing_is_sent(
    conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    campaign_id = approved_campaign(conn)
    leaver = member_id(conn, "c2@shop.example")
    real_submit_batch = submission.submit_batch

    def leave_then_send(*args: object, **kwargs: object) -> object:
        # The leave lands after submit() claimed the campaign, so leave_member no longer voids it.
        leave_member(conn, leaver)
        return real_submit_batch(*args, **kwargs)

    monkeypatch.setattr(submission, "submit_batch", leave_then_send)
    paypal = FakePayPal(created)

    result = submit(conn, paypal.http(), campaign_id, CONFIG)

    assert (result.status, result.sent, paypal.payout_posts) == ("voided", False, [])
    assert state(conn, campaign_id) == (("voided", LEFT_REASON), [("refused", None)])


def test_a_member_who_leaves_between_retries_stops_the_resend_and_the_campaign_stays_unknown(conn: psycopg.Connection) -> None:
    campaign_id = approved_campaign(conn)
    leaver = member_id(conn, "c1@shop.example")

    def leave_then_fail(_body: dict) -> httpx.Response:
        leave_member(conn, leaver)
        return httpx.Response(503, json={"name": "SERVICE_UNAVAILABLE"})

    paypal = FakePayPal(leave_then_fail)
    result = submit(conn, paypal.http(), campaign_id, CONFIG)

    assert (result.status, result.sent, len(paypal.payout_posts)) == ("submission_unknown", True, 1)
    assert state(conn, campaign_id) == (("submission_unknown", None), [("submission_unknown", None)])
    blocked = conn.execute("select actor, detail from audit_log where action = 'send_blocked_member_left'").fetchall()
    assert blocked == [("engine", {"campaign_id": str(campaign_id)})]


def test_nothing_is_sent_for_a_campaign_that_is_not_approved(conn: psycopg.Connection) -> None:
    approved = approved_campaign(conn)
    draft = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 1000, 300, 0.5, 'draft') returning campaign_id"
    ).fetchone()[0]
    assert set_amount(conn, approved, "R1", 100, CONFIG).status == "voided"
    paypal = FakePayPal(created)
    never = submit(conn, paypal.http(), draft, CONFIG)
    voided = submit(conn, paypal.http(), approved, CONFIG)
    assert (never.status, never.sender_batch_id, never.sent) == ("draft", "", False)
    assert (voided.status, voided.sent) == ("voided", False) and voided.sender_batch_id.startswith("mend-")
    assert paypal.payout_posts == [] and conn.execute("select count(*) from payout_batches").fetchone()[0] == 0
    with pytest.raises(LookupError):
        submit(conn, paypal.http(), uuid.uuid4(), CONFIG)


def test_the_daily_cap_is_checked_again_at_submission(conn: psycopg.Connection) -> None:
    campaign_id = approved_campaign(conn)
    other = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 10000, 1000, 0.5, 'submitted') returning campaign_id"
    ).fetchone()[0]
    items = tuple(PayoutItemSpec(f"x{n}@shop.example", 1000, "Thanks", f"R{n}") for n in range(1, 21))
    snap = BatchSnapshot(str(other), "USD", "A thank-you", items)
    conn.execute("insert into approved_snapshots values (%s, %s, %s, now(), 'owner')", (other, snapshot_hash(snap), canonical_json(snap)))
    conn.execute(
        "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, status) values ('mend-other', %s, 'h', 'created')",
        (str(other),),
    )
    paypal = FakePayPal(created)
    with pytest.raises(CapExceeded):
        submit(conn, paypal.http(), campaign_id, CONFIG)
    assert paypal.payout_posts == [] and state(conn, campaign_id) == (("approved", None), [])
    assert actions(conn) == ["payout_refused_daily_cap"]


@pytest.mark.parametrize(("balance", "code"), [("255.99", "low_balance"), (503, "balance_unavailable"), ("lots", "balance_unavailable")])
def test_a_balance_short_of_the_batch_its_fees_and_the_floor_leaves_the_campaign_approved_and_unclaimed(
    conn: psycopg.Connection, balance: str | int, code: str
) -> None:
    # 250 + 300 cents and 25 cents for each of the 2 items: 600, on top of the 25000 floor.
    campaign_id = approved_campaign(conn)
    short = FakePayPal(created, balance=balance)

    with pytest.raises(BalanceTooLow) as caught:
        submit(conn, short.http(), campaign_id, CONFIG)

    assert caught.value.code == code and short.balance_reads == 1 and short.payout_posts == []
    assert state(conn, campaign_id) == (("approved", None), []) and actions(conn) == []
    claims = "select count(*) from campaign_status_moves where campaign_id = %s and to_status = 'submitting'"
    assert conn.execute(claims, (campaign_id,)).fetchone() == (0,)
    enough = FakePayPal(created, balance="256.00")
    assert submit(conn, enough.http(), campaign_id, CONFIG).status == "submitted" and len(enough.payout_posts) == 1


def test_a_frozen_snapshot_altered_behind_the_triggers_back_is_never_sent(conn: psycopg.Connection) -> None:
    campaign_id = approved_campaign(conn)
    conn.execute("alter table approved_snapshots disable trigger approved_snapshots_append_only")
    conn.execute("update approved_snapshots set canonical_json = replace(canonical_json, 'c1@shop.example', 'evil@shop.example')")
    conn.execute("alter table approved_snapshots enable trigger approved_snapshots_append_only")
    paypal = FakePayPal(created)
    with pytest.raises(SnapshotRefused):
        submit(conn, paypal.http(), campaign_id, CONFIG)
    assert paypal.payout_posts == [] and state(conn, campaign_id) == (("approved", None), [])


def numbered(paypal: FakePayPal) -> Callable[[dict], httpx.Response]:
    """Creates each batch under its own payout_batch_id, BATCH1 first."""
    return lambda body: created(body, f"BATCH{len(paypal.payout_posts)}")


def first_claimed_hours_ago(conn: psycopg.Connection, campaign_id: uuid.UUID, hours: int) -> None:
    conn.execute("update payout_batches set created_at = created_at - make_interval(hours => %s) where campaign_id = %s", (hours, str(campaign_id)))
    # The record of moves is append-only; the guard is off only to stage an old move.
    conn.execute("alter table campaign_status_moves disable trigger campaign_status_moves_append_only")
    conn.execute("update campaign_status_moves set moved_at = moved_at - make_interval(hours => %s) where campaign_id = %s", (hours, campaign_id))
    conn.execute("alter table campaign_status_moves enable trigger campaign_status_moves_append_only")


def test_the_room_counts_mends_own_batches_of_the_last_6_hours_against_a_balance_that_lags(conn: psycopg.Connection) -> None:
    # Each campaign is 550 cents plus 25 cents for each of its 2 items: 600. PayPal still reports 260.00 after the first leaves.
    first = approved_campaign(conn)
    second = approved_campaign(conn, first=10)
    lagging = FakePayPal(created, balance="260.00")
    lagging.post = numbered(lagging)
    assert submit(conn, lagging.http(), first, CONFIG).status == "submitted"

    with pytest.raises(BalanceTooLow) as caught:
        submit(conn, lagging.http(), second, CONFIG)

    assert caught.value.code == "low_balance" and len(lagging.payout_posts) == 1
    assert state(conn, second) == (("approved", None), [])
    # A batch more than 6 hours old is taken to be in PayPal's figure already.
    first_claimed_hours_ago(conn, first, 7)
    assert submit(conn, lagging.http(), second, CONFIG).status == "submitted"


def test_two_campaigns_sent_at_the_same_moment_cannot_both_spend_the_same_room(
    conn: psycopg.Connection, server_url: str, schema: str
) -> None:
    # 260.00 covers one 600-cent batch over the 25000 floor, not two. Each read takes 0.3 s, so without
    # one lock over read, check and claim both senders would read 260.00 before either claimed.
    campaigns = [approved_campaign(conn), approved_campaign(conn, first=10)]
    paypal = FakePayPal(created, balance="260.00", balance_delay=0.3)
    paypal.post = numbered(paypal)
    connections = [open_conn(server_url, schema) for _ in campaigns]
    start = threading.Barrier(len(campaigns))
    outcomes: list = []

    def run(connection: psycopg.Connection, campaign_id: uuid.UUID) -> None:
        start.wait()
        try:
            outcomes.append(submit(connection, paypal.http(), campaign_id, CONFIG).status)
        except BalanceTooLow as short:
            outcomes.append(short.code)

    threads = [threading.Thread(target=run, args=pair) for pair in zip(connections, campaigns)]
    try:
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=60)
    finally:
        for connection in connections:
            connection.close()

    assert sorted(outcomes) == ["low_balance", "submitted"] and len(paypal.payout_posts) == 1


def test_paypal_error_text_reaches_the_audit_log_only_in_the_shape_paypal_uses(conn: psycopg.Connection) -> None:
    odd = {"name": "<img src=x onerror=alert(1)>", "debug_id": "d1 forged line"}
    refused = approved_campaign(conn)
    assert submit(conn, FakePayPal(lambda _b: httpx.Response(422, json=odd)).http(), refused, CONFIG).status == "voided"
    unknown = approved_campaign(conn, first=10)
    assert submit(conn, FakePayPal(lambda _b: httpx.Response(503, json=odd)).http(), unknown, CONFIG).status == "submission_unknown"

    for action in ("payout_voided", "payout_submission_unknown"):
        [detail] = [row[0] for row in conn.execute("select detail from audit_log where action = %s", (action,))]
        assert (detail["name"], detail["debug_id"]) == (None, None), action
