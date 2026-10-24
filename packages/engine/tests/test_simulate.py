# Not covered here: PayPal really capturing the card order and sending the capture
# webhook (prove_m5 does both live), attribution of the purchase (test_events.py and
# test_attribution.py), and the web app's per-visitor limits on the button (C20).
import json
import uuid
from collections.abc import Iterator

import httpx
import pgserver
import psycopg
import pytest
from psycopg import sql

from mend_engine.campaigns.simulate import (
    AMOUNT_MINOR,
    MAX_PER_CAMPAIGN,
    ORDERS_PATH,
    OrderIdRefused,
    SimulateFailed,
    SimulateRefused,
    read_order,
    simulate_return,
)
from mend_engine.config import SANDBOX_API_HOST, Config
from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema
from mend_engine.paypal.http import PayPalError, PayPalHttp

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
SENT = ("approved", "submitting", "submitted")


@pytest.fixture(scope="module")
def server_url() -> Iterator[str]:
    server = pgserver.get_server(PGDATA)
    yield server.get_uri()


@pytest.fixture
def conn(server_url: str) -> Iterator[psycopg.Connection]:
    name = sql.Identifier("m5_sim_" + uuid.uuid4().hex[:12])
    with psycopg.connect(server_url, autocommit=True) as connection:
        connection.execute(sql.SQL("create schema {}").format(name))
        try:
            connection.execute(sql.SQL("set search_path to {}").format(name))
            apply_schema(connection)
            yield connection
        finally:
            connection.execute(sql.SQL("drop schema {} cascade").format(name))


def campaign(conn: psycopg.Connection, route: tuple[str, ...] = SENT) -> uuid.UUID:
    """A campaign with R1 rewarded, R2 held back and R3 a rewarded member who left, moved along route."""
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 1000, 100, 0.5, 'draft') returning campaign_id"
    ).fetchone()[0]
    for rank, role in ((1, "reward"), (2, "holdout"), (3, "reward")):
        member_id = conn.execute(
            "insert into members (paypal_email, email_verified, consent_version, consent_text_sha256, client_id) "
            "values (%s, true, 'v', 'h', 'cid') returning member_id",
            (f"m{rank}-{campaign_id}@shop.example",),
        ).fetchone()[0]
        conn.execute(
            "insert into campaign_members values (%s, %s, %s, %s, %s, 0.1, %s, %s)",
            (campaign_id, f"R{rank}", member_id, role, rank, 100 if role == "reward" else None,
             "Thanks" if role == "reward" else None),
        )
    for step in route:
        conn.execute("update campaigns set status = %s where campaign_id = %s", (step, campaign_id))
    if route[-1:] == ("submitted",):
        conn.execute(
            "update campaign_members set member_id = null where campaign_id = %s and ref = 'R3'", (campaign_id,)
        )
    return campaign_id


class FakeOrders:
    def __init__(self, answer=None) -> None:
        self.posts: list[httpx.Request] = []
        self.answer = answer or (lambda body: httpx.Response(201, json={"id": "5O190127TN364715T", "status": "COMPLETED"}))

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 32000})
        assert request.method == "POST" and request.url.path == ORDERS_PATH
        self.posts.append(request)
        return self.answer(json.loads(request.content))

    def http(self) -> PayPalHttp:
        return PayPalHttp(CONFIG, transport=httpx.MockTransport(self))


def rows(conn: psycopg.Connection, campaign_id: uuid.UUID) -> list[tuple]:
    return conn.execute(
        "select simulated_order_id, paypal_order_id, ref from simulated_orders where campaign_id = %s order by created_at",
        (campaign_id,),
    ).fetchall()


def test_a_member_of_a_sent_campaign_gets_one_card_order_for_the_fixed_amount(conn: psycopg.Connection) -> None:
    campaign_id = campaign(conn)
    paypal = FakeOrders()

    order = simulate_return(conn, paypal.http(), campaign_id, "R1")

    [request] = paypal.posts
    body = json.loads(request.content)
    unit = body["purchase_units"][0]
    assert body["intent"] == "CAPTURE" and body["payment_source"]["card"]["number"] == "4111111111111111"
    assert body["payment_source"]["card"]["expiry"] == "2030-12"
    assert unit["amount"] == {"currency_code": "USD", "value": "12.50"} and AMOUNT_MINOR == 1250
    assert unit["custom_id"] == str(order.simulated_order_id) == request.headers["PayPal-Request-Id"]
    assert unit["invoice_id"] == f"mend-sim-{order.simulated_order_id}"
    assert (order.paypal_order_id, order.paypal_status, order.ref) == ("5O190127TN364715T", "COMPLETED", "R1")
    assert rows(conn, campaign_id) == [(order.simulated_order_id, "5O190127TN364715T", "R1")]
    actions = [r[0] for r in conn.execute("select action from audit_log order by id")]
    assert actions == ["simulate_requested", "simulate_created"]


def test_a_held_back_member_can_buy_again_too_with_a_new_invoice_each_time(conn: psycopg.Connection) -> None:
    campaign_id = campaign(conn)
    ids = iter(["ORDERAAAA1", "ORDERAAAA2"])
    paypal = FakeOrders(lambda _b: httpx.Response(201, json={"id": next(ids), "status": "COMPLETED"}))
    first = simulate_return(conn, paypal.http(), campaign_id, "R2")
    second = simulate_return(conn, paypal.http(), campaign_id, "R2")
    invoices = {json.loads(p.content)["purchase_units"][0]["invoice_id"] for p in paypal.posts}
    assert len(invoices) == 2 and first.simulated_order_id != second.simulated_order_id
    assert conn.execute("select detail ->> 'role' from audit_log where action = 'simulate_requested'").fetchall() == [
        ("holdout",), ("holdout",),
    ]


@pytest.mark.parametrize(
    ("route", "ref", "reason"),
    [
        ((), "R1", "not_sent"),
        (("approved",), "R1", "not_sent"),
        (("approved", "submitting", "submission_unknown"), "R1", "not_sent"),
        (("voided",), "R1", "not_sent"),
        (SENT, "R9", "unknown_ref"),
        (SENT, "R3", "member_left"),
        (SENT, "x1", "invalid_input"),
        (SENT, "R1 ", "invalid_input"),
    ],
)
def test_only_a_member_of_a_sent_campaign_may_buy(conn: psycopg.Connection, route: tuple, ref: str, reason: str) -> None:
    campaign_id = campaign(conn, route)
    paypal = FakeOrders()
    with pytest.raises(SimulateRefused) as refused:
        simulate_return(conn, paypal.http(), campaign_id, ref)
    assert refused.value.reason == reason and paypal.posts == [] and rows(conn, campaign_id) == []


def test_unknown_and_completed_campaigns(conn: psycopg.Connection) -> None:
    paypal = FakeOrders()
    with pytest.raises(SimulateRefused, match="no such campaign"):
        simulate_return(conn, paypal.http(), uuid.uuid4(), "R1")
    completed = campaign(conn, (*SENT, "completed"))
    assert simulate_return(conn, paypal.http(), completed, "R1").ref == "R1"
    refusals = conn.execute("select detail ->> 'reason' from audit_log where action = 'simulate_refused'").fetchall()
    assert refusals == [("not_found",)]


def test_the_eleventh_purchase_for_a_campaign_is_refused_before_paypal_is_called(conn: psycopg.Connection) -> None:
    campaign_id = campaign(conn)
    counter = iter(range(100))
    paypal = FakeOrders(lambda _b: httpx.Response(201, json={"id": f"ORDER{next(counter):04d}", "status": "COMPLETED"}))
    for n in range(MAX_PER_CAMPAIGN):
        simulate_return(conn, paypal.http(), campaign_id, "R1" if n % 2 else "R2")
    with pytest.raises(SimulateRefused) as refused:
        simulate_return(conn, paypal.http(), campaign_id, "R1")
    assert refused.value.reason == "limit_reached" and len(paypal.posts) == MAX_PER_CAMPAIGN == 10
    other = campaign(conn)
    assert simulate_return(conn, paypal.http(), other, "R1").campaign_id == other


@pytest.mark.parametrize(
    "answer",
    [
        lambda _b: httpx.Response(422, json={"name": "UNPROCESSABLE_ENTITY", "debug_id": "d1"}),
        lambda _b: httpx.Response(201, json={"status": "COMPLETED"}),
        lambda _b: httpx.Response(201, json={"id": "../v1/oops", "status": "COMPLETED"}),
    ],
)
def test_a_paypal_failure_creates_no_order_id_and_still_uses_a_slot(conn: psycopg.Connection, answer) -> None:
    campaign_id = campaign(conn)
    with pytest.raises(SimulateFailed):
        simulate_return(conn, FakeOrders(answer).http(), campaign_id, "R1")
    [(_id, order_id, ref)] = rows(conn, campaign_id)
    assert (order_id, ref) == (None, "R1")
    assert conn.execute("select count(*) from audit_log where action = 'simulate_failed'").fetchone()[0] == 1


def test_a_timeout_is_a_failure_not_a_purchase(conn: psycopg.Connection) -> None:
    campaign_id = campaign(conn)

    def slow(_body: dict) -> httpx.Response:
        raise httpx.ReadTimeout("slow")

    with pytest.raises(SimulateFailed) as failed:
        simulate_return(conn, FakeOrders(slow).http(), campaign_id, "R1")
    assert failed.value.name == "TIMEOUT" and rows(conn, campaign_id)[0][1] is None


def test_reading_an_order_checks_its_id_before_sending() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 32000})
        seen.append(request.url.path)
        if request.url.path.endswith("/MISSING1"):
            return httpx.Response(404, json={"name": "RESOURCE_NOT_FOUND"})
        return httpx.Response(200, json={"id": "ORDER1", "status": "COMPLETED"})

    http = PayPalHttp(CONFIG, transport=httpx.MockTransport(handler))
    assert read_order(http, "ORDER1")["status"] == "COMPLETED"
    for bad in ("order1", "../x", "", "A" * 37, None):
        with pytest.raises(OrderIdRefused):
            read_order(http, bad)
    with pytest.raises(PayPalError) as error:
        read_order(http, "MISSING1")
    assert error.value.status == 404 and seen == [f"{ORDERS_PATH}/ORDER1", f"{ORDERS_PATH}/MISSING1"]
