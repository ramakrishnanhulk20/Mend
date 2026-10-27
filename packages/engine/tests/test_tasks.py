# Not covered here: the web app's own session, permission, CSRF and rate-limit checks
# (packages/web tests and prove:m7a/m7b), real PayPal answers (prove_m4b and prove_m5),
# the real model facts (python -m mend_engine.store_facts computes and stores them),
# the task server that runs these tasks on Render (test_task_server.py), and two demo
# drafts, or two demo submits, from one session racing on separate connections (the
# session lock is exercised only in sequence, the demo spend lock only against a
# connection that holds it).
import hashlib
import json
import math
import random
import re
import secrets
import threading
import uuid
from collections.abc import Iterator
from datetime import date, datetime, time, timedelta, timezone
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

import httpx
import pgserver
import psycopg
import pytest
from psycopg import sql
from psycopg.types.json import Jsonb

from mend_engine import store_facts, tasks
from mend_engine.campaigns.drafts import NOTE_TEMPLATE
from mend_engine.config import SANDBOX_API_HOST, Config, ConfigError
from mend_engine.db.connect import PGDATA, connect
from mend_engine.db.migrate import apply_schema
from mend_engine.members.consent import DEMO_SHOP_NAME
from mend_engine.members.membership import join_member
from mend_engine.paypal import payouts
from mend_engine.paypal.http import PayPalHttp
from mend_engine.paypal.payouts import BatchSnapshot, PayoutItemSpec, canonical_json, sender_batch_id_for, snapshot_hash

AS_OF = date(2026, 10, 16)
FIRST_DAY = date(2024, 10, 17)
SECRET = "csecret-for-task-tests"
REF_SHAPE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
DEMO_SETTINGS = {
    "goal_text": "Bring back the regulars who have gone quiet",
    "as_of": "2026-10-16",
    "budget_minor": 1000,
    "per_recipient_minor": 200,
    "holdout_share": "0.50",
    "max_candidates": 10,
}


class FakePayPal:
    """Answers the token, balance, Payouts create, item cancel and Orders create calls, and records every other request.

    Each batch created gets the next id, BATCH1 first, unless create_status is not
    201, when PayPal refuses the batch with that status. A cancel is answered RETURNED,
    or with cancel_status when that is not 200. balance is the USD available balance
    as PayPal writes it, or an HTTP status to fail the balance read with.
    """

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.cancel_status = 200
        self.create_status = 201
        self.batches = 0
        self.balance: str | int = "5033.32"

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 32000})
        self.requests.append(request)
        if request.method == "GET" and request.url.path == "/v1/reporting/balances":
            if isinstance(self.balance, int):
                return httpx.Response(self.balance, json={"name": "SERVICE_UNAVAILABLE"})
            money = {"currency_code": "USD", "value": self.balance}
            return httpx.Response(200, json={"balances": [{"currency": "USD", "available_balance": money}]})
        body = json.loads(request.content) if request.content else {}
        if request.method == "POST" and request.url.path == payouts.PAYOUTS_PATH:
            if self.create_status != 201:
                return httpx.Response(self.create_status, json={"name": "VALIDATION_ERROR"})
            self.batches += 1
            sender_batch_id = body["sender_batch_header"]["sender_batch_id"]
            return httpx.Response(
                201,
                json={"batch_header": {"payout_batch_id": f"BATCH{self.batches}", "sender_batch_header": {"sender_batch_id": sender_batch_id}}},
            )
        if request.method == "POST" and request.url.path == "/v2/checkout/orders":
            return httpx.Response(201, json={"id": "5O190127TN364715T", "status": "COMPLETED"})
        if request.method == "POST" and request.url.path.startswith(payouts.PAYOUT_ITEM_PATH) and request.url.path.endswith("/cancel"):
            if self.cancel_status != 200:
                return httpx.Response(self.cancel_status, json={"name": "INTERNAL_SERVER_ERROR"})
            return httpx.Response(200, json={"payout_item_id": request.url.path.split("/")[-2], "transaction_status": "RETURNED"})
        return httpx.Response(404, json={"name": "RESOURCE_NOT_FOUND"})

    def money_requests(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.method == "POST"]


@pytest.fixture(scope="module")
def server_url() -> Iterator[str]:
    server = pgserver.get_server(PGDATA)
    yield server.get_uri()


@pytest.fixture
def schema(server_url: str) -> Iterator[str]:
    name = "m7a_tasks_" + uuid.uuid4().hex[:12]
    with psycopg.connect(server_url, autocommit=True) as admin:
        admin.execute(sql.SQL("create schema {}").format(sql.Identifier(name)))
        try:
            yield name
        finally:
            admin.execute(sql.SQL("drop schema {} cascade").format(sql.Identifier(name)))


@pytest.fixture
def conn(server_url: str, schema: str) -> Iterator[psycopg.Connection]:
    with psycopg.connect(server_url, autocommit=True) as connection:
        connection.execute(sql.SQL("set search_path to {}").format(sql.Identifier(schema)))
        apply_schema(connection)
        yield connection


@pytest.fixture
def paypal(monkeypatch: pytest.MonkeyPatch, server_url: str, schema: str, conn: psycopg.Connection) -> FakePayPal:
    """Points every task at this test's schema and at a fake PayPal."""
    parts = urlsplit(server_url)
    query = urlencode([*parse_qsl(parts.query), ("options", f"-c search_path={schema}")], quote_via=quote)
    config = Config(
        paypal_client_id="cid",
        paypal_client_secret=SECRET,
        paypal_api_host=SANDBOX_API_HOST,
        database_url=urlunsplit(parts._replace(query=query)),
        dev=True,
        test_receiver=None,
        item_cap_minor=1000,
        campaign_cap_minor=10000,
        daily_cap_minor=20000,
    )
    fake = FakePayPal()
    monkeypatch.setattr(tasks, "_load_config", lambda: config)
    monkeypatch.setattr(tasks, "_paypal", lambda cfg: PayPalHttp(cfg, transport=httpx.MockTransport(fake)))
    monkeypatch.setattr(payouts, "_sleep", lambda _seconds: None)
    return fake


def seed_shop(conn: psycopg.Connection) -> None:
    """200 customers whose purchase days follow a BG/NBD-like process; every quiet regular joins."""
    days_rng = random.Random(0)
    customers, orders, quiet = [], [], []
    for i in range(200):
        ref = f"C{1000 + i}"
        day = FIRST_DAY + timedelta(days=days_rng.randrange(0, 400))
        rate, drop = days_rng.gammavariate(0.9, 1 / 25), days_rng.betavariate(1.0, 5.0)
        days = {day}
        while days_rng.random() >= drop:
            day += timedelta(days=1 + int(days_rng.expovariate(rate)))
            if day > AS_OF:
                break
            days.add(day)
        customers.append((ref, "Maya R.", ref.lower() + "@shop.example", "UK"))
        for n, when in enumerate(sorted(days)):
            orders.append((f"{ref}-{n}", ref, datetime.combine(when, time(12), tzinfo=timezone.utc), 900))
        if len(days) >= 3 and (AS_OF - max(days)).days >= 60:
            quiet.append(ref)
    with conn.cursor() as cur:
        cur.executemany("insert into shop_customers values (%s, %s, %s, %s)", customers)
        cur.executemany("insert into shop_orders values (%s, %s, %s, %s, 'USD')", orders)
    for ref in quiet:
        join_member(
            conn, paypal_email=ref.lower() + "@shop.example", paypal_payer_id=None, email_verified=True,
            shop_name=DEMO_SHOP_NAME, client_id="cid",
        )


def actor(conn: psycopg.Connection, role: str, *, idle: bool = False, expired: bool = False) -> dict:
    session = hashlib.sha256(secrets.token_bytes(32)).hexdigest()
    conn.execute(
        "insert into sessions (session_id, role, last_seen_at, expires_at) values (%s, %s, %s, %s)",
        (
            session,
            role,
            datetime.now(timezone.utc) - (timedelta(hours=2, minutes=1) if idle else timedelta()),
            datetime.now(timezone.utc) + (timedelta(minutes=-1) if expired else timedelta(hours=24)),
        ),
    )
    return {"role": role, "session": session}


def demo_spend(conn: psycopg.Connection, cents: int) -> str:
    """A demo-created campaign that reached submitting just now, carrying cents in 10-cent items R1... Returns its sender_batch_id."""
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 1000, 10, 0.5, 'submitted') returning campaign_id"
    ).fetchone()[0]
    items = tuple(PayoutItemSpec(f"x{n}@shop.example", 10, "Thanks", f"R{n}") for n in range(1, cents // 10 + 1))
    snap = BatchSnapshot(str(campaign_id), "USD", "A thank-you", items)
    conn.execute("insert into approved_snapshots values (%s, %s, %s, now(), 'owner')", (campaign_id, snapshot_hash(snap), canonical_json(snap)))
    conn.execute(
        "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, status) values (%s, %s, %s, 'created')",
        (sender_batch_id_for(snap), str(campaign_id), snapshot_hash(snap)),
    )
    conn.execute("insert into campaign_owners values (%s, 'demo', %s)", (campaign_id, "e" * 64))
    return sender_batch_id_for(snap)


def counts(conn: psycopg.Connection) -> tuple:
    return conn.execute("select (select count(*) from campaigns), (select count(*) from campaign_owners)").fetchone()


def refused(result: dict, code: str) -> bool:
    return set(result) == {"ok", "error", "ref"} and result["ok"] is False and result["error"] == code and bool(REF_SHAPE.fullmatch(result["ref"]))


def test_a_demo_draft_stays_under_demo_caps_and_is_recorded_against_its_session(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    seed_shop(conn)
    demo = actor(conn, "demo")

    result = tasks.draft_campaign(DEMO_SETTINGS, demo)

    assert result["ok"] is True and result["total_minor"] <= 1000 and result["rewarded"] == 5
    campaign_id = uuid.UUID(result["campaign_id"])
    amounts = [r[0] for r in conn.execute("select amount_minor from campaign_members where campaign_id = %s and role = 'reward'", (campaign_id,))]
    assert amounts and all(a <= 200 for a in amounts) and sum(amounts) == result["total_minor"]
    assert conn.execute("select role, session_id from campaign_owners where campaign_id = %s", (campaign_id,)).fetchone() == (
        "demo", demo["session"],
    )
    owner = actor(conn, "owner")
    big = tasks.draft_campaign({**DEMO_SETTINGS, "budget_minor": 2000, "per_recipient_minor": 300}, owner)
    assert big["ok"] is True and big["total_minor"] > 1000
    assert conn.execute("select role from campaign_owners where campaign_id = %s", (uuid.UUID(big["campaign_id"]),)).fetchone() == ("owner",)


@pytest.mark.parametrize(
    ("changes", "code"),
    [({"budget_minor": 1001}, "budget_over_cap"), ({"per_recipient_minor": 201}, "per_recipient_over_cap")],
)
def test_a_demo_draft_over_the_demo_caps_is_refused_and_stores_nothing(
    conn: psycopg.Connection, paypal: FakePayPal, changes: dict, code: str
) -> None:
    seed_shop(conn)
    assert refused(tasks.draft_campaign({**DEMO_SETTINGS, **changes}, actor(conn, "demo")), code)
    assert counts(conn) == (0, 0)
    assert tasks.draft_campaign({**DEMO_SETTINGS, **changes}, actor(conn, "owner"))["ok"] is True


def test_a_demo_session_may_draft_five_campaigns_a_day(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    seed_shop(conn)
    demo = actor(conn, "demo")
    assert all(tasks.draft_campaign(DEMO_SETTINGS, demo)["ok"] for _ in range(5))
    assert refused(tasks.draft_campaign(DEMO_SETTINGS, demo), "limit_reached")
    assert counts(conn) == (5, 5)
    assert tasks.draft_campaign(DEMO_SETTINGS, actor(conn, "demo"))["ok"] is True


def test_a_demo_draft_may_consider_at_most_20_candidates_and_is_refused_before_scoring(
    conn: psycopg.Connection, paypal: FakePayPal, monkeypatch: pytest.MonkeyPatch
) -> None:
    seed_shop(conn)
    demo = actor(conn, "demo")
    built: list[int] = []
    real_build_draft = tasks.build_draft

    def counted(*args: object, **kwargs: object) -> object:
        built.append(1)
        return real_build_draft(*args, **kwargs)

    monkeypatch.setattr(tasks, "build_draft", counted)

    assert refused(tasks.draft_campaign({**DEMO_SETTINGS, "max_candidates": 21}, demo), "over_cap")
    assert built == [] and counts(conn) == (0, 0)
    assert tasks.draft_campaign({**DEMO_SETTINGS, "max_candidates": 20}, demo)["ok"] is True
    owner = actor(conn, "owner")
    assert tasks.draft_campaign({**DEMO_SETTINGS, "max_candidates": 21}, owner)["ok"] is True
    assert refused(tasks.draft_campaign({**DEMO_SETTINGS, "max_candidates": 251}, owner), "invalid_settings")


def test_the_demo_pool_of_5000_cents_a_day_is_shared_by_every_demo_session(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    seed_shop(conn)
    demo_spend(conn, 4950)
    before = counts(conn)
    assert tasks.demo_spent_last_24h_minor(conn) == 4950
    assert refused(tasks.draft_campaign(DEMO_SETTINGS, actor(conn, "demo")), "over_demo_daily_cap")
    assert counts(conn) == before
    assert tasks.draft_campaign({**DEMO_SETTINGS, "budget_minor": 50}, actor(conn, "demo"))["ok"] is True
    assert tasks.draft_campaign(DEMO_SETTINGS, actor(conn, "owner"))["ok"] is True


def test_returned_demo_items_free_the_demo_pool_and_items_with_no_status_still_count(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    seed_shop(conn)
    sender_batch_id = demo_spend(conn, 4950)
    assert refused(tasks.draft_campaign(DEMO_SETTINGS, actor(conn, "demo")), "over_demo_daily_cap")
    # 100 ten-cent items came back and three more never left or were refunded; one waits unclaimed.
    marks = [(f"R{n}", "RETURNED") for n in range(1, 101)] + [("R101", "FAILED"), ("R102", "BLOCKED"), ("R103", "REFUNDED"), ("R104", "UNCLAIMED")]
    with conn.cursor() as cur:
        cur.executemany(
            "insert into payout_items (payout_item_id, sender_batch_id, sender_item_id, status) values (%s, %s, %s, %s)",
            [("ITEM" + ref, sender_batch_id, ref, status) for ref, status in marks],
        )
    assert tasks.demo_spent_last_24h_minor(conn) == 4950 - 1000 - 30
    assert tasks.draft_campaign(DEMO_SETTINGS, actor(conn, "demo"))["ok"] is True


def test_another_demo_session_gets_not_found_for_everything_on_a_campaign_it_did_not_create(
    conn: psycopg.Connection, paypal: FakePayPal
) -> None:
    seed_shop(conn)
    first, second = actor(conn, "demo"), actor(conn, "demo")
    campaign_id = tasks.draft_campaign(DEMO_SETTINGS, first)["campaign_id"]
    shown = tasks.view_campaign(campaign_id, first)["review_hash"]
    missing = str(uuid.uuid4())

    for target in (campaign_id, missing):
        attempts = [
            tasks.view_campaign(target, second),
            tasks.approve_campaign(target, second, shown),
            tasks.submit_campaign(target, second),
            tasks.simulate_return(target, "R1", second),
            tasks.results(target, second),
        ]
        assert all(refused(attempt, "not_found") for attempt in attempts)
    assert conn.execute("select status from campaigns where campaign_id = %s", (uuid.UUID(campaign_id),)).fetchone() == ("draft",)
    assert conn.execute("select count(*) from approved_snapshots").fetchone() == (0,)
    assert paypal.requests == []
    assert tasks.view_campaign(campaign_id, actor(conn, "owner"))["ok"] is True


def test_the_database_refuses_to_move_or_remove_a_campaigns_owner(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    seed_shop(conn)
    first, second = actor(conn, "demo"), actor(conn, "demo")
    campaign_id = uuid.UUID(tasks.draft_campaign(DEMO_SETTINGS, first)["campaign_id"])

    for statement, args in (
        ("update campaign_owners set session_id = %s where campaign_id = %s", (second["session"], campaign_id)),
        ("update campaign_owners set role = 'owner' where campaign_id = %s", (campaign_id,)),
        ("delete from campaign_owners where campaign_id = %s", (campaign_id,)),
    ):
        with pytest.raises(psycopg.errors.RaiseException, match="campaign_owners: .* refused"):
            conn.execute(statement, args)
    assert conn.execute("select role, session_id from campaign_owners").fetchall() == [("demo", first["session"])]
    assert refused(tasks.view_campaign(str(campaign_id), second), "not_found")


def test_a_demo_actor_approves_and_submits_under_demo_caps(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    seed_shop(conn)
    demo = actor(conn, "demo")
    campaign_id = tasks.draft_campaign(DEMO_SETTINGS, demo)["campaign_id"]
    view = tasks.view_campaign(campaign_id, demo)
    assert view["ok"] and view["status"] == "draft" and len(view["rows"]) == 10
    assert all(set(row) == {"ref", "role", "rank", "amount_minor", "note"} for row in view["rows"])
    assert "@" not in json.dumps(view["rows"])

    approval = tasks.approve_campaign(campaign_id, demo, view["review_hash"])
    assert approval["ok"] and approval["snapshot_hash"] == view["review_hash"]
    approved_by = conn.execute("select approved_by from approved_snapshots").fetchone()[0]
    assert re.fullmatch(r"demo:[0-9a-f]{16}", approved_by) and approved_by[5:] not in demo["session"]

    sent = tasks.submit_campaign(campaign_id, demo)
    assert (sent["ok"], sent["status"], sent["sent"], sent["payout_batch_id"]) == (True, "submitted", True, "BATCH1")
    [post] = paypal.money_requests()
    assert all(item["amount"]["value"] == "2.00" for item in json.loads(post.content)["items"])
    again = tasks.submit_campaign(campaign_id, demo)
    assert (again["ok"], again["sent"], len(paypal.money_requests())) == (True, False, 1)


def test_a_demo_submit_that_would_pass_the_demo_pool_is_refused(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    seed_shop(conn)
    demo = actor(conn, "demo")
    campaign_id = tasks.draft_campaign(DEMO_SETTINGS, demo)["campaign_id"]
    assert tasks.approve_campaign(campaign_id, demo, tasks.view_campaign(campaign_id, demo)["review_hash"])["ok"]
    demo_spend(conn, 4950)

    assert refused(tasks.submit_campaign(campaign_id, demo), "over_demo_daily_cap")
    assert paypal.money_requests() == []
    assert conn.execute("select status from campaigns where campaign_id = %s", (uuid.UUID(campaign_id),)).fetchone() == ("approved",)


def approved_campaign(sender: dict) -> str:
    campaign_id = tasks.draft_campaign(DEMO_SETTINGS, sender)["campaign_id"]
    assert tasks.approve_campaign(campaign_id, sender, tasks.view_campaign(campaign_id, sender)["review_hash"])["ok"] is True
    return campaign_id


def test_a_demo_session_may_send_two_campaigns_a_day_while_other_sessions_and_the_owner_still_can(
    conn: psycopg.Connection, paypal: FakePayPal
) -> None:
    seed_shop(conn)
    demo = actor(conn, "demo")
    first, second, third = (approved_campaign(demo) for _ in range(3))
    assert [tasks.submit_campaign(cid, demo)["sent"] for cid in (first, second)] == [True, True]

    assert refused(tasks.submit_campaign(third, demo), "limit_reached")
    assert len(paypal.money_requests()) == 2 and campaign_status(conn, third) == "approved"
    assert conn.execute("select count(*) from payout_batches where campaign_id = %s", (third,)).fetchone() == (0,)
    # Asking again about a campaign already sent can never send a second batch, so the limit lets it answer.
    again = tasks.submit_campaign(first, demo)
    assert (again["ok"], again["sent"], len(paypal.money_requests())) == (True, False, 2)

    other = actor(conn, "demo")
    assert tasks.submit_campaign(approved_campaign(other), other)["sent"] is True
    owner = actor(conn, "owner")
    assert [tasks.submit_campaign(approved_campaign(owner), owner)["sent"] for _ in range(3)] == [True, True, True]
    assert len(paypal.money_requests()) == 6


def test_campaigns_paypal_refused_and_voided_use_none_of_a_demo_sessions_sends_or_the_demo_pool(
    conn: psycopg.Connection, paypal: FakePayPal
) -> None:
    seed_shop(conn)
    demo = actor(conn, "demo")
    first, second, third = (approved_campaign(demo) for _ in range(3))
    paypal.create_status = 422
    assert [tasks.submit_campaign(cid, demo)["status"] for cid in (first, second)] == ["voided", "voided"]
    assert conn.execute("select count(*) from payout_batches").fetchone() == (2,)

    assert tasks.demo_spent_last_24h_minor(conn) == 0
    paypal.create_status = 201
    assert tasks.submit_campaign(third, demo)["sent"] is True
    assert tasks.demo_spent_last_24h_minor(conn) == 1000


def test_one_address_at_its_demo_send_limit_cannot_take_the_whole_demo_pool() -> None:
    # 4 is the website's per-address demo_submits_address limit (LIMITS in
    # packages/web/src/server/ratelimit.ts): one address sending that many campaigns at the
    # demo campaign cap must still leave part of the shared pool for every other visitor.
    assert 4 * tasks.DEMO_CAMPAIGN_CAP_MINOR < tasks.DEMO_DAILY_CAP_MINOR


@pytest.fixture
def spend_lock_held(server_url: str) -> Iterator[psycopg.Connection]:
    """Another connection holding the demo spend lock, let go after 20 real seconds at the latest.

    Without the deadline, a submit that waits on the lock with no limit would hang the
    suite instead of failing.
    """
    holder = psycopg.connect(server_url, autocommit=True)
    holder.execute("select pg_advisory_lock(%s)", (tasks.DEMO_SPEND_LOCK,))
    deadline = threading.Timer(20, holder.close)
    deadline.start()
    try:
        yield holder
    finally:
        deadline.cancel()
        holder.close()


def fake_wait(monkeypatch: pytest.MonkeyPatch, on_sleep: object = None) -> list[float]:
    """Replaces the spend lock's clock and pause with ones that take no real time. Returns the pauses taken."""
    slept: list[float] = []

    def sleep(seconds: float) -> None:
        slept.append(seconds)
        if callable(on_sleep):
            on_sleep(len(slept))

    monkeypatch.setattr(tasks, "_sleep", sleep, raising=False)
    monkeypatch.setattr(tasks, "_monotonic", lambda: sum(slept), raising=False)
    return slept


def test_a_demo_submit_that_cannot_take_the_spend_lock_within_10_seconds_answers_busy_and_sends_nothing(
    conn: psycopg.Connection, paypal: FakePayPal, spend_lock_held: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    seed_shop(conn)
    demo = actor(conn, "demo")
    campaign_id = approved_campaign(demo)
    slept = fake_wait(monkeypatch)

    assert refused(tasks.submit_campaign(campaign_id, demo), "busy")
    assert math.isclose(sum(slept), 10) and len(slept) > 1
    assert paypal.requests == [] and campaign_status(conn, campaign_id) == "approved"


def test_a_demo_submit_waits_for_the_spend_lock_and_sends_once_it_is_free(
    conn: psycopg.Connection, paypal: FakePayPal, spend_lock_held: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    seed_shop(conn)
    demo = actor(conn, "demo")
    campaign_id = approved_campaign(demo)
    slept = fake_wait(monkeypatch, lambda pauses: pauses == 3 and spend_lock_held.close())

    assert tasks.submit_campaign(campaign_id, demo)["sent"] is True
    assert len(slept) == 3 and len(paypal.money_requests()) == 1


def test_submit_campaign_refuses_a_low_or_unreadable_balance_and_the_campaign_stays_approved(
    conn: psycopg.Connection, paypal: FakePayPal
) -> None:
    seed_shop(conn)
    owner = actor(conn, "owner")
    campaign_id = approved_campaign(owner)

    for balance, code in (("250.00", "low_balance"), (503, "balance_unavailable")):
        paypal.balance = balance
        assert refused(tasks.submit_campaign(campaign_id, owner), code)
        assert paypal.money_requests() == [] and campaign_status(conn, campaign_id) == "approved"
    assert conn.execute("select count(*) from payout_batches").fetchone() == (0,)

    paypal.balance = "5033.32"
    assert tasks.submit_campaign(campaign_id, owner)["sent"] is True


def test_every_limit_refusal_writes_one_limit_hit_row_with_only_the_task_the_code_and_the_role(
    conn: psycopg.Connection, paypal: FakePayPal
) -> None:
    seed_shop(conn)
    demo = actor(conn, "demo")
    assert refused(tasks.draft_campaign({**DEMO_SETTINGS, "max_candidates": 21}, demo), "over_cap")
    assert all(tasks.draft_campaign(DEMO_SETTINGS, demo)["ok"] for _ in range(5))
    assert refused(tasks.draft_campaign(DEMO_SETTINGS, demo), "limit_reached")
    demo_spend(conn, 4950)
    assert refused(tasks.draft_campaign(DEMO_SETTINGS, actor(conn, "demo")), "over_demo_daily_cap")
    owner = actor(conn, "owner")
    campaign_id = approved_campaign(owner)
    paypal.balance = "250.00"
    assert refused(tasks.submit_campaign(campaign_id, owner), "low_balance")
    paypal.balance = "5033.32"
    assert tasks.submit_campaign(campaign_id, owner)["sent"] is True
    for _ in range(10):
        conn.execute("insert into simulated_orders (simulated_order_id, campaign_id, ref) values (%s, %s, 'R1')", (uuid.uuid4(), uuid.UUID(campaign_id)))
    assert refused(tasks.simulate_return(campaign_id, "R1", owner), "limit_reached")
    # Refusals with any other code write none.
    assert refused(tasks.draft_campaign({**DEMO_SETTINGS, "budget_minor": 1001}, actor(conn, "demo")), "budget_over_cap")
    assert refused(tasks.view_campaign("not-a-uuid", demo), "invalid_input")

    rows = conn.execute("select actor, detail from audit_log where action = 'limit_hit' order by id").fetchall()
    assert rows == [
        ("engine", {"task": "draft_campaign", "code": "over_cap", "role": "demo"}),
        ("engine", {"task": "draft_campaign", "code": "limit_reached", "role": "demo"}),
        ("engine", {"task": "draft_campaign", "code": "over_demo_daily_cap", "role": "demo"}),
        ("engine", {"task": "submit_campaign", "code": "low_balance", "role": "owner"}),
        ("engine", {"task": "simulate_return", "code": "limit_reached", "role": "owner"}),
    ]


def test_simulate_and_results_return_json_safe_answers(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    seed_shop(conn)
    owner = actor(conn, "owner")
    campaign_id = tasks.draft_campaign(DEMO_SETTINGS, owner)["campaign_id"]
    assert tasks.approve_campaign(campaign_id, owner, tasks.view_campaign(campaign_id, owner)["review_hash"])["ok"]
    assert tasks.submit_campaign(campaign_id, owner)["sent"] is True

    order = tasks.simulate_return(campaign_id, "R1", owner)
    found = tasks.results(campaign_id, owner)

    assert order == {"ok": True, "campaign_id": campaign_id, "ref": "R1", "paypal_order_id": "5O190127TN364715T", "paypal_status": "COMPLETED"}
    assert found["ok"] and found["status"] == "submitted" and found["verdict"] == "too early to tell"
    assert found["rewarded"]["members"] + found["holdout"]["members"] == 10
    # Sent, and PayPal has reported on no item yet: all five wait as PENDING.
    assert found["payouts"] == {
        "items": 5, "by_status": {"PENDING": 5}, "claimed_minor": 0, "unclaimed_minor": 0, "returned_minor": 0,
        "failed_minor": 0, "pending_minor": 1000, "unclaimed_return_by": None,
    }
    json.dumps(found, allow_nan=False)


def sent_with_items(conn: psycopg.Connection, sender: dict) -> tuple[str, int]:
    """A campaign sender drafted, approved and sent: its first item waits unclaimed, its second was claimed.

    Returns the campaign id and the first item's approved amount.
    """
    campaign_id = tasks.draft_campaign(DEMO_SETTINGS, sender)["campaign_id"]
    assert tasks.approve_campaign(campaign_id, sender, tasks.view_campaign(campaign_id, sender)["review_hash"])["ok"]
    assert tasks.submit_campaign(campaign_id, sender)["sent"] is True
    sender_batch_id = conn.execute("select sender_batch_id from payout_batches where campaign_id = %s", (campaign_id,)).fetchone()[0]
    snapshot = conn.execute("select canonical_json from approved_snapshots where campaign_id = %s", (uuid.UUID(campaign_id),)).fetchone()[0]
    items = json.loads(snapshot)["items"]
    for n, (item, status) in enumerate(zip(items, ("UNCLAIMED", "SUCCESS")), start=1):
        conn.execute(
            "insert into payout_items (payout_item_id, sender_batch_id, sender_item_id, status) values (%s, %s, %s, %s)",
            (f"ITEM{n}", sender_batch_id, item["sender_item_id"], status),
        )
    return campaign_id, items[0]["amount_minor"]


def cancels(paypal: FakePayPal) -> list[str]:
    return [r.url.path for r in paypal.requests if r.url.path.endswith("/cancel")]


def test_cancel_unclaimed_refuses_a_campaign_with_no_payout_batch(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    seed_shop(conn)
    owner = actor(conn, "owner")
    campaign_id = tasks.draft_campaign(DEMO_SETTINGS, owner)["campaign_id"]
    assert refused(tasks.cancel_unclaimed(campaign_id, owner), "not_submitted")
    assert paypal.requests == []


def test_cancel_unclaimed_works_for_its_creator_and_the_owner_and_is_not_found_for_another_demo_session(
    conn: psycopg.Connection, paypal: FakePayPal
) -> None:
    seed_shop(conn)
    creator = actor(conn, "demo")
    campaign_id, first_amount = sent_with_items(conn, creator)

    assert refused(tasks.cancel_unclaimed(campaign_id, actor(conn, "demo")), "not_found")
    assert refused(tasks.cancel_unclaimed(str(uuid.uuid4()), creator), "not_found")
    assert cancels(paypal) == []

    assert tasks.cancel_unclaimed(campaign_id, creator) == {
        "ok": True, "campaign_id": campaign_id, "cancelled": 1, "returned_minor": first_amount, "still_unclaimed": 0, "not_cancellable": 0,
    }
    assert cancels(paypal) == ["/v1/payments/payouts-item/ITEM1/cancel"]
    assert tasks.cancel_unclaimed(campaign_id, actor(conn, "owner")) == {
        "ok": True, "campaign_id": campaign_id, "cancelled": 0, "returned_minor": 0, "still_unclaimed": 0, "not_cancellable": 0,
    }
    assert len(cancels(paypal)) == 1 and "cancel_unclaimed" in tasks.TASK_NAMES


def test_cancel_unclaimed_fails_as_paypal_unavailable_when_paypal_errors(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    seed_shop(conn)
    owner = actor(conn, "owner")
    campaign_id, _ = sent_with_items(conn, owner)
    paypal.cancel_status = 503
    assert refused(tasks.cancel_unclaimed(campaign_id, owner), "paypal_unavailable")
    assert conn.execute("select status from payout_items where payout_item_id = 'ITEM1'").fetchone() == ("UNCLAIMED",)


def test_the_scheduled_tasks_run_with_no_actor(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    assert tasks.process_events() == {"ok": True, "ran": True, "outcomes": {}, "retrying": 0}
    assert tasks.reconcile() == {"ok": True, "ran": True, "looked_at": 0, "sent": 0, "waiting": 0}
    assert tasks.purge() == {"ok": True, "deleted": 0}
    assert paypal.requests == []


def test_six_tasks_started_at_the_same_moment_all_succeed(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    # Each task opens its own connection and so applies the schema; at once, those can deadlock.
    gate = threading.Barrier(6)
    answers: list[dict] = []

    def run() -> None:
        gate.wait()
        answers.append(tasks.purge())

    workers = [threading.Thread(target=run) for _ in range(6)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=60)
    assert answers == [{"ok": True, "deleted": 0}] * 6


def test_an_unexpected_failure_returns_only_a_code_and_a_ref(
    conn: psycopg.Connection, paypal: FakePayPal, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    seed_shop(conn)
    demo = actor(conn, "demo")

    def broken(*_args: object, **_kwargs: object) -> None:
        raise psycopg.errors.UndefinedColumn(f'column "x" does not exist in select * from campaigns where secret = {SECRET}')

    monkeypatch.setattr(tasks, "build_draft", broken)
    result = tasks.draft_campaign(DEMO_SETTINGS, demo)

    assert refused(result, "internal")
    logged = [json.loads(line) for line in capsys.readouterr().err.splitlines() if line.startswith("{")]
    [entry] = [line for line in logged if line.get("ref") == result["ref"]]
    assert entry["exception"] == "UndefinedColumn" and "does not exist" in entry["detail"] and "Traceback" in entry["trace"]
    assert SECRET not in json.dumps(logged) and demo["session"] not in json.dumps(logged)
    assert counts(conn) == (0, 0)


@pytest.mark.parametrize(
    ("make_actor", "code"),
    [
        (lambda c: None, "invalid_actor"),
        (lambda c: {"role": "admin", "session": "a" * 64}, "invalid_actor"),
        (lambda c: {**actor(c, "demo"), "extra": 1}, "invalid_actor"),
        (lambda c: {"role": "demo", "session": "A" * 64}, "invalid_actor"),
        (lambda c: {"role": "demo", "session": "a" * 64}, "forbidden"),
        (lambda c: actor(c, "demo", expired=True), "forbidden"),
        (lambda c: actor(c, "demo", idle=True), "forbidden"),
        (lambda c: {**actor(c, "demo"), "role": "owner"}, "forbidden"),
    ],
)
def test_an_actor_without_a_live_session_of_that_role_is_refused(
    conn: psycopg.Connection, paypal: FakePayPal, make_actor, code: str
) -> None:
    assert refused(tasks.draft_campaign(DEMO_SETTINGS, make_actor(conn)), code)
    assert refused(tasks.view_campaign(str(uuid.uuid4()), make_actor(conn)), code)
    assert counts(conn) == (0, 0)


@pytest.mark.parametrize(
    "settings",
    [
        {**DEMO_SETTINGS, "holdout_share": 0.5},
        {**DEMO_SETTINGS, "budget_minor": True},
        {**DEMO_SETTINGS, "as_of": "20261016"},
        {**DEMO_SETTINGS, "as_of": "2026-02-30"},
        {**DEMO_SETTINGS, "extra": "x"},
        {k: v for k, v in DEMO_SETTINGS.items() if k != "goal_text"},
        ["not", "a", "dict"],
    ],
)
def test_draft_settings_of_the_wrong_shape_are_refused(conn: psycopg.Connection, paypal: FakePayPal, settings: object) -> None:
    assert refused(tasks.draft_campaign(settings, actor(conn, "owner")), "invalid_input")


@pytest.mark.parametrize("campaign_id", ["not-a-uuid", str(uuid.uuid4()).upper(), 7, None])
def test_a_campaign_id_that_is_not_a_lowercase_uuid_is_refused(conn: psycopg.Connection, paypal: FakePayPal, campaign_id: object) -> None:
    assert refused(tasks.view_campaign(campaign_id, actor(conn, "owner")), "invalid_input")


# The UK clock as a POSIX rule: the local pgserver has no time zone database, and a
# rule worked out in SQL is a check made independently of the engine's zoneinfo.
LONDON_RULE = "GMT0BST,M3.5.0/1,M10.5.0"
QUIET_BY_SQL = """
    with days as (
        select customer_ref, (ordered_at at time zone '{zone}')::date as day from shop_orders where currency = 'USD'
    ), per as (
        select customer_ref, count(distinct day) as n, max(day) as last from days group by customer_ref
    )
    select customer_ref from per, (select max(day) as as_of from days) a where n >= 3 and a.as_of - last >= 60
""".replace("{zone}", LONDON_RULE)
PAID_12M_BY_SQL = """
    with quiet as ({quiet}), a as (select max((ordered_at at time zone '{zone}')::date) as as_of from shop_orders),
    paid as (
        select customer_ref, sum(total_minor) as total from shop_orders, a
        where (ordered_at at time zone '{zone}')::date > (a.as_of - interval '1 year')::date
          and (ordered_at at time zone '{zone}')::date <= a.as_of group by customer_ref
    ), refunded as (
        select customer_ref, sum(amount_minor) as total from shop_refunds, a
        where (refunded_at at time zone '{zone}')::date > (a.as_of - interval '1 year')::date
          and (refunded_at at time zone '{zone}')::date <= a.as_of group by customer_ref
    )
    select coalesce(sum(greatest(p.total - coalesce(r.total, 0), 0)), 0)
    from paid p join quiet q using (customer_ref) left join refunded r using (customer_ref)
""".replace("{zone}", LONDON_RULE)
BENCHMARK = {
    "source": "CDNOW sample, Fader, Hardie and Lee (2005)",
    "customers": 2357,
    "fitted": {"r": 0.2426, "alpha": 4.4136, "a": 0.7929, "b": 2.4259, "log_likelihood": -9582.43},
    "published": {"r": 0.243, "alpha": 4.414, "a": 0.793, "b": 2.426, "log_likelihood": -9582.4},
    "passed": True,
}
BACKTEST = {
    "source": "UCI Online Retail II (Chen 2012, CC BY 4.0)",
    "holdout_days": 91,
    "cutoffs": [
        {"cutoff": "2010-06-09", "customers": 2775, "converged": False, "auc_model": None, "auc_recency": 0.655},
        {"cutoff": "2011-09-09", "customers": 5256, "converged": True, "auc_model": 0.801, "auc_recency": 0.763},
    ],
    "converged": 1,
    "model_wins": 1,
    "mean_auc_gain": 0.038,
    "decile_cutoff": "2011-09-09",
    "deciles": [{"decile": n, "customers": 526, "returned_share": 1 - n / 10} for n in range(1, 11)],
    "passed": False,
}


def test_the_shop_summary_matches_a_direct_read_and_says_when_the_model_facts_are_missing(
    conn: psycopg.Connection, paypal: FakePayPal
) -> None:
    seed_shop(conn)
    quiet = [r[0] for r in conn.execute(QUIET_BY_SQL)]
    # One refund inside the year comes off, one larger than the year's purchases floors that customer at 0.
    conn.execute("insert into shop_refunds values ('X1', %s, '2026-09-01 12:00+00', 300), ('X2', %s, '2026-09-01 12:00+00', 999999)", (quiet[0], quiet[1]))

    summary = tasks.shop_summary()

    expected_paid = conn.execute(PAID_12M_BY_SQL.replace("{quiet}", QUIET_BY_SQL)).fetchone()[0]
    assert summary == {
        "ok": True,
        "as_of": conn.execute(f"select max((ordered_at at time zone '{LONDON_RULE}')::date)::text from shop_orders").fetchone()[0],
        "shop_customers": 200,
        "members": len(quiet),
        "quiet_regulars": len(quiet),
        "quiet_regulars_paid_12m_minor": int(expected_paid),
        "currency": "USD",
        "benchmark": None,
        "backtest": None,
    }
    assert 0 < summary["quiet_regulars_paid_12m_minor"] < 900 * 400
    assert "@" not in json.dumps(summary) and not REF_SHAPE.search(json.dumps(summary))


def test_the_shop_summary_returns_stored_facts_and_treats_a_malformed_one_as_missing(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    store_facts.store(conn, store_facts.CDNOW_KEY, BENCHMARK)
    conn.execute("insert into model_facts (key, value) values (%s, %s)", (store_facts.UCI_KEY, Jsonb({**BACKTEST, "note": "<script>"})))

    summary = tasks.shop_summary()

    assert summary["as_of"] is None and summary["quiet_regulars"] == 0
    assert {k: v for k, v in summary["benchmark"].items() if k != "computed_at"} == BENCHMARK
    assert datetime.fromisoformat(summary["benchmark"]["computed_at"]).tzinfo is not None
    assert summary["backtest"] is None
    store_facts.store(conn, store_facts.UCI_KEY, BACKTEST)
    assert tasks.shop_summary()["backtest"]["deciles"][9] == {"decile": 10, "customers": 526, "returned_share": 0.0}
    with pytest.raises(ValueError):
        store_facts.store(conn, store_facts.UCI_KEY, {**BACKTEST, "passed": "yes"})


def test_quiet_regulars_lists_the_most_at_risk_first_and_never_an_identifier(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    seed_shop(conn)
    quiet = [r[0] for r in conn.execute(QUIET_BY_SQL)]
    member_ids = [str(r[0]) for r in conn.execute("select member_id from members")]
    demo = actor(conn, "demo")

    found = tasks.quiet_regulars(demo, 50)

    assert found["ok"] and found["total"] == len(quiet) and len(quiet) > 50 and len(found["rows"]) == 50
    rows = found["rows"]
    assert [row["position"] for row in rows] == list(range(1, 51))
    assert all(set(row) == {"position", "display_name", "purchase_days", "days_silent", "score", "paid_net_minor", "member"} for row in rows)
    assert all(row["purchase_days"] >= 3 and row["days_silent"] >= 60 and row["paid_net_minor"] > 0 for row in rows)
    assert [row["score"] for row in rows] == sorted(row["score"] for row in rows)
    assert tasks.quiet_regulars(demo, 3)["rows"] == rows[:3]
    text = json.dumps(found)
    assert "@" not in text and not re.search(r"C1[0-9]{3}", text) and not any(m in text for m in member_ids)
    # Every quiet regular in the seed joined; with the members gone, none of them is one.
    assert all(row["member"] for row in rows)
    conn.execute("delete from members")
    assert not any(row["member"] for row in tasks.quiet_regulars(demo, 50)["rows"])


@pytest.mark.parametrize("limit", [0, 51, True, "5", 5.0, None])
def test_quiet_regulars_refuses_a_limit_outside_1_to_50(conn: psycopg.Connection, paypal: FakePayPal, limit: object) -> None:
    assert refused(tasks.quiet_regulars(actor(conn, "demo"), limit), "invalid_input")


def test_quiet_regulars_needs_a_live_session(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    assert refused(tasks.quiet_regulars({"role": "demo", "session": "a" * 64}, 10), "forbidden")
    assert refused(tasks.quiet_regulars(None, 10), "invalid_actor")


def first_rows(conn: psycopg.Connection, campaign_id: str) -> tuple[str, str]:
    """The first rewarded ref and the first held-back ref of a campaign."""
    reward, holdout = (
        conn.execute(
            "select ref from campaign_members where campaign_id = %s and role = %s order by rank limit 1", (uuid.UUID(campaign_id), role)
        ).fetchone()[0]
        for role in ("reward", "holdout")
    )
    return reward, holdout


def customer_behind(conn: psycopg.Connection, campaign_id: str, ref: str) -> str:
    email = conn.execute(
        "select m.paypal_email from campaign_members cm join members m using (member_id) where cm.campaign_id = %s and cm.ref = %s",
        (uuid.UUID(campaign_id), ref),
    ).fetchone()[0]
    return email.split("@")[0].upper()


def add_lines(conn: psycopg.Connection, customer: str, newest: list[str], oldest: list[str]) -> None:
    orders = [r[0] for r in conn.execute("select order_ref from shop_orders where customer_ref = %s order by ordered_at desc", (customer,))]
    for order_ref, names in ((orders[0], newest), (orders[-1], oldest)):
        start = conn.execute("select count(*) from shop_order_lines where order_ref = %s", (order_ref,)).fetchone()[0]
        for line_no, name in enumerate(names, start=start + 1):
            conn.execute("insert into shop_order_lines values (%s, %s, 'S1', %s, 1, 100)", (order_ref, line_no, name))


def stored_note(conn: psycopg.Connection, campaign_id: str, ref: str) -> str | None:
    return conn.execute("select note from campaign_members where campaign_id = %s and ref = %s", (uuid.UUID(campaign_id), ref)).fetchone()[0]


def campaign_status(conn: psycopg.Connection, campaign_id: str) -> str:
    return conn.execute("select status from campaigns where campaign_id = %s", (uuid.UUID(campaign_id),)).fetchone()[0]


def test_draft_limits_gives_each_role_its_caps_and_the_shops_day(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    assert tasks.draft_limits(actor(conn, "demo")) == {"ok": True, "as_of": None, "campaign_cap_minor": 1000, "item_cap_minor": 200}
    seed_shop(conn)
    day = conn.execute(f"select max((ordered_at at time zone '{LONDON_RULE}')::date)::text from shop_orders").fetchone()[0]

    assert tasks.draft_limits(actor(conn, "demo")) == {"ok": True, "as_of": day, "campaign_cap_minor": 1000, "item_cap_minor": 200}
    assert tasks.draft_limits(actor(conn, "owner")) == {"ok": True, "as_of": day, "campaign_cap_minor": 10000, "item_cap_minor": 1000}
    assert refused(tasks.draft_limits({"role": "demo", "session": "a" * 64}), "forbidden")
    assert refused(tasks.draft_limits(None), "invalid_actor")


def test_note_context_gives_one_rewarded_customers_own_items_and_recency_and_nothing_else(
    conn: psycopg.Connection, paypal: FakePayPal
) -> None:
    seed_shop(conn)
    demo = actor(conn, "demo")
    campaign_id = tasks.draft_campaign(DEMO_SETTINGS, demo)["campaign_id"]
    reward, holdout = first_rows(conn, campaign_id)
    customer, other = customer_behind(conn, campaign_id, reward), customer_behind(conn, campaign_id, holdout)
    add_lines(
        conn,
        customer,
        ["RED  TEAPOT", "Visit www.example.com", "PayPal gift card", "mail me@x.example", "Blue mug", "blue mug", "Order 12345678"],
        ["Old candle"],
    )
    add_lines(conn, other, ["SOMEONE ELSES VASE"], [])
    last_day = conn.execute("select max(ordered_at)::date from shop_orders where customer_ref = %s", (customer,)).fetchone()[0]

    found = tasks.note_context(campaign_id, reward, demo)

    assert set(found) == {"ok", "shop_name", "recent_items", "days_since_last_order"} and found["ok"] is True
    assert found["shop_name"] == DEMO_SHOP_NAME
    assert set(found["recent_items"][:2]) == {"red teapot", "blue mug"} and found["recent_items"][2:] == ["old candle"]
    assert found["days_since_last_order"] == (AS_OF - last_day).days >= 60
    text = json.dumps(found).lower()
    assert "@" not in text and customer.lower() not in text and "vase" not in text and "paypal" not in text and "www" not in text
    member_id = conn.execute(
        "select member_id::text from campaign_members where campaign_id = %s and ref = %s", (uuid.UUID(campaign_id), reward)
    ).fetchone()[0]
    assert member_id not in text

    owner = actor(conn, "owner")
    second = tasks.draft_campaign({**DEMO_SETTINGS, "holdout_share": "0.20"}, owner)["campaign_id"]
    for (ref,) in conn.execute("select ref from campaign_members where campaign_id = %s and role = 'reward'", (uuid.UUID(second),)).fetchall():
        add_lines(conn, customer_behind(conn, second, ref), [f"item {n}" for n in range(9)], [])
        assert len(tasks.note_context(second, ref, owner)["recent_items"]) == 5


def test_note_context_refuses_held_back_rows_other_sessions_and_campaigns_past_draft(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    seed_shop(conn)
    demo = actor(conn, "demo")
    campaign_id = tasks.draft_campaign(DEMO_SETTINGS, demo)["campaign_id"]
    reward, holdout = first_rows(conn, campaign_id)

    assert refused(tasks.note_context(campaign_id, holdout, demo), "holdout_ref")
    assert refused(tasks.note_context(campaign_id, "R999", demo), "unknown_ref")
    assert refused(tasks.note_context(campaign_id, "r1", demo), "invalid_input")
    assert refused(tasks.note_context(campaign_id, reward, actor(conn, "demo")), "not_found")
    assert tasks.request_approval(campaign_id, demo)["ok"] is True
    assert refused(tasks.note_context(campaign_id, reward, demo), "not_editable")


def test_set_note_writes_a_draft_note_or_the_template_and_refuses_the_rest(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    seed_shop(conn)
    demo = actor(conn, "demo")
    campaign_id = tasks.draft_campaign(DEMO_SETTINGS, demo)["campaign_id"]
    reward, holdout = first_rows(conn, campaign_id)
    note = "Thank you for the red teapot, we have missed you at the shop."

    assert tasks.set_note(campaign_id, reward, note, demo) == {"ok": True, "campaign_id": campaign_id, "ref": reward, "template": False}
    assert stored_note(conn, campaign_id, reward) == note
    for bad in ("PayPal is giving you this", "see http://x.example", "write to evil@example.com", "x" * 401):
        assert refused(tasks.set_note(campaign_id, reward, bad, demo), "note_rejected")
    assert stored_note(conn, campaign_id, reward) == note
    assert refused(tasks.set_note(campaign_id, holdout, note, demo), "holdout_ref")
    assert stored_note(conn, campaign_id, holdout) is None
    assert refused(tasks.set_note(campaign_id, reward, 5, demo), "invalid_input")
    assert refused(tasks.set_note(campaign_id, reward, note, actor(conn, "demo")), "not_found")

    assert tasks.set_note(campaign_id, reward, None, demo)["template"] is True
    assert stored_note(conn, campaign_id, reward) == NOTE_TEMPLATE.format(shop_name=DEMO_SHOP_NAME)


def test_set_note_never_touches_a_campaign_that_awaits_approval_or_was_approved(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    seed_shop(conn)
    demo = actor(conn, "demo")
    approved = tasks.draft_campaign(DEMO_SETTINGS, demo)["campaign_id"]
    waiting = tasks.draft_campaign(DEMO_SETTINGS, demo)["campaign_id"]
    assert tasks.approve_campaign(approved, demo, tasks.view_campaign(approved, demo)["review_hash"])["ok"] is True
    assert tasks.request_approval(waiting, demo)["ok"] is True
    before = {cid: stored_note(conn, cid, first_rows(conn, cid)[0]) for cid in (approved, waiting)}

    for cid in (approved, waiting):
        assert refused(tasks.set_note(cid, first_rows(conn, cid)[0], "Thanks again from the shop.", demo), "not_editable")
        assert stored_note(conn, cid, first_rows(conn, cid)[0]) == before[cid]
    assert (campaign_status(conn, approved), campaign_status(conn, waiting)) == ("approved", "awaiting_approval")
    assert conn.execute("select count(*) from approved_snapshots").fetchone() == (1,)


def test_request_approval_only_moves_a_draft_to_awaiting_approval(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    seed_shop(conn)
    demo = actor(conn, "demo")
    campaign_id = tasks.draft_campaign(DEMO_SETTINGS, demo)["campaign_id"]

    assert tasks.request_approval(campaign_id, demo) == {"ok": True, "campaign_id": campaign_id, "status": "awaiting_approval"}
    assert campaign_status(conn, campaign_id) == "awaiting_approval"
    assert conn.execute("select count(*) from approved_snapshots").fetchone() == (0,) and paypal.requests == []
    actor_id, detail = conn.execute("select actor, detail from audit_log where action = 'approval_requested'").fetchone()
    assert re.fullmatch(r"demo:[0-9a-f]{16}", actor_id) and detail == {"campaign_id": campaign_id}
    assert refused(tasks.request_approval(campaign_id, demo), "already_requested")
    assert refused(tasks.request_approval(campaign_id, actor(conn, "demo")), "not_found")

    # A person still approves it, and then asking again is refused.
    assert tasks.approve_campaign(campaign_id, demo, tasks.view_campaign(campaign_id, demo)["review_hash"])["ok"] is True
    assert refused(tasks.request_approval(campaign_id, demo), "not_open")
    assert conn.execute("select count(*) from audit_log where action = 'approval_requested'").fetchone() == (1,)


def test_forty_note_context_and_set_note_calls_at_once_on_one_campaign_all_succeed(conn: psycopg.Connection, paypal: FakePayPal) -> None:
    # While connect() re-applied schema.sql, its trigger rebuilds took ACCESS EXCLUSIVE
    # locks that deadlocked with these writes: 13 of 38 such calls failed at four at once.
    seed_shop(conn)
    owner = actor(conn, "owner")
    campaign_id = tasks.draft_campaign({**DEMO_SETTINGS, "max_candidates": 20}, owner)["campaign_id"]
    refs = [r[0] for r in conn.execute("select ref from campaign_members where campaign_id = %s and role = 'reward'", (uuid.UUID(campaign_id),))]
    calls = [(tasks.note_context, (campaign_id, ref, owner)) for ref in refs * 2] + [
        (tasks.set_note, (campaign_id, ref, f"Thank you for coming back, note {n}.", owner)) for n in (1, 2) for ref in refs
    ]
    assert len(calls) == 40
    gate = threading.Barrier(len(calls))
    answers: list[dict] = []

    def call(task, args: tuple) -> None:
        gate.wait()
        answers.append(task(*args))

    workers = [threading.Thread(target=call, args=pair) for pair in calls]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=120)

    assert len(answers) == 40 and all(answer["ok"] is True for answer in answers), [a for a in answers if not a["ok"]]
    notes = [r[0] for r in conn.execute("select note from campaign_members where campaign_id = %s and role = 'reward'", (uuid.UUID(campaign_id),))]
    assert all(note in ("Thank you for coming back, note 1.", "Thank you for coming back, note 2.") for note in notes)


def test_connect_refuses_a_database_without_the_schema_and_never_creates_it(server_url: str) -> None:
    name = "m6c_empty_" + uuid.uuid4().hex[:12]
    parts = urlsplit(server_url)
    url = urlunsplit(parts._replace(query=urlencode([*parse_qsl(parts.query), ("options", f"-c search_path={name}")], quote_via=quote)))
    config = Config(
        paypal_client_id="cid", paypal_client_secret=SECRET, paypal_api_host=SANDBOX_API_HOST, database_url=url, dev=True,
        test_receiver=None, item_cap_minor=1000, campaign_cap_minor=10000, daily_cap_minor=20000,
    )
    with psycopg.connect(server_url, autocommit=True) as admin:
        admin.execute(sql.SQL("create schema {}").format(sql.Identifier(name)))
        try:
            with pytest.raises(ConfigError, match=r"schema missing: run python -m mend_engine\.db\.migrate"):
                connect(config)
            objects = "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = %s"
            assert admin.execute(objects, (name,)).fetchone() == (0,)
            with psycopg.connect(url, autocommit=True) as migration:
                apply_schema(migration)
            with connect(config) as ready:
                assert ready.execute("select count(*) from campaigns").fetchone() == (0,)
        finally:
            admin.execute(sql.SQL("drop schema {} cascade").format(sql.Identifier(name)))
