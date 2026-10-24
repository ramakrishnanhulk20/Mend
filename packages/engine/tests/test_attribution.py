# Not covered here: matching a real purchase to a member (no live storefront yet, so
# nothing attributes one), the capture webhook that triggers a simulated attribution
# (test_events.py), and the live sandbox run (prove_m5).
import uuid
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

import pgserver
import psycopg
import pytest
from psycopg import sql

from mend_engine.campaigns.attribution import (
    WINDOW,
    attribute_purchase,
    attribution_window,
    simulated_order_for,
    submitted_at,
    utc_time,
)
from mend_engine.db.connect import PGDATA, SCHEMA_PATH

START = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)
TICK = timedelta(microseconds=1)


@pytest.fixture(scope="module")
def server_url() -> Iterator[str]:
    server = pgserver.get_server(PGDATA)
    yield server.get_uri()


@pytest.fixture
def conn(server_url: str) -> Iterator[psycopg.Connection]:
    name = sql.Identifier("m5_attr_" + uuid.uuid4().hex[:12])
    with psycopg.connect(server_url, autocommit=True) as connection:
        connection.execute(sql.SQL("create schema {}").format(name))
        try:
            connection.execute(sql.SQL("set search_path to {}").format(name))
            connection.execute(SCHEMA_PATH.read_text(encoding="utf-8"))
            yield connection
        finally:
            connection.execute(sql.SQL("drop schema {} cascade").format(name))


def campaign(conn: psycopg.Connection, route=("approved", "submitting", "submitted"), sent_at: datetime | None = START) -> uuid.UUID:
    """R1 rewarded, R2 held back. sent_at backdates the first move to submitted, as if it happened then."""
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
    if route[-1:] == ("submitted",) and sent_at is not None:
        conn.execute(
            "insert into campaign_status_moves (campaign_id, from_status, to_status, moved_at) values (%s, 'submitting', 'submitted', %s)",
            (campaign_id, sent_at),
        )
    return campaign_id


def buy(conn: psycopg.Connection, campaign_id: uuid.UUID, at: datetime, ref: str = "R1", order: str | None = None, **kw):
    return attribute_purchase(
        conn,
        campaign_id=campaign_id,
        ref=ref,
        purchased_at=at,
        amount_minor=kw.get("amount", 1250),
        simulated=kw.get("simulated", True),
        source_order=order or uuid.uuid4().hex[:17].upper(),
    )


def attributed(conn: psycopg.Connection) -> list[tuple]:
    return conn.execute("select ref, role, purchased_at, amount_minor, simulated from attributions order by attribution_id").fetchall()


def test_the_window_opens_at_the_first_move_to_submitted_and_lasts_30_days(conn: psycopg.Connection) -> None:
    campaign_id = campaign(conn)
    assert submitted_at(conn, campaign_id) == START
    assert attribution_window(conn, campaign_id) == (START, START + WINDOW) and WINDOW == timedelta(days=30)
    edges = [
        (START - TICK, False),
        (START, True),
        (START + WINDOW - TICK, True),
        (START + WINDOW, False),
    ]
    results = [buy(conn, campaign_id, at) for at, _inside in edges]
    assert [r.recorded for r in results] == [inside for _at, inside in edges]
    assert {r.reason for r in results if not r.recorded} == {"the purchase is outside the 30-day window"}
    assert [row[2] for row in attributed(conn)] == [START, START + WINDOW - TICK]


def test_bounds_are_compared_in_utc_whatever_zone_the_time_came_in(conn: psycopg.Connection) -> None:
    campaign_id = campaign(conn)
    india = timezone(timedelta(hours=5, minutes=30))
    # 17:29:59 in India is 11:59:59 UTC, one second before the window opens.
    assert not buy(conn, campaign_id, datetime(2026, 9, 1, 17, 29, 59, tzinfo=india)).recorded
    assert buy(conn, campaign_id, datetime(2026, 9, 1, 17, 30, 0, tzinfo=india)).recorded
    assert attributed(conn)[0][2] == START
    assert utc_time("2026-09-01T17:30:00+05:30") == START == utc_time("2026-09-01T12:00:00Z")
    for bad in ("2026-09-01T12:00:00", "2026-09-01", "", "x" * 41, None, 1693569600):
        with pytest.raises(ValueError):
            utc_time(bad)


def test_rewarded_and_held_back_members_go_through_the_same_function_with_their_own_role(conn: psycopg.Connection) -> None:
    campaign_id = campaign(conn)
    rewarded = buy(conn, campaign_id, START + timedelta(days=1), "R1")
    held = buy(conn, campaign_id, START + timedelta(days=2), "R2", simulated=False, amount=990)
    assert (rewarded.role, held.role) == ("reward", "holdout")
    assert [(r[0], r[1], r[3], r[4]) for r in attributed(conn)] == [("R1", "reward", 1250, True), ("R2", "holdout", 990, False)]
    assert conn.execute("select count(*) from audit_log where action = 'purchase_attributed'").fetchone()[0] == 2


def test_the_same_order_is_attributed_once(conn: psycopg.Connection) -> None:
    campaign_id = campaign(conn)
    first = buy(conn, campaign_id, START + timedelta(days=1), order="5O190127TN364715T")
    again = buy(conn, campaign_id, START + timedelta(days=1), order="5O190127TN364715T")
    assert first.recorded and (again.recorded, again.reason) == (False, "the purchase is already attributed")
    assert len(attributed(conn)) == 1


def test_a_campaign_never_sent_or_a_stranger_gets_nothing(conn: psycopg.Connection) -> None:
    stuck = campaign(conn, route=("approved", "submitting", "submission_unknown"))
    assert attribution_window(conn, stuck) is None
    assert buy(conn, stuck, datetime.now(timezone.utc)).reason == "the campaign was never sent"
    sent = campaign(conn)
    stranger = buy(conn, sent, START + timedelta(days=1), "R9")
    assert (stranger.recorded, stranger.reason) == (False, "the buyer is not a member of this campaign")
    assert attributed(conn) == []


@pytest.mark.parametrize(
    "change",
    [
        {"amount": 0},
        {"amount": 12.5},
        {"amount": True},
        {"simulated": 1},
    ],
)
def test_bad_values_are_refused_before_anything_is_read(conn: psycopg.Connection, change: dict) -> None:
    campaign_id = campaign(conn)
    with pytest.raises(ValueError):
        buy(conn, campaign_id, START + timedelta(days=1), **change)
    for kwargs in ({"ref": "r1"}, {"order": "has space"}):
        with pytest.raises(ValueError):
            buy(conn, campaign_id, START + timedelta(days=1), **kwargs)
    with pytest.raises(ValueError):
        buy(conn, campaign_id, datetime(2026, 9, 2, 12, 0))
    assert attributed(conn) == []


def test_a_simulated_order_is_found_only_by_the_order_id_this_server_stored(conn: psycopg.Connection) -> None:
    campaign_id = campaign(conn)
    stored, pending = uuid.uuid4(), uuid.uuid4()
    conn.execute(
        "insert into simulated_orders (simulated_order_id, paypal_order_id, campaign_id, ref) values (%s, 'ORDER1', %s, 'R2')",
        (stored, campaign_id),
    )
    conn.execute(
        "insert into simulated_orders (simulated_order_id, campaign_id, ref) values (%s, %s, 'R1')", (pending, campaign_id)
    )
    match = simulated_order_for(conn, "ORDER1")
    assert (match.simulated_order_id, match.campaign_id, match.ref) == (stored, campaign_id, "R2")
    # The custom_id a capture carries is our simulated order id; it never stands in for the stored order id.
    for other in (str(stored), str(pending), "ORDER2", "", None):
        assert simulated_order_for(conn, other) is None
