# Not covered here: signature verification (the web receiver, C9, tested in
# packages/web), real PayPal answers and delivery timing (prove_m5), two event
# runs on separate machines (they share the one database lock shown below), and
# PayPal's real DENIED batch answer (the shape follows RD-BRIEF section 4).
import json
import uuid
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

import httpx
import pgserver
import psycopg
import pytest
from psycopg import sql

from mend_engine.campaigns.results import campaign_results
from mend_engine.campaigns.spend import database_now, spent_last_24h_minor
from mend_engine.config import SANDBOX_API_HOST, Config
from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema
from mend_engine.events.process import EVENT_LOCK, MAX_ATTEMPTS, MAX_PASSES, process_events
from mend_engine.maintenance.purge import purge_paypal_events
from mend_engine.paypal.http import PayPalHttp
from mend_engine.paypal.payouts import (
    BatchSnapshot,
    PayoutIdRefused,
    PayoutItemSpec,
    canonical_json,
    get_item,
    sender_batch_id_for,
    snapshot_hash,
)

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
SIM_ORDER = "5O190127TN364715T"
NOW = datetime.now(timezone.utc)


@pytest.fixture(scope="module")
def server_url() -> Iterator[str]:
    server = pgserver.get_server(PGDATA)
    yield server.get_uri()


@pytest.fixture
def conn(server_url: str) -> Iterator[psycopg.Connection]:
    name = sql.Identifier("m5_events_" + uuid.uuid4().hex[:12])
    with psycopg.connect(server_url, autocommit=True) as connection:
        connection.execute(sql.SQL("create schema {}").format(name))
        try:
            connection.execute(sql.SQL("set search_path to {}").format(name))
            apply_schema(connection)
            yield connection
        finally:
            connection.execute(sql.SQL("drop schema {} cascade").format(name))


def campaign(conn: psycopg.Connection, route: tuple[str, ...], sender_batch_id: str, payout_batch_id: str | None) -> uuid.UUID:
    """R1 rewarded, R2 held back, moved along route, with its ledger row."""
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 1000, 100, 0.5, 'draft') returning campaign_id"
    ).fetchone()[0]
    conn.execute(
        "insert into campaign_members (campaign_id, ref, role, rank, score, amount_minor, note) values "
        "(%s, 'R1', 'reward', 1, 0.1, 100, 'Thanks'), (%s, 'R2', 'holdout', 2, 0.2, null, null)",
        (campaign_id, campaign_id),
    )
    for step in route:
        conn.execute("update campaigns set status = %s where campaign_id = %s", (step, campaign_id))
    conn.execute(
        "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, payout_batch_id, status) values (%s, %s, 'h', %s, %s)",
        (sender_batch_id, str(campaign_id), payout_batch_id, route[-1]),
    )
    return campaign_id


def sent(conn: psycopg.Connection) -> uuid.UUID:
    campaign_id = campaign(conn, ("approved", "submitting", "submitted"), "mend-ours", "BATCHOURS")
    # Backdated, so a purchase made an hour ago falls inside the window.
    conn.execute(
        "insert into campaign_status_moves (campaign_id, from_status, to_status, moved_at) values (%s, 'submitting', 'submitted', %s)",
        (campaign_id, NOW - timedelta(days=1)),
    )
    return campaign_id


def deliver(conn: psycopg.Connection, event_type: str, resource: dict, *, raw: str | None = None, age_minutes: int = 0) -> str:
    """A delivery as the web receiver stores one after PayPal verified it."""
    transmission_id = str(uuid.uuid4())
    body = raw if raw is not None else json.dumps({"id": "WH-" + transmission_id, "event_type": event_type, "resource": resource})
    conn.execute(
        "insert into paypal_events (transmission_id, event_id, event_type, received_at, purge_after, raw) "
        "values (%s, %s, %s, now() - make_interval(mins => %s), now() + interval '48 hours', %s)",
        (transmission_id, "WH-" + transmission_id, event_type, age_minutes, body),
    )
    return transmission_id


def item_answer(item_id: str, status: str, sender_batch_id: str = "mend-ours", payout_batch_id: str = "BATCHOURS") -> dict:
    return {
        "payout_item_id": item_id,
        "transaction_status": status,
        "payout_batch_id": payout_batch_id,
        "sender_batch_id": sender_batch_id,
        "payout_item_fee": {"currency": "USD", "value": "0.25"},
        "payout_item": {"sender_item_id": "R1", "receiver": "m1@shop.example", "recipient_name": {"full_name": "Maya R."}},
    }


def order_answer(simulated_order_id: uuid.UUID, *, status: str = "COMPLETED", created: datetime | None = None) -> dict:
    when = (created or NOW - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "id": SIM_ORDER,
        "status": status,
        "payment_source": {"card": {"name": "Test Buyer", "last_digits": "1111"}},
        "purchase_units": [
            {
                "custom_id": str(simulated_order_id),
                "payments": {
                    "captures": [
                        {"id": "CAP1", "status": "COMPLETED", "amount": {"currency_code": "USD", "value": "12.50"}, "create_time": when}
                    ]
                },
            }
        ],
    }


class FakePayPal:
    """Answers re-reads from answers, keyed by path; a path missing from it answers 503."""

    def __init__(self, answers: dict[str, dict] | None = None) -> None:
        self.answers = answers or {}
        self.reads: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 32000})
        assert request.method == "GET", "event processing never writes to PayPal"
        self.reads.append(request.url.path)
        if request.url.path not in self.answers:
            return httpx.Response(503, json={"name": "SERVICE_UNAVAILABLE", "debug_id": "dbg1"})
        return httpx.Response(200, json=self.answers[request.url.path])

    def http(self) -> PayPalHttp:
        return PayPalHttp(CONFIG, transport=httpx.MockTransport(self))


class ArrivingPayPal(FakePayPal):
    """FakePayPal that calls on_read before each re-read is answered, as when a delivery lands mid-run."""

    def __init__(self, on_read, answers: dict[str, dict] | None = None) -> None:
        super().__init__(answers)
        self.on_read = on_read

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path != "/v1/oauth2/token":
            self.on_read()
        return super().__call__(request)


@pytest.fixture
def other(server_url: str, conn: psycopg.Connection) -> Iterator[psycopg.Connection]:
    """A second connection to the same test schema, as the web receiver's process holds."""
    schema = conn.execute("select current_schema()").fetchone()[0]
    with psycopg.connect(server_url, autocommit=True) as connection:
        connection.execute(sql.SQL("set search_path to {}").format(sql.Identifier(schema)))
        yield connection


def attempts(conn: psycopg.Connection, transmission_id: str) -> int:
    return conn.execute(
        "select count(*) from audit_log where action = 'event_attempt_failed' and detail ->> 'transmission_id' = %s", (transmission_id,)
    ).fetchone()[0]


def outcome(conn: psycopg.Connection, transmission_id: str) -> tuple | None:
    return conn.execute("select outcome, detail from event_outcomes where transmission_id = %s", (transmission_id,)).fetchone()


def item_status(conn: psycopg.Connection, item_id: str) -> str | None:
    row = conn.execute("select status from payout_items where payout_item_id = %s", (item_id,)).fetchone()
    return row[0] if row else None


def test_item_events_follow_paypal_and_a_stale_success_cannot_undo_returned(conn: psycopg.Connection) -> None:
    sent(conn)
    paypal = FakePayPal()
    statuses = iter(["UNCLAIMED", "RETURNED", "SUCCESS"])
    tids = []
    for _ in range(3):
        paypal.answers["/v1/payments/payouts-item/ITEM1"] = item_answer("ITEM1", next(statuses))
        tids.append(deliver(conn, "PAYMENT.PAYOUTS-ITEM.UNCLAIMED", {"payout_item_id": "ITEM1"}))
        process_events(conn, paypal.http())
    decisions = [(outcome(conn, t)[0], outcome(conn, t)[1]["decision"]) for t in tids]
    assert decisions == [("status recorded", "new"), ("status recorded", "moved"), ("status refused", "refused")]
    assert outcome(conn, tids[2])[1]["from"] == "RETURNED" and item_status(conn, "ITEM1") == "RETURNED"
    assert conn.execute("select fee_minor from payout_items").fetchone()[0] == 25


def test_only_the_item_id_is_taken_from_the_event_and_a_batch_we_did_not_create_changes_nothing(conn: psycopg.Connection) -> None:
    campaign_id = sent(conn)
    # The event claims success in our batch; PayPal's own answer puts the item in someone else's.
    lie = {"payout_item_id": "ITEM9", "payout_batch_id": "BATCHOURS", "transaction_status": "SUCCESS", "sender_batch_id": "mend-ours"}
    paypal = FakePayPal({"/v1/payments/payouts-item/ITEM9": item_answer("ITEM9", "SUCCESS", "theirs-1", "BATCHTHEIRS")})
    forged = deliver(conn, "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", lie)
    # An item PayPal places in our sender_batch_id but under another payout_batch_id is not ours either.
    paypal.answers["/v1/payments/payouts-item/ITEM8"] = item_answer("ITEM8", "SUCCESS", "mend-ours", "BATCHOTHER")
    mixed = deliver(conn, "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", {"payout_item_id": "ITEM8"})
    before = conn.execute("select status from campaigns where campaign_id = %s", (campaign_id,)).fetchone()

    report = process_events(conn, paypal.http())

    assert report.outcomes == {"not ours": 2}
    assert outcome(conn, forged)[1]["reason"] == "the batch is not in our ledger"
    assert outcome(conn, mixed)[1]["reason"] == "PayPal's batch is not the one in our ledger"
    assert conn.execute("select count(*) from payout_items").fetchone()[0] == 0
    assert conn.execute("select status from campaigns where campaign_id = %s", (campaign_id,)).fetchone() == before


def batch_answer(payout_batch_id: str, sender_batch_id: str, status: str = "SUCCESS") -> dict:
    return {"batch_header": {"payout_batch_id": payout_batch_id, "batch_status": status,
                             "sender_batch_header": {"sender_batch_id": sender_batch_id}}}


def campaign_status(conn: psycopg.Connection, campaign_id: uuid.UUID) -> str:
    return conn.execute("select status from campaigns where campaign_id = %s", (campaign_id,)).fetchone()[0]


def rest_passed(conn: psycopg.Connection) -> None:
    """Five minutes pass for every failed re-read so far. The audit log is append-only; its guard is off only to stage the time."""
    conn.execute("alter table audit_log disable trigger audit_log_append_only")
    conn.execute("update audit_log set at = at - interval '6 minutes' where action = 'event_attempt_failed'")
    conn.execute("alter table audit_log enable trigger audit_log_append_only")


def test_a_batch_event_resolves_a_campaign_paypal_holds(conn: psycopg.Connection) -> None:
    campaign_id = campaign(conn, ("approved", "submitting", "exists_unresolved"), "mend-unres", None)
    paypal = FakePayPal({"/v1/payments/payouts/BATCHU": batch_answer("BATCHU", "mend-unres")})
    batch_event = deliver(conn, "PAYMENT.PAYOUTSBATCH.SUCCESS", {"batch_header": {"payout_batch_id": "BATCHU"}})

    assert process_events(conn, paypal.http()).outcomes == {"batch resolved": 1}

    assert outcome(conn, batch_event)[0] == "batch resolved" and campaign_status(conn, campaign_id) == "submitted"
    assert conn.execute("select payout_batch_id, status from payout_batches where sender_batch_id = 'mend-unres'").fetchone() == (
        "BATCHU", "resolved_by_event",
    )
    moves = conn.execute(
        "select from_status, to_status from campaign_status_moves where campaign_id = %s and to_status = 'submitted'", (campaign_id,)
    ).fetchall()
    assert moves == [("exists_unresolved", "submitted")]


def test_an_item_event_fills_in_a_missing_payout_batch_id_once_paypal_confirms_the_batch(conn: psycopg.Connection) -> None:
    healed = campaign(conn, ("approved", "submitting", "exists_unresolved"), "mend-unres", None)
    mismatched = campaign(conn, ("approved", "submitting", "exists_unresolved"), "mend-other", None)
    paypal = FakePayPal({
        "/v1/payments/payouts-item/ITEMU": item_answer("ITEMU", "SUCCESS", "mend-unres", "BATCHU"),
        "/v1/payments/payouts/BATCHU": batch_answer("BATCHU", "mend-unres"),
        # PayPal's item answer names our batch; its batch answer names someone else's, so neither is believed.
        "/v1/payments/payouts-item/ITEMX": item_answer("ITEMX", "SUCCESS", "mend-other", "BATCHX"),
        "/v1/payments/payouts/BATCHX": batch_answer("BATCHX", "mend-someone-else"),
    })
    item = deliver(conn, "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", {"payout_item_id": "ITEMU"})
    lie = deliver(conn, "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", {"payout_item_id": "ITEMX"})

    report = process_events(conn, paypal.http())

    assert (report.outcomes, report.retrying) == ({"status recorded": 1, "not ours": 1}, 0)
    assert item_status(conn, "ITEMU") == "SUCCESS" and campaign_status(conn, healed) == "submitted"
    assert conn.execute("select payout_batch_id, status from payout_batches where sender_batch_id = 'mend-unres'").fetchone() == (
        "BATCHU", "resolved_by_event",
    )
    resolved = conn.execute("select detail from audit_log where action = 'batch_resolved_by_event'").fetchall()
    assert resolved == [({"campaign_id": str(healed), "sender_batch_id": "mend-unres", "payout_batch_id": "BATCHU", "from": "exists_unresolved"},)]
    assert outcome(conn, lie)[0] == "not ours" and item_status(conn, "ITEMX") is None
    assert campaign_status(conn, mismatched) == "exists_unresolved"
    assert conn.execute("select payout_batch_id from payout_batches where sender_batch_id = 'mend-other'").fetchone() == (None,)


def test_exists_unresolved_with_a_success_batch_event_and_five_503s_heals_once_paypal_answers(conn: psycopg.Connection) -> None:
    # The auditor's repro. The event body names only the payout_batch_id, which our ledger does not hold yet.
    campaign_id = campaign(conn, ("approved", "submitting", "exists_unresolved"), "mend-unres", None)
    sent(conn)
    paypal = FakePayPal()
    heal = deliver(conn, "PAYMENT.PAYOUTSBATCH.SUCCESS", {"batch_header": {"payout_batch_id": "BATCHU"}})
    # A batch our ledger already holds for a sent campaign needs nothing healed, so it still gives up.
    settled = deliver(conn, "PAYMENT.PAYOUTSBATCH.SUCCESS", {"batch_header": {"payout_batch_id": "BATCHOURS"}})

    for _ in range(MAX_ATTEMPTS):
        process_events(conn, paypal.http())
        rest_passed(conn)

    assert (attempts(conn, heal), outcome(conn, heal)) == (MAX_ATTEMPTS, None)
    assert outcome(conn, settled)[0] == "gave up"
    paypal.answers["/v1/payments/payouts/BATCHU"] = batch_answer("BATCHU", "mend-unres")
    assert process_events(conn, paypal.http()).outcomes == {"batch resolved": 1}
    assert outcome(conn, heal)[0] == "batch resolved" and campaign_status(conn, campaign_id) == "submitted"


def test_a_failed_reread_is_tried_again_only_after_5_minutes_however_often_runs_are_nudged(conn: psycopg.Connection) -> None:
    sent(conn)
    paypal = FakePayPal()
    tid = deliver(conn, "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", {"payout_item_id": "ITEM1"})

    first, nudged = process_events(conn, paypal.http()), process_events(conn, paypal.http())

    assert (first.retrying, nudged.retrying, len(paypal.reads), attempts(conn, tid)) == (1, 0, 1, 1)
    rest_passed(conn)
    process_events(conn, paypal.http())
    assert (len(paypal.reads), attempts(conn, tid)) == (2, 2)


def test_a_denied_batch_records_every_snapshot_item_as_failed_so_spend_and_results_stop_counting_them(conn: psycopg.Connection) -> None:
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 1000, 300, 0.5, 'submitted') returning campaign_id"
    ).fetchone()[0]
    snap = BatchSnapshot(
        str(campaign_id), "USD", "A thank-you",
        (PayoutItemSpec("m1@shop.example", 100, "Thanks", "R1"), PayoutItemSpec("m3@shop.example", 250, "Thanks", "R3")),
    )
    conn.execute("insert into approved_snapshots values (%s, %s, %s, now(), 'owner')", (campaign_id, snapshot_hash(snap), canonical_json(snap)))
    sender_batch_id = sender_batch_id_for(snap)
    conn.execute(
        "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, payout_batch_id, status) values (%s, %s, %s, 'BATCHD', 'created')",
        (sender_batch_id, str(campaign_id), snapshot_hash(snap)),
    )
    conn.execute("insert into payout_items (payout_item_id, sender_batch_id, sender_item_id, status) values ('ITEMD1', %s, 'R1', 'PENDING')", (sender_batch_id,))
    assert spent_last_24h_minor(conn, database_now(conn)) == 350
    paypal = FakePayPal({"/v1/payments/payouts/BATCHD": batch_answer("BATCHD", sender_batch_id, "DENIED")})
    tid = deliver(conn, "PAYMENT.PAYOUTSBATCH.DENIED", {"batch_header": {"payout_batch_id": "BATCHD"}})

    process_events(conn, paypal.http())

    assert (outcome(conn, tid)[0], outcome(conn, tid)[1]["items_failed"]) == ("batch denied", 2)
    rows = conn.execute("select sender_item_id, status from payout_items where sender_batch_id = %s order by sender_item_id", (sender_batch_id,)).fetchall()
    assert rows == [("R1", "FAILED"), ("R3", "FAILED")] and item_status(conn, "ITEMD1") == "FAILED"
    assert spent_last_24h_minor(conn, database_now(conn)) == 0
    payouts = campaign_results(conn, campaign_id).payouts
    assert (payouts.failed_minor, payouts.pending_minor) == (350, 0)
    # A row recorded for an item PayPal never named carries an id no PayPal call accepts, so it is never read or cancelled.
    [made_up] = [r[0] for r in conn.execute("select payout_item_id from payout_items where sender_item_id = 'R3'")]
    with pytest.raises(PayoutIdRefused):
        get_item(paypal.http(), made_up)


def test_batch_events_for_other_batches_or_settled_campaigns_change_nothing(conn: psycopg.Connection) -> None:
    sent(conn)
    unknown = campaign(conn, ("approved", "submitting", "submission_unknown"), "mend-two", "BATCHKNOWN")

    def batch(payout_batch_id: str, sender_batch_id: str) -> dict:
        return {"batch_header": {"payout_batch_id": payout_batch_id, "sender_batch_header": {"sender_batch_id": sender_batch_id}}}

    paypal = FakePayPal({
        "/v1/payments/payouts/BATCHOURS": batch("BATCHOURS", "mend-ours"),
        "/v1/payments/payouts/BATCHTHEIRS": batch("BATCHTHEIRS", "theirs-1"),
        "/v1/payments/payouts/BATCHWRONG": batch("BATCHWRONG", "mend-two"),
    })
    settled = deliver(conn, "PAYMENT.PAYOUTSBATCH.SUCCESS", {"batch_header": {"payout_batch_id": "BATCHOURS"}})
    theirs = deliver(conn, "PAYMENT.PAYOUTSBATCH.SUCCESS", {"batch_header": {"payout_batch_id": "BATCHTHEIRS"}})
    wrong = deliver(conn, "PAYMENT.PAYOUTSBATCH.SUCCESS", {"batch_header": {"payout_batch_id": "BATCHWRONG"}})

    process_events(conn, paypal.http())

    assert outcome(conn, settled)[0] == "batch unchanged" and outcome(conn, settled)[1]["campaign_status"] == "submitted"
    assert outcome(conn, theirs)[0] == "not ours"
    assert outcome(conn, wrong)[1]["reason"] == "the ledger holds a different payout_batch_id"
    assert conn.execute("select status from campaigns where campaign_id = %s", (unknown,)).fetchone()[0] == "submission_unknown"


def test_a_verified_capture_of_our_simulated_order_is_attributed_to_the_right_arm(conn: psycopg.Connection) -> None:
    campaign_id = sent(conn)
    simulated_order_id = uuid.uuid4()
    conn.execute(
        "insert into simulated_orders (simulated_order_id, paypal_order_id, campaign_id, ref) values (%s, %s, %s, 'R2')",
        (simulated_order_id, SIM_ORDER, campaign_id),
    )
    paypal = FakePayPal({f"/v2/checkout/orders/{SIM_ORDER}": order_answer(simulated_order_id)})
    capture = {"id": "CAP1", "custom_id": "ignored", "supplementary_data": {"related_ids": {"order_id": SIM_ORDER}}}
    tid = deliver(conn, "PAYMENT.CAPTURE.COMPLETED", capture)
    again = deliver(conn, "PAYMENT.CAPTURE.COMPLETED", capture)

    process_events(conn, paypal.http())

    assert outcome(conn, tid)[0] == "purchase recorded" and outcome(conn, tid)[1]["role"] == "holdout"
    assert (outcome(conn, again)[0], outcome(conn, again)[1]["reason"]) == ("purchase refused", "the purchase is already attributed")
    assert conn.execute("select ref, role, amount_minor, simulated, source_order from attributions").fetchall() == [
        ("R2", "holdout", 1250, True, SIM_ORDER),
    ]


def test_a_capture_of_any_other_order_is_not_ours_is_never_read_and_its_order_id_is_not_kept(conn: psycopg.Connection) -> None:
    sent(conn)
    paypal = FakePayPal()
    tid = deliver(conn, "PAYMENT.CAPTURE.COMPLETED", {"supplementary_data": {"related_ids": {"order_id": "STRANGER1"}}})
    process_events(conn, paypal.http())
    assert outcome(conn, tid)[0] == "not ours" and paypal.reads == []
    assert conn.execute("select count(*) from attributions").fetchone()[0] == 0
    # A stranger's order id is PayPal transaction data, so it goes with the raw body at 48 hours (C27).
    kept = conn.execute(
        "select (select coalesce(string_agg(detail::text, ' '), '') from event_outcomes) || "
        "(select coalesce(string_agg(detail::text, ' '), '') from audit_log)"
    ).fetchone()[0]
    assert "STRANGER1" not in kept and "paypal_order_id" not in outcome(conn, tid)[1]


@pytest.mark.parametrize(
    ("change", "reason"),
    [
        ({"status": "APPROVED"}, "PayPal does not say the order is COMPLETED"),
        ({"custom_id": "someone-else"}, "the order's custom_id is not the one this server set"),
        ({"created": NOW - timedelta(days=3)}, "the purchase is outside the 30-day window"),
    ],
)
def test_a_capture_is_refused_unless_paypal_confirms_a_completed_order_of_ours_in_the_window(
    conn: psycopg.Connection, change: dict, reason: str
) -> None:
    campaign_id = sent(conn)
    simulated_order_id = uuid.uuid4()
    conn.execute(
        "insert into simulated_orders (simulated_order_id, paypal_order_id, campaign_id, ref) values (%s, %s, %s, 'R1')",
        (simulated_order_id, SIM_ORDER, campaign_id),
    )
    answer = order_answer(simulated_order_id, status=change.get("status", "COMPLETED"), created=change.get("created"))
    if "custom_id" in change:
        answer["purchase_units"][0]["custom_id"] = change["custom_id"]
    paypal = FakePayPal({f"/v2/checkout/orders/{SIM_ORDER}": answer})
    tid = deliver(conn, "PAYMENT.CAPTURE.COMPLETED", {"supplementary_data": {"related_ids": {"order_id": SIM_ORDER}}})
    process_events(conn, paypal.http())
    assert outcome(conn, tid)[0] == "purchase refused" and outcome(conn, tid)[1]["reason"] == reason
    assert conn.execute("select count(*) from attributions").fetchone()[0] == 0


def test_other_types_are_ignored_and_unreadable_bodies_are_malformed(conn: psycopg.Connection) -> None:
    paypal = FakePayPal()
    ignored = deliver(conn, "CHECKOUT.ORDER.APPROVED", {"id": "X"})
    repeated = deliver(conn, "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", {}, raw='{"event_type":"PAYMENT.PAYOUTS-ITEM.SUCCEEDED","resource":{"payout_item_id":"A"},"resource":{"payout_item_id":"B"}}')
    retyped = deliver(conn, "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", {}, raw=json.dumps({"event_type": "PAYMENT.CAPTURE.COMPLETED", "resource": {}}))
    no_id = deliver(conn, "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", {"payout_item_id": "../../oauth2"})

    report = process_events(conn, paypal.http())

    assert report.outcomes == {"ignored": 1, "malformed": 3} and paypal.reads == []
    assert [outcome(conn, t)[0] for t in (ignored, repeated, retyped, no_id)] == ["ignored", "malformed", "malformed", "malformed"]


def test_a_failed_reread_leaves_the_event_for_the_next_run_and_the_fifth_failure_gives_up(conn: psycopg.Connection) -> None:
    sent(conn)
    paypal = FakePayPal()
    tid = deliver(conn, "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", {"payout_item_id": "ITEM1"})
    for run in range(1, MAX_ATTEMPTS):
        report = process_events(conn, paypal.http())
        assert (report.retrying, report.outcomes, outcome(conn, tid)) == (1, {}, None), run
        rest_passed(conn)
    final = process_events(conn, paypal.http())
    assert final.outcomes == {"gave up": 1}
    given_up = outcome(conn, tid)
    assert given_up[0] == "gave up"
    assert (given_up[1]["attempts"], given_up[1]["status"], given_up[1]["name"]) == (5, 503, "SERVICE_UNAVAILABLE")
    assert len(paypal.reads) == MAX_ATTEMPTS
    assert process_events(conn, paypal.http()).processed == 0 and len(paypal.reads) == MAX_ATTEMPTS


def test_each_delivery_gets_one_outcome_oldest_first_and_a_second_run_waits_for_the_lock(
    conn: psycopg.Connection, server_url: str
) -> None:
    newer = deliver(conn, "CHECKOUT.ORDER.APPROVED", {}, age_minutes=1)
    older = deliver(conn, "CHECKOUT.ORDER.APPROVED", {}, age_minutes=5)
    paypal = FakePayPal()
    with psycopg.connect(server_url, autocommit=True) as other:
        other.execute("select pg_advisory_lock(%s)", (EVENT_LOCK,))
        assert process_events(conn, paypal.http()).ran is False
        other.execute("select pg_advisory_unlock(%s)", (EVENT_LOCK,))
    assert process_events(conn, paypal.http(), limit=1).outcomes == {"ignored": 1}
    assert outcome(conn, older) is not None and outcome(conn, newer) is None
    process_events(conn, paypal.http())
    process_events(conn, paypal.http())
    assert conn.execute("select count(*) from event_outcomes").fetchone()[0] == 2
    for bad in (0, 501, 1.5, True):
        with pytest.raises(ValueError):
            process_events(conn, paypal.http(), limit=bad)


def test_a_delivery_stored_while_a_run_holds_the_lock_is_picked_up_by_that_calls_next_pass(
    conn: psycopg.Connection, other: psycopg.Connection
) -> None:
    sent(conn)
    nudges: list[tuple[str, object]] = []

    def arrives() -> None:
        # The web receiver stores a delivery and nudges a run, which finds the lock held.
        if not nudges:
            late = deliver(other, "CHECKOUT.ORDER.APPROVED", {})
            nudges.append((late, process_events(other, paypal.http())))

    paypal = ArrivingPayPal(arrives, {"/v1/payments/payouts-item/ITEM1": item_answer("ITEM1", "SUCCESS")})
    first = deliver(conn, "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", {"payout_item_id": "ITEM1"})

    report = process_events(conn, paypal.http())

    [(late, nudge)] = nudges
    assert (nudge.ran, nudge.passes, nudge.outcomes) == (False, 0, {})
    assert (report.ran, report.passes, report.outcomes) == (True, 2, {"status recorded": 1, "ignored": 1})
    assert (outcome(conn, first)[0], outcome(conn, late)[0]) == ("status recorded", "ignored")


def test_a_call_runs_at_most_three_passes_and_tries_each_delivery_once(conn: psycopg.Connection, other: psycopg.Connection) -> None:
    sent(conn)
    stored: list[str] = []

    def arrives() -> None:
        stored.append(deliver(other, "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", {"payout_item_id": f"ITEM{len(stored) + 2}"}))

    # No answers: every re-read gets a 503, so every delivery waits for a retry.
    paypal = ArrivingPayPal(arrives)
    first = deliver(conn, "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", {"payout_item_id": "ITEM1"})

    report = process_events(conn, paypal.http())

    assert (report.passes, report.retrying, report.outcomes) == (MAX_PASSES, 3, {}) and MAX_PASSES == 3
    assert paypal.reads == [f"/v1/payments/payouts-item/ITEM{n}" for n in (1, 2, 3)]
    # The waiting delivery cost one attempt, not one per pass; the one stored in pass 3 waits untried.
    assert (attempts(conn, first), attempts(conn, stored[-1]), outcome(conn, stored[-1])) == (1, 0, None)


def test_outcomes_hold_no_payload_email_or_name_and_survive_the_purge(conn: psycopg.Connection) -> None:
    campaign_id = sent(conn)
    simulated_order_id = uuid.uuid4()
    conn.execute(
        "insert into simulated_orders (simulated_order_id, paypal_order_id, campaign_id, ref) values (%s, %s, %s, 'R1')",
        (simulated_order_id, SIM_ORDER, campaign_id),
    )
    paypal = FakePayPal({
        "/v1/payments/payouts-item/ITEM1": item_answer("ITEM1", "SUCCESS"),
        f"/v2/checkout/orders/{SIM_ORDER}": order_answer(simulated_order_id),
    })
    deliver(conn, "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", {"payout_item_id": "ITEM1", "payout_item": {"receiver": "m1@shop.example"}})
    deliver(conn, "PAYMENT.CAPTURE.COMPLETED", {"payee": {"email_address": "shop@example.com"},
                                                "supplementary_data": {"related_ids": {"order_id": SIM_ORDER}}})
    process_events(conn, paypal.http())

    deleted = purge_paypal_events(conn, NOW + timedelta(hours=49))
    texts = conn.execute(
        "select coalesce(string_agg(outcome || ' ' || detail::text, ' '), '') from event_outcomes"
    ).fetchone()[0] + " " + conn.execute("select coalesce(string_agg(a::text, ' '), '') from attributions a").fetchone()[0]
    assert deleted == 2 and conn.execute("select count(*) from event_outcomes").fetchone()[0] == 2
    for forbidden in ("@", "Maya", "Test Buyer", "recipient_name", "payment_source", "resource"):
        assert forbidden not in texts
