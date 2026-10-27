# Not covered here: PayPal's real cancel and item answers (the M7e-1 live probe covers
# the cancel; the webhook path reads real items through the same get_item), the webhook
# that later confirms a RETURNED item (test_events.py), the task's role checks
# (test_tasks.py), and two whole cancel runs racing on one campaign (the row lock
# is shown holding while PayPal answers, from a second connection).
import uuid
from collections.abc import Callable, Iterator

import httpx
import pgserver
import psycopg
import pytest
from psycopg import sql

from mend_engine.campaigns.cancel import CancelReport, cancel_unclaimed
from mend_engine.config import SANDBOX_API_HOST, Config
from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema
from mend_engine.events.payout_status import record_item_status
from mend_engine.paypal.http import PayPalError, PayPalHttp, PayPalUnreachable
from mend_engine.paypal.payouts import BatchSnapshot, PayoutItemSpec, canonical_json, snapshot_hash

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
# R1 and R2 wait unclaimed, R3 was claimed, R4 failed; each is paid 100 cents times its number.
STATUSES = {"R1": "UNCLAIMED", "R2": "UNCLAIMED", "R3": "SUCCESS", "R4": "FAILED"}


@pytest.fixture(scope="module")
def server_url() -> Iterator[str]:
    server = pgserver.get_server(PGDATA)
    yield server.get_uri()


@pytest.fixture
def conn(server_url: str) -> Iterator[psycopg.Connection]:
    name = sql.Identifier("m7e_cancel_" + uuid.uuid4().hex[:12])
    with psycopg.connect(server_url, autocommit=True) as connection:
        connection.execute(sql.SQL("create schema {}").format(name))
        try:
            connection.execute(sql.SQL("set search_path to {}").format(name))
            apply_schema(connection)
            yield connection
        finally:
            connection.execute(sql.SQL("drop schema {} cascade").format(name))


@pytest.fixture
def other(server_url: str, conn: psycopg.Connection) -> Iterator[psycopg.Connection]:
    """A second connection to the same test schema, as another process would hold."""
    schema = conn.execute("select current_schema()").fetchone()[0]
    with psycopg.connect(server_url, autocommit=True) as connection:
        connection.execute(sql.SQL("set search_path to {}").format(sql.Identifier(schema)))
        yield connection


def sent_campaign(conn: psycopg.Connection) -> uuid.UUID:
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 10000, 1000, 0.5, 'submitted') returning campaign_id"
    ).fetchone()[0]
    items = tuple(PayoutItemSpec(f"m{n}@shop.example", 100 * n, "Thanks", ref) for n, ref in enumerate(STATUSES, start=1))
    snap = BatchSnapshot(str(campaign_id), "USD", "A thank-you", items)
    conn.execute(
        "insert into approved_snapshots values (%s, %s, %s, now(), 'owner')", (campaign_id, snapshot_hash(snap), canonical_json(snap))
    )
    conn.execute(
        "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, payout_batch_id, status) "
        "values ('mend-c', %s, %s, 'BATCHC', 'created')",
        (str(campaign_id), snapshot_hash(snap)),
    )
    for n, (ref, status) in enumerate(STATUSES.items(), start=1):
        conn.execute(
            "insert into payout_items (payout_item_id, sender_batch_id, sender_item_id, status, fee_minor) values (%s, 'mend-c', %s, %s, 25)",
            (f"ITEM{n}", ref, status),
        )
    return campaign_id


class FakePayPal:
    """Answers each cancel from answers by item id, RETURNED by default, and records the item ids asked about.

    A read of one item ("ITEMn", sender_item_id "Rn" in batch mend-c, BATCHC) is
    answered from reads: a status, or a ready response; UNCLAIMED by default.
    """

    def __init__(
        self,
        answers: dict[str, object] | None = None,
        on_cancel: Callable[[str], None] | None = None,
        reads: dict[str, object] | None = None,
    ) -> None:
        self.answers = answers or {}
        self.on_cancel = on_cancel
        self.reads = reads or {}
        self.cancels: list[str] = []
        self.read: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 32000})
        if request.method == "GET":
            return self._read(request.url.path.split("/")[-1])
        assert request.method == "POST" and request.url.path.endswith("/cancel"), "a cancel run only cancels and reads items"
        item_id = request.url.path.split("/")[-2]
        self.cancels.append(item_id)
        if self.on_cancel:
            self.on_cancel(item_id)
        answer = self.answers.get(item_id)
        if isinstance(answer, Exception):
            raise answer
        if answer is not None:
            return answer
        return httpx.Response(
            200,
            json={
                "payout_item_id": item_id,
                "transaction_status": "RETURNED",
                "payout_item": {"receiver": "m1@shop.example", "recipient_name": {"full_name": "Maya R."}},
            },
        )

    def _read(self, item_id: str) -> httpx.Response:
        self.read.append(item_id)
        answer = self.reads.get(item_id, "UNCLAIMED")
        if isinstance(answer, httpx.Response):
            return answer
        return httpx.Response(
            200,
            json={
                "payout_item_id": item_id,
                "payout_batch_id": "BATCHC",
                "sender_batch_id": "mend-c",
                "transaction_status": answer,
                "payout_item_fee": {"currency": "USD", "value": "0.25"},
                "payout_item": {"sender_item_id": "R" + item_id[4:], "receiver": "m1@shop.example", "recipient_name": {"full_name": "Maya R."}},
            },
        )

    def http(self) -> PayPalHttp:
        return PayPalHttp(CONFIG, transport=httpx.MockTransport(self))


def statuses(conn: psycopg.Connection) -> dict[str, str]:
    return dict(conn.execute("select payout_item_id, status from payout_items"))


def audit(conn: psycopg.Connection) -> list[tuple]:
    return conn.execute("select actor, action, detail from audit_log order by id").fetchall()


def test_the_state_machine_moves_an_unclaimed_item_to_returned(conn: psycopg.Connection) -> None:
    conn.execute(
        "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, payout_batch_id, status) "
        "values ('mend-c', 'c', 'h', 'BATCHC', 'created')"
    )
    first = record_item_status(conn, payout_item_id="ITEM1", sender_batch_id="mend-c", sender_item_id="R1", seen="UNCLAIMED", fee_minor=25)
    change = record_item_status(conn, payout_item_id="ITEM1", sender_batch_id="mend-c", sender_item_id="R1", seen="RETURNED", fee_minor=None)
    assert (first.decision, change.decision, change.previous, change.stored) == ("new", "moved", "UNCLAIMED", "RETURNED")
    assert conn.execute("select status, fee_minor from payout_items").fetchone() == ("RETURNED", 25)


def test_only_unclaimed_items_are_cancelled_and_their_approved_amounts_count_as_returned(conn: psycopg.Connection) -> None:
    campaign_id = sent_campaign(conn)
    paypal = FakePayPal()

    report = cancel_unclaimed(conn, paypal.http(), campaign_id)

    assert report == CancelReport(cancelled=2, returned_minor=300, still_unclaimed=0, not_cancellable=0)
    assert paypal.cancels == ["ITEM1", "ITEM2"]
    assert statuses(conn) == {"ITEM1": "RETURNED", "ITEM2": "RETURNED", "ITEM3": "SUCCESS", "ITEM4": "FAILED"}
    assert audit(conn) == [
        ("cancel", "payout_item_cancelled", {"payout_item_id": "ITEM1", "status": "RETURNED"}),
        ("cancel", "payout_item_cancelled", {"payout_item_id": "ITEM2", "status": "RETURNED"}),
    ]


def test_a_4xx_for_one_item_counts_it_as_not_cancellable_and_the_next_is_still_cancelled(conn: psycopg.Connection) -> None:
    campaign_id = sent_campaign(conn)
    refused = httpx.Response(422, json={"name": "ITEM_INCORRECT_STATUS", "debug_id": "dbg7"})
    paypal = FakePayPal({"ITEM1": refused})

    report = cancel_unclaimed(conn, paypal.http(), campaign_id)

    assert report == CancelReport(cancelled=1, returned_minor=200, still_unclaimed=1, not_cancellable=1)
    assert paypal.cancels == ["ITEM1", "ITEM2"]
    assert (statuses(conn)["ITEM1"], statuses(conn)["ITEM2"]) == ("UNCLAIMED", "RETURNED")
    assert audit(conn)[0] == (
        "cancel",
        "payout_item_cancel_failed",
        {"payout_item_id": "ITEM1", "http_status": 422, "name": "ITEM_INCORRECT_STATUS", "debug_id": "dbg7", "status_now": "UNCLAIMED"},
    )


def test_a_4xx_cancel_is_followed_by_a_read_and_paypals_real_status_is_recorded(conn: psycopg.Connection) -> None:
    campaign_id = sent_campaign(conn)
    # The customer claimed R1 a moment before the cancel reached PayPal.
    paypal = FakePayPal({"ITEM1": httpx.Response(422, json={"name": "ITEM_INCORRECT_STATUS"})}, reads={"ITEM1": "SUCCESS"})

    report = cancel_unclaimed(conn, paypal.http(), campaign_id)

    assert report == CancelReport(cancelled=1, returned_minor=200, still_unclaimed=0, not_cancellable=1)
    assert paypal.read == ["ITEM1"]
    assert conn.execute("select status, fee_minor from payout_items where payout_item_id = 'ITEM1'").fetchone() == ("SUCCESS", 25)
    assert audit(conn)[0][2]["status_now"] == "SUCCESS"


def test_a_read_after_a_4xx_that_fails_or_names_another_batch_records_nothing_and_the_run_goes_on(conn: psycopg.Connection) -> None:
    campaign_id = sent_campaign(conn)
    elsewhere = httpx.Response(
        200,
        json={
            "payout_item_id": "ITEM1", "payout_batch_id": "BATCHC", "sender_batch_id": "mend-other",
            "transaction_status": "SUCCESS", "payout_item": {"sender_item_id": "R1"},
        },
    )
    refused = httpx.Response(400, json={"name": "ITEM_CANCELLATION_FAILED"})
    paypal = FakePayPal(
        {"ITEM1": refused, "ITEM2": refused},
        reads={"ITEM1": elsewhere, "ITEM2": httpx.Response(500, json={"name": "INTERNAL_SERVER_ERROR"})},
    )

    report = cancel_unclaimed(conn, paypal.http(), campaign_id)

    assert report == CancelReport(cancelled=0, returned_minor=0, still_unclaimed=2, not_cancellable=2)
    assert paypal.read == ["ITEM1", "ITEM2"] and (statuses(conn)["ITEM1"], statuses(conn)["ITEM2"]) == ("UNCLAIMED", "UNCLAIMED")
    assert [detail["status_now"] for _, _, detail in audit(conn)] == [None, None]


def test_a_limit_asks_paypal_about_at_most_that_many_items(conn: psycopg.Connection) -> None:
    campaign_id = sent_campaign(conn)
    paypal = FakePayPal()

    report = cancel_unclaimed(conn, paypal.http(), campaign_id, limit=1)

    assert report == CancelReport(cancelled=1, returned_minor=100, still_unclaimed=1, not_cancellable=0)
    assert paypal.cancels == ["ITEM1"]
    for bad in (0, -1, True, 1.5, "1"):
        with pytest.raises(ValueError):
            cancel_unclaimed(conn, paypal.http(), campaign_id, limit=bad)  # type: ignore[arg-type]
    assert paypal.cancels == ["ITEM1"]


@pytest.mark.parametrize(
    ("answer", "raised", "status"),
    [
        (httpx.Response(500, json={"name": "INTERNAL_SERVER_ERROR"}), PayPalError, 500),
        (httpx.ConnectError("down"), PayPalUnreachable, None),
    ],
    ids=["500", "unreachable"],
)
def test_a_5xx_or_no_answer_stops_the_run_and_later_items_are_untouched(
    conn: psycopg.Connection, answer: object, raised: type, status: int | None
) -> None:
    campaign_id = sent_campaign(conn)
    paypal = FakePayPal({"ITEM1": answer})

    with pytest.raises(raised) as caught:
        cancel_unclaimed(conn, paypal.http(), campaign_id)

    assert caught.value.status == status and paypal.cancels == ["ITEM1"]
    assert (statuses(conn)["ITEM1"], statuses(conn)["ITEM2"]) == ("UNCLAIMED", "UNCLAIMED")
    assert [action for _, action, _ in audit(conn)] == ["payout_item_cancel_failed"]


def test_a_second_run_cancels_nothing(conn: psycopg.Connection) -> None:
    campaign_id = sent_campaign(conn)
    paypal = FakePayPal()
    cancel_unclaimed(conn, paypal.http(), campaign_id)

    again = cancel_unclaimed(conn, paypal.http(), campaign_id)

    assert again == CancelReport(cancelled=0, returned_minor=0, still_unclaimed=0, not_cancellable=0)
    assert paypal.cancels == ["ITEM1", "ITEM2"] and len(audit(conn)) == 2


def test_audit_rows_hold_no_email_or_name_from_paypals_answer(conn: psycopg.Connection) -> None:
    campaign_id = sent_campaign(conn)
    paypal = FakePayPal({"ITEM2": httpx.Response(400, json={"name": "ITEM_ALREADY_CANCELLED", "message": "m1@shop.example"})})

    cancel_unclaimed(conn, paypal.http(), campaign_id)

    text = conn.execute("select string_agg(actor || ' ' || action || ' ' || detail::text, ' ') from audit_log").fetchone()[0]
    assert len(audit(conn)) == 2 and "@" not in text and "Maya" not in text and "receiver" not in text


def test_the_row_stays_locked_while_paypal_answers_and_an_item_claimed_meanwhile_is_not_cancelled(
    conn: psycopg.Connection, other: psycopg.Connection
) -> None:
    campaign_id = sent_campaign(conn)
    seen_locked: list[bool] = []

    def meanwhile(item_id: str) -> None:
        if item_id != "ITEM1":
            return
        try:
            other.execute("select 1 from payout_items where payout_item_id = 'ITEM1' for update nowait")
            seen_locked.append(False)
        except psycopg.errors.LockNotAvailable:
            seen_locked.append(True)
        # The customer claims R2 while R1's cancel is still on its way.
        other.execute("update payout_items set status = 'SUCCESS' where payout_item_id = 'ITEM2'")

    paypal = FakePayPal(on_cancel=meanwhile)
    report = cancel_unclaimed(conn, paypal.http(), campaign_id)

    assert seen_locked == [True] and paypal.cancels == ["ITEM1"]
    assert report == CancelReport(cancelled=1, returned_minor=100, still_unclaimed=0, not_cancellable=0)
    assert statuses(conn)["ITEM2"] == "SUCCESS"
