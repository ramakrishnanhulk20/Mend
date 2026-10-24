# Not covered here: where the seen status comes from (the PayPal re-read in
# events.process, tested in test_events.py) and two connections recording the same
# item at the same instant (the event run holds one lock, so they never do).
import uuid
from collections.abc import Iterator

import pgserver
import psycopg
import pytest
from hypothesis import given
from hypothesis import strategies as st
from psycopg import sql

from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema
from mend_engine.events.payout_status import (
    FINAL_STATUSES,
    KNOWN_STATUSES,
    UNREADABLE,
    ItemConflict,
    as_seen,
    decide,
    effective,
    record_item_status,
)

# The order's table, written out again so the code is checked against it, not against itself.
SPEC = {
    "PENDING": {"SUCCESS", "UNCLAIMED", "FAILED", "ONHOLD", "BLOCKED"},
    "ONHOLD": {"SUCCESS", "UNCLAIMED", "FAILED", "BLOCKED"},
    "UNCLAIMED": {"SUCCESS", "RETURNED"},
    "SUCCESS": {"REFUNDED"},
    "FAILED": set(),
    "BLOCKED": set(),
    "RETURNED": set(),
    "REFUNDED": set(),
}


def test_every_pair_of_known_statuses_follows_the_table() -> None:
    assert KNOWN_STATUSES == set(SPEC) and FINAL_STATUSES == {"FAILED", "BLOCKED", "RETURNED", "REFUNDED"}
    for before in SPEC:
        for after in SPEC:
            expected = "unchanged" if before == after else ("moved" if after in SPEC[before] else "refused")
            assert decide(before, after) == expected, (before, after)


def test_an_unknown_status_is_kept_as_text_but_counts_as_pending() -> None:
    assert (as_seen("PROCESSING_LATER"), effective("PROCESSING_LATER")) == ("PROCESSING_LATER", "PENDING")
    for junk in ("success", "SUCCESS ", "", None, 7, "<b>", "A" * 37):
        assert as_seen(junk) == UNREADABLE
    assert effective(UNREADABLE) == effective(None) == "PENDING"
    assert decide("PENDING", "PROCESSING_LATER") == "unchanged"
    assert decide("PROCESSING_LATER", "SUCCESS") == "moved"
    # An unknown status never stands in for success, so it cannot undo one.
    assert decide("SUCCESS", "PROCESSING_LATER") == "refused"
    assert decide("RETURNED", UNREADABLE) == "refused"


@given(st.lists(st.sampled_from([*SPEC, "PROCESSING_LATER", UNREADABLE]), min_size=1, max_size=12))
def test_no_order_of_answers_ever_moves_a_status_backwards_or_off_a_final_one(answers: list[str]) -> None:
    stored = None
    for seen in answers:
        decision = decide(stored, seen)
        if decision == "refused":
            continue
        if stored is not None:
            before, after = effective(stored), effective(seen)
            assert before == after or after in SPEC[before]
            assert before not in FINAL_STATUSES or before == after
        stored = seen


@pytest.fixture(scope="module")
def server_url() -> Iterator[str]:
    server = pgserver.get_server(PGDATA)
    yield server.get_uri()


@pytest.fixture
def conn(server_url: str) -> Iterator[psycopg.Connection]:
    name = sql.Identifier("m5_status_" + uuid.uuid4().hex[:12])
    with psycopg.connect(server_url, autocommit=True) as connection:
        connection.execute(sql.SQL("create schema {}").format(name))
        try:
            connection.execute(sql.SQL("set search_path to {}").format(name))
            apply_schema(connection)
            for sender in ("mend-a", "mend-b"):
                connection.execute(
                    "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, payout_batch_id, status) "
                    "values (%s, 'c', 'h', %s, 'created')",
                    (sender, sender.upper().replace("-", "")),
                )
            yield connection
        finally:
            connection.execute(sql.SQL("drop schema {} cascade").format(name))


def record(conn: psycopg.Connection, seen: str, fee: int | None = 25, item: str = "ITEM1", batch: str = "mend-a"):
    return record_item_status(
        conn, payout_item_id=item, sender_batch_id=batch, sender_item_id="R1", seen=seen, fee_minor=fee
    )


def stored(conn: psycopg.Connection, item: str = "ITEM1") -> tuple:
    return conn.execute("select status, fee_minor from payout_items where payout_item_id = %s", (item,)).fetchone()


def test_a_verified_success_after_returned_leaves_it_returned(conn: psycopg.Connection) -> None:
    assert (record(conn, "PENDING").decision, stored(conn)) == ("new", ("PENDING", 25))
    assert record(conn, "UNCLAIMED").decision == "moved"
    assert record(conn, "RETURNED").decision == "moved"
    change = record(conn, "SUCCESS")
    assert (change.decision, change.previous, change.stored) == ("refused", "RETURNED", "RETURNED")
    assert stored(conn) == ("RETURNED", 25)


def test_an_unknown_status_is_stored_as_seen_and_a_missing_fee_keeps_the_stored_one(conn: psycopg.Connection) -> None:
    record(conn, "PENDING", fee=25)
    change = record(conn, "PROCESSING_LATER", fee=None)
    assert (change.decision, stored(conn)) == ("unchanged", ("PROCESSING_LATER", 25))
    assert record(conn, "SUCCESS", fee=30).decision == "moved" and stored(conn) == ("SUCCESS", 30)
    assert record(conn, "PENDING").decision == "refused" and stored(conn) == ("SUCCESS", 30)


def test_an_item_never_moves_to_another_batch_and_bad_input_writes_nothing(conn: psycopg.Connection) -> None:
    record(conn, "PENDING")
    with pytest.raises(ItemConflict):
        record(conn, "SUCCESS", batch="mend-b")
    with pytest.raises(ValueError):
        record(conn, "success", item="ITEM2")
    with pytest.raises(ValueError):
        record(conn, "SUCCESS", fee=-1, item="ITEM2")
    assert stored(conn) == ("PENDING", 25) and stored(conn, "ITEM2") is None
