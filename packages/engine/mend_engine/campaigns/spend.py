"""The rolling daily cap: how much has left the shop in the last 24 hours (C4).

A campaign counts from its latest move into submitting, for the total of its frozen
snapshot. Its first move is when its row in the payout_batches ledger is written;
every reconcile resend is a later one, and money can leave on a resend, so a
campaign resent 25 hours after its first claim counts again from the resend.
Counting from the claim rather than from PayPal's answer means a batch whose
outcome is unknown still counts, so the cap errs towards spending less. An item
stops counting only once PayPal reports that its money never left the shop or came
back to it, and a whole campaign only once it is voided, which happens only when
nothing could have been sent. The demo pool counts the campaigns demo sessions
created by the same rule.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import psycopg
from psycopg.pq import TransactionStatus

from mend_engine.config import Config

WINDOW = timedelta(hours=24)
# Any fixed number works, as long as every check made just before money moves
# takes this same one, so two campaigns cannot both pass on the same headroom.
DAILY_CAP_LOCK = 7731300002
# The demo pool and the lock every demo send takes before checking it. tasks.py holds
# the same two numbers and a test holds them equal, so a resend and a first send take
# the same lock and are held to the same pool.
DEMO_DAILY_CAP_MINOR = 5000
DEMO_SPEND_LOCK = 7731300005
# Money that never left the shop (FAILED, BLOCKED) or came back to it (RETURNED,
# REFUNDED, REVERSED). effective() keeps each of these as it is, so comparing stored
# text with them in SQL gives the answer effective() would give.
MONEY_BACK_STATUSES = ("FAILED", "BLOCKED", "RETURNED", "REFUNDED", "REVERSED")
# True for a snapshot item ("item", from approved snapshot "s") whose every ledger row
# holds one of MONEY_BACK_STATUSES, its one parameter. With no row yet, or any other
# status, it is false and the item counts. Shared so the shop's cap and the demo pool
# count by the same rule.
ITEM_CAME_BACK_SQL = (
    "coalesce((select bool_and(i.status = any(%s)) from payout_items i "
    "join payout_batches b on b.sender_batch_id = i.sender_batch_id "
    "where b.campaign_id = s.campaign_id::text and i.sender_item_id = item ->> 'sender_item_id'), false)"
)
# True when the campaign of row "s" (any row with a campaign_id) is voided. The status
# guard lets a campaign be voided only before it is sent, or from submitting when PayPal
# cannot hold a batch for it (a refusal with nothing ambiguous, a snapshot the payout
# rules refuse, a member who left before the first send), so no money of a voided
# campaign ever left. With no campaigns row it is false and the campaign counts. Shared so the
# shop's cap, the demo pool and a demo session's sends leave out the same campaigns.
CAMPAIGN_VOIDED_SQL = "exists (select 1 from campaigns c where c.campaign_id = s.campaign_id and c.status = 'voided')"
# When ledger row "b" of the campaign of row "s" last moved into submitting. A campaign
# with no recorded move predates the record of moves, so its ledger row's own time is
# used: greatest() skips a null and otherwise keeps the later time, so a lost record
# errs towards counting.
COUNTED_FROM_SQL = (
    "greatest(b.created_at, (select max(m.moved_at) from campaign_status_moves m "
    "where m.campaign_id = s.campaign_id and m.to_status = 'submitting'))"
)
# True when the campaign of row "s" has a ledger row counted from after its one
# parameter, a time. Shared so the shop's cap, the demo pool and the balance room all
# count a resend from the same moment.
CLAIMED_SINCE_SQL = (
    "exists (select 1 from payout_batches b where b.campaign_id = s.campaign_id::text and " + COUNTED_FROM_SQL + " > %s)"
)
_SPENT_SQL = (
    "select coalesce(sum((item ->> 'amount_minor')::bigint), 0) "
    "from approved_snapshots s {only} cross join lateral jsonb_array_elements(s.canonical_json::jsonb -> 'items') item "
    "where " + CLAIMED_SINCE_SQL + " and not " + CAMPAIGN_VOIDED_SQL + " and not " + ITEM_CAME_BACK_SQL
)
_DEMO_ONLY = "join campaign_owners o on o.campaign_id = s.campaign_id and o.role = 'demo'"


class CapExceeded(ValueError):
    """Spending this amount now would pass the rolling daily cap. Nothing was changed."""


class DemoPoolExceeded(CapExceeded):
    """Demo campaigns spending this amount now would pass the shared demo pool. Nothing was changed."""


def database_now(conn: psycopg.Connection) -> datetime:
    """The database's clock, the same clock that stamps each ledger row's created_at."""
    return conn.execute("select now()").fetchone()[0]


def lock_daily_cap(conn: psycopg.Connection) -> None:
    """Take the daily-cap lock until the current transaction ends.

    Raises RuntimeError outside a transaction, where the lock would end at once.
    """
    if conn.info.transaction_status != TransactionStatus.INTRANS:
        raise RuntimeError("the daily-cap lock needs an open transaction")
    conn.execute("select pg_advisory_xact_lock(%s)", (DAILY_CAP_LOCK,))


def spent_last_24h_minor(conn: psycopg.Connection, now: datetime) -> int:
    """Cents in every campaign whose latest move into submitting was in the 24 hours before now.

    A campaign with a payout_batches row counts from its latest move into
    submitting (COUNTED_FROM_SQL): its first claim, or a reconcile resend after
    it. Its amount is the sum of the items in its approved snapshot, exactly what
    the batch carries, less each item PayPal has since reported FAILED, BLOCKED,
    RETURNED, REFUNDED or REVERSED. An item PayPal has not reported on yet, or
    reports as anything else, still counts. A voided campaign counts nothing
    (CAMPAIGN_VOIDED_SQL). A claim stamped later than now also counts, so a
    caller's clock running behind errs towards counting. Ledger rows with no
    approved snapshot (the M1 proof payouts) are not campaigns and are not counted.

    Raises ValueError if now carries no time zone.
    """
    if not isinstance(now, datetime) or now.utcoffset() is None:
        raise ValueError("now must be a datetime with a time zone")
    row = conn.execute(_SPENT_SQL.format(only=""), (now - WINDOW, list(MONEY_BACK_STATUSES))).fetchone()
    return int(row[0])


def demo_spent_last_24h_minor(conn: psycopg.Connection) -> int:
    """Cents in every demo-created campaign whose latest move into submitting was in the last 24 hours.

    Counted exactly as spent_last_24h_minor counts the shop's own cap, by the
    database's clock, limited to campaigns a demo session created: a voided
    campaign counts nothing, an item PayPal reports FAILED, BLOCKED, RETURNED,
    REFUNDED or REVERSED stops counting, and one with no status yet still counts.
    """
    row = conn.execute(
        _SPENT_SQL.format(only=_DEMO_ONLY), (database_now(conn) - WINDOW, list(MONEY_BACK_STATUSES))
    ).fetchone()
    return int(row[0])


def check_daily_cap(conn: psycopg.Connection, config: Config, extra_minor: int, now: datetime) -> None:
    """Raise CapExceeded if spending extra_minor more at now would pass config.daily_cap_minor.

    Passes when spent_last_24h_minor(conn, now) + extra_minor equals the cap
    exactly. Raises ValueError for an extra_minor that is not a whole number of
    cents from 0 up, or a now without a time zone.
    """
    if type(extra_minor) is not int or extra_minor < 0:
        raise ValueError("extra_minor must be whole cents from 0 up")
    spent = spent_last_24h_minor(conn, now)
    if spent + extra_minor > config.daily_cap_minor:
        raise CapExceeded(
            f"{spent} cents left the shop in the last 24 hours; {extra_minor} more would pass "
            f"the daily cap of {config.daily_cap_minor} cents"
        )


def check_demo_pool(conn: psycopg.Connection, extra_minor: int) -> None:
    """Raise DemoPoolExceeded if demo campaigns spending extra_minor more now would pass DEMO_DAILY_CAP_MINOR.

    Passes when demo_spent_last_24h_minor(conn) + extra_minor equals the pool
    exactly. The caller must hold DEMO_SPEND_LOCK until its claim is committed, so
    two demo sends cannot both fit in the same headroom. Raises ValueError for an
    extra_minor that is not a whole number of cents from 0 up.
    """
    if type(extra_minor) is not int or extra_minor < 0:
        raise ValueError("extra_minor must be whole cents from 0 up")
    spent = demo_spent_last_24h_minor(conn)
    if spent + extra_minor > DEMO_DAILY_CAP_MINOR:
        raise DemoPoolExceeded(
            f"demo campaigns spent {spent} cents in 24 hours; {extra_minor} more would pass "
            f"the demo pool of {DEMO_DAILY_CAP_MINOR} cents"
        )
