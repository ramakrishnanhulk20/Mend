# Not covered here: the cap being checked at draft, approval and submission
# (test_drafts.py, test_approval.py, test_submission.py), and clocks that disagree
# between the engine and the database.
import uuid
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

import pgserver
import psycopg
import pytest
from psycopg import sql

from mend_engine.campaigns.spend import (
    DAILY_CAP_LOCK,
    CapExceeded,
    check_daily_cap,
    database_now,
    lock_daily_cap,
    spent_last_24h_minor,
)
from mend_engine.config import SANDBOX_API_HOST, Config
from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema
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
    daily_cap_minor=1000,
)


@pytest.fixture(scope="module")
def server_url() -> Iterator[str]:
    server = pgserver.get_server(PGDATA)
    yield server.get_uri()


@pytest.fixture
def conn(server_url: str) -> Iterator[psycopg.Connection]:
    schema = sql.Identifier("m4b_test_" + uuid.uuid4().hex[:12])
    with psycopg.connect(server_url, autocommit=True) as connection:
        connection.execute(sql.SQL("create schema {}").format(schema))
        try:
            connection.execute(sql.SQL("set search_path to {}").format(schema))
            apply_schema(connection)
            yield connection
        finally:
            connection.execute(sql.SQL("drop schema {} cascade").format(schema))


def approved(conn: psycopg.Connection, amounts: list[int]) -> tuple[uuid.UUID, BatchSnapshot]:
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 10000, 1000, 0.5, 'approved') returning campaign_id"
    ).fetchone()[0]
    items = tuple(PayoutItemSpec(f"m{n}@shop.example", amount, "Thanks", f"R{n}") for n, amount in enumerate(amounts, 1))
    snap = BatchSnapshot(str(campaign_id), "USD", "A thank-you", items)
    conn.execute(
        "insert into approved_snapshots values (%s, %s, %s, now(), 'owner')",
        (campaign_id, snapshot_hash(snap), canonical_json(snap)),
    )
    return campaign_id, snap


def reached_submitting(conn: psycopg.Connection, amounts: list[int], at: datetime) -> None:
    campaign_id, snap = approved(conn, amounts)
    conn.execute(
        "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, status, created_at) "
        "values (%s, %s, %s, 'created', %s)",
        (sender_batch_id_for(snap), str(campaign_id), snapshot_hash(snap), at),
    )


def test_spend_counts_each_campaign_that_reached_submitting_in_the_last_24_hours(conn: psycopg.Connection) -> None:
    now = database_now(conn)
    reached_submitting(conn, [100, 250], now - timedelta(hours=23, minutes=59))
    reached_submitting(conn, [400], now - timedelta(hours=24, seconds=1))
    reached_submitting(conn, [7], now + timedelta(minutes=1))
    approved(conn, [50])
    conn.execute(
        "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, status) "
        "values ('mend-m1', 'm1-proof-2026-10-20', 'x', 'SUCCESS')"
    )
    assert spent_last_24h_minor(conn, now) == 357
    assert spent_last_24h_minor(conn, now + timedelta(hours=24)) == 7


def test_the_cap_passes_exactly_at_the_limit_and_refuses_one_cent_over(conn: psycopg.Connection) -> None:
    now = datetime.now(timezone.utc)
    reached_submitting(conn, [357], now - timedelta(hours=1))
    check_daily_cap(conn, CONFIG, 643, now)
    with pytest.raises(CapExceeded, match="357 cents left the shop"):
        check_daily_cap(conn, CONFIG, 644, now)


@pytest.mark.parametrize("extra", [-1, True, 1.5, "10"])
def test_check_daily_cap_refuses_an_amount_that_is_not_whole_cents(conn: psycopg.Connection, extra: object) -> None:
    with pytest.raises(ValueError):
        check_daily_cap(conn, CONFIG, extra, datetime.now(timezone.utc))  # type: ignore[arg-type]


def test_now_must_carry_a_time_zone(conn: psycopg.Connection) -> None:
    with pytest.raises(ValueError):
        spent_last_24h_minor(conn, datetime(2026, 10, 20, 12, 0))


def test_the_daily_cap_lock_needs_a_transaction_and_holds_until_it_ends(conn: psycopg.Connection, server_url: str) -> None:
    with pytest.raises(RuntimeError):
        lock_daily_cap(conn)
    with psycopg.connect(server_url, autocommit=True) as other:
        with conn.transaction():
            lock_daily_cap(conn)
            assert other.execute("select pg_try_advisory_lock(%s)", (DAILY_CAP_LOCK,)).fetchone()[0] is False
        assert other.execute("select pg_try_advisory_lock(%s)", (DAILY_CAP_LOCK,)).fetchone()[0] is True
        other.execute("select pg_advisory_unlock(%s)", (DAILY_CAP_LOCK,))
