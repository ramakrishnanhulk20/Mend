# Not covered here: how statuses and attributions get in (test_events.py), real
# returns from a live storefront (none yet), the results page that shows this,
# PayPal's own 30-day clock, which may start a little after our ledger row is written,
# and whether 30 members per arm can detect a lift of any given size (power).
import math
import uuid
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

import pgserver
import psycopg
import pytest
from psycopg import sql

from mend_engine.campaigns.attribution import attribute_purchase
from mend_engine.campaigns.results import TOO_EARLY, TOO_FEW, PayoutStanding, campaign_results, lift_p_value
from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema
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
            apply_schema(connection)
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


def test_the_p_value_is_fishers_exact_test_checked_by_hand() -> None:
    # 3 of 30 rewarded came back and none of 30 held back. Given 3 returns among the
    # 60, the chance all 3 land in the rewarded arm is C(30, 3) / C(60, 3) = 4060 / 34220.
    assert lift_p_value(3, 30, 0, 30) == pytest.approx(4060 / 34220, rel=1e-12)
    # 30 of 100 against 15 of 100: the hypergeometric tail from 30 up, summed by hand.
    tail = sum(math.comb(100, k) * math.comb(100, 45 - k) for k in range(30, 46)) / math.comb(200, 45)
    assert round(tail, 5) == 0.00857
    assert lift_p_value(30, 100, 15, 100) == pytest.approx(tail, rel=1e-9)
    assert lift_p_value(15, 100, 30, 100) == pytest.approx(0.99683, abs=1e-5)
    assert lift_p_value(0, 30, 0, 30) == lift_p_value(30, 30, 30, 30) == 1.0
    for bad in ((1, 0, 0, 5), (6, 5, 0, 5), (-1, 5, 0, 5), (1.0, 5, 0, 5)):
        with pytest.raises(ValueError):
            lift_p_value(*bad)


@pytest.mark.parametrize("rewarded_back", [3, 5], ids=["3 of 30 against 0 of 30", "5 of 30 against 0 of 30"])
def test_a_few_returns_against_none_are_not_called_a_lift(conn: psycopg.Connection, rewarded_back: int) -> None:
    # The old z-test called 3 against 0 a lift (one-sided p = 0.038); Fisher's exact
    # test gives 0.119. 5 against 0 passes Fisher (0.026), but 5 returns among 60
    # members is 2.5 expected per arm, under the 5 a verdict needs.
    campaign_id = campaign(conn, 30, 30)
    returns(conn, campaign_id, range(1, rewarded_back + 1), simulated=False)
    result = campaign_results(conn, campaign_id)
    assert not result.window_open and (result.rewarded.real_returns, result.holdout.real_returns) == (rewarded_back, 0)
    assert (result.verdict, result.p_value) == (TOO_FEW, None)


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
    # 10 returns among 60 members is exactly 5 expected per arm, so the verdict gate opens.
    assert (after.p_value, after.verdict) == (before.p_value, before.verdict)
    assert after.p_value == pytest.approx(lift_p_value(5, 30, 5, 30)) and round(after.p_value, 3) == 0.635
    assert after.verdict == "no measurable difference yet (one-sided p = 0.635)"


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
    assert result.window_open == (sent_days_ago != 31)
    assert result.verdict == (TOO_EARLY if result.window_open else TOO_FEW)
    assert result.p_value is None


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


def test_the_payouts_block_puts_each_item_in_its_bucket_at_its_approved_amount(conn: psycopg.Connection) -> None:
    campaign_id = campaign(conn, 10, 2, sent_days_ago=1)
    items = tuple(PayoutItemSpec(f"m{n}@shop.example", 100 * n, "Thanks", f"R{n}") for n in range(1, 11))
    snap = BatchSnapshot(str(campaign_id), "USD", "A thank-you", items)
    conn.execute(
        "insert into approved_snapshots values (%s, %s, %s, now(), 'owner')", (campaign_id, snapshot_hash(snap), canonical_json(snap))
    )
    sent_at = datetime(2026, 10, 20, 9, 30, tzinfo=timezone.utc)
    conn.execute(
        "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, payout_batch_id, status, created_at) "
        "values ('mend-p', %s, 'h', 'BATCHP', 'created', %s)",
        (str(campaign_id), sent_at),
    )
    # R10 has no ledger row: PayPal has not reported on it yet.
    statuses = ["SUCCESS", "PENDING", "UNCLAIMED", "ONHOLD", "FAILED", "BLOCKED", "RETURNED", "REFUNDED", "PROCESSING_LATER"]
    for n, status in enumerate(statuses, start=1):
        conn.execute("insert into payout_items values (%s, 'mend-p', %s, %s, 25, now())", (f"ITEM{n}", f"R{n}", status))

    result = campaign_results(conn, campaign_id)

    assert result.payouts == PayoutStanding(
        items=10,
        by_status={"SUCCESS": 1, "PENDING": 3, "UNCLAIMED": 1, "ONHOLD": 1, "FAILED": 1, "BLOCKED": 1, "RETURNED": 1, "REFUNDED": 1},
        claimed_minor=100,
        unclaimed_minor=300,
        returned_minor=700 + 800,
        failed_minor=500 + 600,
        pending_minor=200 + 400 + 900 + 1000,
        unclaimed_return_by=sent_at + timedelta(days=30),
    )
    # The existing keys keep their meaning: SUCCESS, PENDING and the unknown status counted as PENDING.
    assert (result.spend_minor, result.fees_minor) == (100 + 200 + 900, 9 * 25)
    assert (result.rewarded.members, result.holdout.members, result.verdict) == (10, 2, TOO_EARLY)


def test_a_reversed_item_counts_as_money_back_and_not_as_spend(conn: psycopg.Connection) -> None:
    campaign_id = campaign(conn, 2, 2, sent_days_ago=1)
    items = (PayoutItemSpec("m1@shop.example", 100, "Thanks", "R1"), PayoutItemSpec("m2@shop.example", 200, "Thanks", "R2"))
    snap = BatchSnapshot(str(campaign_id), "USD", "A thank-you", items)
    conn.execute(
        "insert into approved_snapshots values (%s, %s, %s, now(), 'owner')", (campaign_id, snapshot_hash(snap), canonical_json(snap))
    )
    conn.execute(
        "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, payout_batch_id, status) "
        "values ('mend-v', %s, 'h', 'BATCHV', 'created')",
        (str(campaign_id),),
    )
    conn.execute("insert into payout_items values ('ITEM1', 'mend-v', 'R1', 'SUCCESS', 25, now()), ('ITEM2', 'mend-v', 'R2', 'REVERSED', 25, now())")

    result = campaign_results(conn, campaign_id)

    assert (result.payouts.by_status, result.payouts.returned_minor, result.payouts.pending_minor) == ({"SUCCESS": 1, "REVERSED": 1}, 200, 0)
    assert result.spend_minor == 100


def test_the_payouts_block_is_empty_before_a_batch_and_has_no_return_date_when_nothing_waits(conn: psycopg.Connection) -> None:
    campaign_id = campaign(conn, 2, 2, sent_days_ago=None)
    items = (PayoutItemSpec("m1@shop.example", 100, "Thanks", "R1"), PayoutItemSpec("m2@shop.example", 200, "Thanks", "R2"))
    snap = BatchSnapshot(str(campaign_id), "USD", "A thank-you", items)
    conn.execute(
        "insert into approved_snapshots values (%s, %s, %s, now(), 'owner')", (campaign_id, snapshot_hash(snap), canonical_json(snap))
    )
    assert campaign_results(conn, campaign_id).payouts == PayoutStanding(0, {}, 0, 0, 0, 0, 0, None)

    conn.execute(
        "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, status) values ('mend-q', %s, 'h', 'created')",
        (str(campaign_id),),
    )
    conn.execute("insert into payout_items values ('ITEM1', 'mend-q', 'R1', 'RETURNED', 25, now())")
    standing = campaign_results(conn, campaign_id).payouts
    assert (standing.by_status, standing.returned_minor, standing.pending_minor, standing.unclaimed_return_by) == (
        {"RETURNED": 1, "PENDING": 1}, 100, 200, None,
    )


def test_an_unknown_campaign_is_refused(conn: psycopg.Connection) -> None:
    with pytest.raises(LookupError):
        campaign_results(conn, uuid.uuid4())
    with pytest.raises(ValueError):
        campaign_results(conn, "not-a-uuid")  # type: ignore[arg-type]
