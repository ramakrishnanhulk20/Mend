# Not covered here: how statuses and attributions get in (test_events.py), real
# returns from a live storefront (none yet), and the results page that shows this.
import math
import uuid
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

import pgserver
import psycopg
import pytest
from psycopg import sql

from mend_engine.campaigns.attribution import attribute_purchase
from mend_engine.campaigns.results import TOO_EARLY, campaign_results, lift_p_value
from mend_engine.db.connect import PGDATA, SCHEMA_PATH
from mend_engine.paypal.payouts import BatchSnapshot, PayoutItemSpec, canonical_json, snapshot_hash


@pytest.fixture(scope="module")
def server_url() -> Iterator[str]:
    server = pgserver.get_server(PGDATA)
    yield server.get_uri()


@pytest.fixture
def conn(server_url: str) -> Iterator[psycopg.Connection]:
    name = sql.Identifier("m5_results_" + uuid.uuid4().hex[:12])
    with psycopg.connect(server_url, autocommit=True) as connection:
        connection.execute(sql.SQL("create schema {}").format(name))
        try:
            connection.execute(sql.SQL("set search_path to {}").format(name))
            connection.execute(SCHEMA_PATH.read_text(encoding="utf-8"))
            yield connection
        finally:
            connection.execute(sql.SQL("drop schema {} cascade").format(name))


def campaign(conn: psycopg.Connection, rewarded: int, held: int, sent_days_ago: int | None = 31) -> uuid.UUID:
    """Rewarded refs R1.. then held-back refs, sent sent_days_ago days back (None: never sent)."""
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 10000, 100, 0.5, 'draft') returning campaign_id"
    ).fetchone()[0]
    with conn.cursor() as cur:
        cur.executemany(
            "insert into campaign_members (campaign_id, ref, role, rank, score, amount_minor, note) values (%s, %s, %s, %s, 0.1, %s, %s)",
            [
                (campaign_id, f"R{n}", "reward" if n <= rewarded else "holdout", n,
                 100 * n if n <= rewarded else None, "Thanks" if n <= rewarded else None)
                for n in range(1, rewarded + held + 1)
            ],
        )
    if sent_days_ago is not None:
        for step in ("approved", "submitting", "submitted"):
            conn.execute("update campaigns set status = %s where campaign_id = %s", (step, campaign_id))
        conn.execute(
            "insert into campaign_status_moves (campaign_id, from_status, to_status, moved_at) "
            "values (%s, 'submitting', 'submitted', now() - make_interval(days => %s))",
            (campaign_id, sent_days_ago),
        )
    return campaign_id


def returns(conn: psycopg.Connection, campaign_id: uuid.UUID, refs: range, *, simulated: bool) -> None:
    for n in refs:
        result = attribute_purchase(
            conn,
            campaign_id=campaign_id,
            ref=f"R{n}",
            purchased_at=datetime.now(timezone.utc) - timedelta(days=2),
            amount_minor=1250,
            simulated=simulated,
            source_order=f"O{uuid.uuid4().hex[:16].upper()}",
        )
        assert result.recorded, result.reason


def test_the_p_value_matches_a_hand_checked_case() -> None:
    # 30 of 100 rewarded against 15 of 100 held back. Pooled rate 0.225, so
    # z = 0.15 / sqrt(0.225 * 0.775 * (1/100 + 1/100)) = 2.5400, and the one-sided
    # p-value is the normal tail beyond it, 0.5 * erfc(z / sqrt 2) = 0.00554.
    z = 0.15 / math.sqrt(0.225 * 0.775 * 0.02)
    assert round(z, 4) == 2.54
    assert lift_p_value(30, 100, 15, 100) == pytest.approx(0.5 * math.erfc(z / math.sqrt(2)), rel=1e-9)
    assert round(lift_p_value(30, 100, 15, 100), 5) == 0.00554
    assert lift_p_value(15, 100, 30, 100) == pytest.approx(1 - 0.00554, abs=1e-5)
    assert lift_p_value(0, 30, 0, 30) == lift_p_value(30, 30, 30, 30) == 0.5
    for bad in ((1, 0, 0, 5), (6, 5, 0, 5), (-1, 5, 0, 5), (1.0, 5, 0, 5)):
        with pytest.raises(ValueError):
            lift_p_value(*bad)


def test_simulated_returns_are_shown_apart_and_never_enter_the_rates(conn: psycopg.Connection) -> None:
    campaign_id = campaign(conn, 30, 30)
    returns(conn, campaign_id, range(1, 6), simulated=False)
    returns(conn, campaign_id, range(31, 36), simulated=False)
    before = campaign_results(conn, campaign_id)
    returns(conn, campaign_id, range(6, 26), simulated=True)
    returns(conn, campaign_id, range(36, 38), simulated=True)
    after = campaign_results(conn, campaign_id)
    assert (after.rewarded.members, after.holdout.members) == (30, 30)
    assert (after.rewarded.real_returns, after.holdout.real_returns) == (5, 5)
    assert (after.rewarded.simulated_returns, after.holdout.simulated_returns) == (20, 2)
    assert after.rewarded.real_rate == pytest.approx(5 / 30) and after.holdout.real_rate == pytest.approx(5 / 30)
    assert (after.p_value, after.verdict) == (before.p_value, before.verdict) == (0.5, "no measurable difference yet (one-sided p = 0.500)")


def test_a_clear_lift_with_30_per_arm_after_the_window_closes_is_called(conn: psycopg.Connection) -> None:
    campaign_id = campaign(conn, 30, 30)
    returns(conn, campaign_id, range(1, 16), simulated=False)
    returns(conn, campaign_id, range(31, 34), simulated=False)
    result = campaign_results(conn, campaign_id)
    assert not result.window_open and result.p_value == pytest.approx(lift_p_value(15, 30, 3, 30))
    assert result.p_value < 0.001 and result.verdict == "rewarded customers came back more (one-sided p < 0.001)"


@pytest.mark.parametrize(
    ("rewarded", "held", "sent_days_ago"),
    [(29, 30, 31), (30, 29, 31), (30, 30, 29), (30, 30, None)],
    ids=["29 rewarded", "29 held back", "window open", "never sent"],
)
def test_too_early_below_30_per_arm_or_while_the_window_is_open(
    conn: psycopg.Connection, rewarded: int, held: int, sent_days_ago: int | None
) -> None:
    campaign_id = campaign(conn, rewarded, held, sent_days_ago)
    if sent_days_ago is not None:
        returns(conn, campaign_id, range(1, 16), simulated=False)
    result = campaign_results(conn, campaign_id)
    assert result.verdict == TOO_EARLY
    assert result.window_open == (sent_days_ago != 31)
    assert result.p_value is not None


def test_spend_counts_success_and_pending_items_at_their_approved_amounts(conn: psycopg.Connection) -> None:
    campaign_id = campaign(conn, 6, 2, sent_days_ago=1)
    items = tuple(PayoutItemSpec(f"m{n}@shop.example", 100 * n, "Thanks", f"R{n}") for n in range(1, 7))
    snap = BatchSnapshot(str(campaign_id), "USD", "A thank-you", items)
    conn.execute(
        "insert into approved_snapshots values (%s, %s, %s, now(), 'owner')", (campaign_id, snapshot_hash(snap), canonical_json(snap))
    )
    conn.execute(
        "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, payout_batch_id, status) "
        "values ('mend-x', %s, 'h', 'BATCHX', 'created')",
        (str(campaign_id),),
    )
    statuses = [("R1", "SUCCESS", 25), ("R2", "PENDING", 25), ("R3", "UNCLAIMED", 25),
                ("R4", "PROCESSING_LATER", None), ("R5", "RETURNED", 25), ("R6", "FAILED", 0)]
    for n, (ref, status, fee) in enumerate(statuses, start=1):
        conn.execute(
            "insert into payout_items values (%s, 'mend-x', %s, %s, %s, now())", (f"ITEM{n}", ref, status, fee)
        )
    result = campaign_results(conn, campaign_id)
    # SUCCESS 100 + PENDING 200 + an unknown status counted as PENDING 400.
    assert (result.spend_minor, result.fees_minor) == (700, 100)
    assert (result.rewarded.members, result.holdout.members, result.verdict) == (6, 2, TOO_EARLY)


def test_an_unknown_campaign_is_refused(conn: psycopg.Connection) -> None:
    with pytest.raises(LookupError):
        campaign_results(conn, uuid.uuid4())
    with pytest.raises(ValueError):
        campaign_results(conn, "not-a-uuid")  # type: ignore[arg-type]
