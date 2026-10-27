# Not covered here: PayPal's real answer (scratchpad/balance_probe.py read it live once
# for R1b), how far PayPal's reporting balance really lags behind payouts (6 hours of
# Mend's own batches are taken off on top of it), and what a submission or a reconcile
# run does after a refusal (test_submission.py and test_reconcile.py cover those).
import uuid
from collections.abc import Iterator

import httpx
import pgserver
import psycopg
import pytest
from psycopg import sql

from mend_engine.config import SANDBOX_API_HOST, Config
from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema
from mend_engine.paypal import balances
from mend_engine.paypal.balances import BalanceTooLow, available_usd_minor, check_room
from mend_engine.paypal.http import PayPalError, PayPalHttp
from mend_engine.paypal.payouts import BatchSnapshot, PayoutItemSpec, canonical_json, sender_batch_id_for, snapshot_hash

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


def usd_entry(value: str = "5033.32", **changes: object) -> dict:
    # The live sandbox answer's fields (R1b step 1); the values here are made up.
    return {
        "currency": "USD",
        "total_balance": {"currency_code": "USD", "value": value},
        "available_balance": {"currency_code": "USD", "value": value},
        "withheld_balance": {"currency_code": "USD", "value": "0.00"},
        **changes,
    }


def answer(*entries: object) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "account_id": "ACCOUNT1",
            "as_of_time": "2026-10-26T12:00:00Z",
            "last_refresh_time": "2026-10-26T11:00:00Z",
            "balances": list(entries) if entries else [usd_entry()],
        },
    )


class Balances:
    """Answers the token call and plays back one answer, or raises it, for every balance read."""

    def __init__(self, reply: httpx.Response | Exception) -> None:
        self.reply = reply
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 32000})
        self.requests.append(request)
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


def http_for(fake: Balances) -> PayPalHttp:
    return PayPalHttp(CONFIG, transport=httpx.MockTransport(fake))


def batch(*amounts: int) -> BatchSnapshot:
    items = tuple(PayoutItemSpec(f"m{n}@shop.example", amount, "Thanks", f"R{n}") for n, amount in enumerate(amounts, start=1))
    return BatchSnapshot("camp-1", "USD", "A thank-you", items)


def test_the_available_usd_balance_is_read_in_cents_with_one_get() -> None:
    fake = Balances(answer(usd_entry(withheld_balance={"currency_code": "USD", "value": "10.00"}, total_balance={"currency_code": "USD", "value": "5043.32"})))
    assert available_usd_minor(http_for(fake)) == 503332
    [request] = fake.requests
    assert (request.method, request.url.host, request.url.path) == ("GET", SANDBOX_API_HOST, "/v1/reporting/balances")
    assert dict(request.url.params) == {"currency_code": "USD"}


@pytest.mark.parametrize(("value", "cents"), [("0.00", 0), ("0", 0), ("12.5", 1250), ("-3.10", -310), ("1000000.01", 100000001)])
def test_zero_whole_and_negative_balances_are_read_exactly(value: str, cents: int) -> None:
    assert available_usd_minor(http_for(Balances(answer(usd_entry(value))))) == cents


@pytest.mark.parametrize(
    "reply",
    [
        httpx.Response(403, json={"name": "NOT_AUTHORIZED", "debug_id": "d1"}),
        httpx.Response(200, json={}),
        httpx.Response(200, json={"balances": "USD"}),
        httpx.Response(200, json={"balances": []}),
        answer(usd_entry(), usd_entry()),
        answer(usd_entry(currency="GBP")),
        answer({k: v for k, v in usd_entry().items() if k != "available_balance"}),
        answer(usd_entry(available_balance={"currency_code": "EUR", "value": "5033.32"})),
        answer(usd_entry(available_balance={"currency_code": "USD", "value": 5033.32})),
        answer(usd_entry(available_balance="5033.32")),
        answer(usd_entry("5,033.32")),
        answer(usd_entry("5033.321")),
        answer(usd_entry(" 5033.32")),
        answer(usd_entry("1e3")),
        answer(usd_entry("+5")),
        answer(usd_entry("")),
    ],
    ids=[
        "403", "empty body", "balances not a list", "no entries", "two USD entries", "no USD entry",
        "no available_balance", "EUR inside the USD entry", "value a number", "available_balance text",
        "thousands comma", "three decimals", "leading space", "exponent", "plus sign", "empty value",
    ],
)
def test_anything_but_one_well_formed_usd_entry_raises_paypal_error(reply: httpx.Response) -> None:
    with pytest.raises(PayPalError):
        available_usd_minor(http_for(Balances(reply)))


@pytest.fixture(scope="module")
def server_url() -> Iterator[str]:
    server = pgserver.get_server(PGDATA)
    yield server.get_uri()


@pytest.fixture
def conn(server_url: str) -> Iterator[psycopg.Connection]:
    schema = sql.Identifier("bal_test_" + uuid.uuid4().hex[:12])
    with psycopg.connect(server_url, autocommit=True) as connection:
        connection.execute(sql.SQL("create schema {}").format(schema))
        try:
            connection.execute(sql.SQL("set search_path to {}").format(schema))
            apply_schema(connection)
            yield connection
        finally:
            connection.execute(sql.SQL("drop schema {} cascade").format(schema))


def room_checked(conn: psycopg.Connection, value: str, snap: BatchSnapshot, floor: int = 25000) -> None:
    with conn.transaction():
        check_room(conn, http_for(Balances(answer(usd_entry(value)))), snap, floor)


def claimed(conn: psycopg.Connection, amounts: tuple[int, ...], hours_ago: float, status: str = "submitted") -> BatchSnapshot:
    """A campaign now in status whose batch of amounts was first claimed hours_ago. Returns its frozen snapshot."""
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 10000, 1000, 0.5, %s) returning campaign_id",
        (status,),
    ).fetchone()[0]
    items = tuple(PayoutItemSpec(f"x{n}@shop.example", amount, "Thanks", f"R{n}") for n, amount in enumerate(amounts, start=1))
    snap = BatchSnapshot(str(campaign_id), "USD", "A thank-you", items)
    conn.execute("insert into approved_snapshots values (%s, %s, %s, now(), 'owner')", (campaign_id, snapshot_hash(snap), canonical_json(snap)))
    conn.execute(
        "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, status, created_at) "
        "values (%s, %s, %s, 'created', now() - make_interval(secs => %s))",
        (sender_batch_id_for(snap), str(campaign_id), snapshot_hash(snap), hours_ago * 3600),
    )
    return snap


def test_check_room_needs_the_batch_25_cents_an_item_and_the_floor_left_over(conn: psycopg.Connection) -> None:
    # 250 + 300 cents and 2 items at 25 cents: 600, so 250.00 + 6.00 is the least that sends.
    snap = batch(250, 300)
    room_checked(conn, "256.00", snap)
    with pytest.raises(BalanceTooLow) as caught:
        room_checked(conn, "255.99", snap)
    assert caught.value.code == "low_balance"


def test_the_room_takes_off_mends_own_batches_of_the_last_6_hours_but_not_voided_ones_or_this_one(conn: psycopg.Connection) -> None:
    # 100 + 200 cents and 2 items at 25 cents: 350 that PayPal's lagging figure may not show yet.
    claimed(conn, (100, 200), 5.9)
    claimed(conn, (5000,), 6.1)
    claimed(conn, (4000,), 1, status="voided")
    # The batch being sent was claimed once before; it is taken off once, as this batch.
    snap = claimed(conn, (250, 300), 2, status="submission_unknown")

    room_checked(conn, "259.50", snap)
    with pytest.raises(BalanceTooLow) as caught:
        room_checked(conn, "259.49", snap)
    assert caught.value.code == "low_balance"


def test_check_room_needs_a_transaction_and_holds_the_balance_lock_until_it_ends(conn: psycopg.Connection, server_url: str) -> None:
    with pytest.raises(RuntimeError):
        check_room(conn, http_for(Balances(answer())), batch(100), 1)
    with psycopg.connect(server_url, autocommit=True) as other:
        with conn.transaction():
            check_room(conn, http_for(Balances(answer())), batch(100), 1)
            assert other.execute("select pg_try_advisory_lock(%s)", (balances.BALANCE_LOCK,)).fetchone()[0] is False
        assert other.execute("select pg_try_advisory_lock(%s)", (balances.BALANCE_LOCK,)).fetchone()[0] is True
        other.execute("select pg_advisory_unlock(%s)", (balances.BALANCE_LOCK,))


@pytest.mark.parametrize(
    "reply",
    [httpx.ReadTimeout("slow"), httpx.Response(503, json={"name": "SERVICE_UNAVAILABLE"}), answer(usd_entry("lots"))],
    ids=["timeout", "503", "unreadable"],
)
def test_a_balance_that_cannot_be_read_counts_as_too_low(conn: psycopg.Connection, reply: httpx.Response | Exception) -> None:
    with pytest.raises(BalanceTooLow) as caught:
        with conn.transaction():
            check_room(conn, http_for(Balances(reply)), batch(100), 1)
    assert caught.value.code == "balance_unavailable"
