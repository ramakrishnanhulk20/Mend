# Not covered here: the scheduler that runs the purge (Render cron, later), the
# web receiver that sets purge_after (packages/web tests), and two purges at once,
# which is harmless because a row can only be deleted once.
import uuid
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

import pgserver
import psycopg
import pytest
from psycopg import sql

from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema
from mend_engine.maintenance.purge import purge_paypal_events


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


def event(conn: psycopg.Connection, name: str, hours_ago: float) -> None:
    # The web receiver's rule: purge_after is exactly 48 hours after receipt.
    conn.execute(
        "insert into paypal_events (transmission_id, event_id, event_type, received_at, purge_after, raw) "
        "values (%s, %s, 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', now() - make_interval(secs => %s), "
        "now() - make_interval(secs => %s) + interval '48 hours', '{}')",
        (name, "WH-" + name, hours_ago * 3600, hours_ago * 3600),
    )


def kept(conn: psycopg.Connection) -> list[str]:
    return [r[0] for r in conn.execute("select transmission_id from paypal_events order by 1")]


def purges(conn: psycopg.Connection) -> list[tuple]:
    return conn.execute("select actor, detail from audit_log where action = 'paypal_events_purged' order by id").fetchall()


def test_rows_past_48_hours_are_deleted_and_younger_rows_kept(conn: psycopg.Connection) -> None:
    event(conn, "old-49h", 49)
    event(conn, "old-48h-1m", 48 + 1 / 60)
    event(conn, "new-47h", 47)
    event(conn, "new-now", 0)
    assert purge_paypal_events(conn) == 2
    assert kept(conn) == ["new-47h", "new-now"]
    assert purges(conn) == [("purge", {"deleted": 2})]
    index = conn.execute(
        "select indexdef from pg_indexes where tablename = 'paypal_events' and indexname = 'paypal_events_purge_after'"
    ).fetchone()
    assert index is not None and index[0].endswith("(purge_after)")


def test_a_run_with_nothing_to_delete_is_still_on_record(conn: psycopg.Connection) -> None:
    event(conn, "new-1h", 1)
    assert purge_paypal_events(conn) == 0 and kept(conn) == ["new-1h"]
    assert purges(conn) == [("purge", {"deleted": 0})]


def test_an_explicit_now_is_used_and_must_carry_a_time_zone(conn: psycopg.Connection) -> None:
    event(conn, "new-1h", 1)
    with pytest.raises(ValueError):
        purge_paypal_events(conn, datetime(2030, 1, 1))
    assert kept(conn) == ["new-1h"] and purges(conn) == []
    assert purge_paypal_events(conn, datetime.now(timezone.utc) + timedelta(hours=48)) == 1
    assert kept(conn) == []
