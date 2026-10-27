"""The rolling daily cap: how much has left the shop in the last 24 hours (C4).

A campaign counts from the moment it reaches submitting, which is when its row in
the payout_batches ledger is written, for the total of its frozen snapshot. Counting
from that moment rather than from PayPal's answer means a batch whose outcome is
unknown still counts, so the cap errs towards spending less. An item stops counting
only once PayPal reports that its money never left the shop or came back to it, and
a whole campaign only once it is voided, which happens only when nothing could have
been sent.
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
# Money that never left the shop (FAILED, BLOCKED) or came back to it (RETURNED,
# REFUNDED). effective() keeps each of these as it is, so comparing stored text with
# them in SQL gives the answer effective() would give.
MONEY_BACK_STATUSES = ("FAILED", "BLOCKED", "RETURNED", "REFUNDED")
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


class CapExceeded(ValueError):
    """Spending this amount now would pass the rolling daily cap. Nothing was changed."""


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
    """Cents in every campaign that reached submitting in the 24 hours before now.

    A campaign reaches submitting when its payout_batches row is written, and its
    amount is the sum of the items in its approved snapshot, exactly what the batch
    carries, less each item PayPal has since reported FAILED, BLOCKED, RETURNED or
    REFUNDED. An item PayPal has not reported on yet, or reports as anything else,
    still counts. A voided campaign counts nothing (CAMPAIGN_VOIDED_SQL). A ledger
    row stamped later than now also counts, so a caller's clock running behind errs
    towards counting. Ledger rows with no approved snapshot (the M1 proof payouts)
    are not campaigns and are not counted.

    Raises ValueError if now carries no time zone.
    """
    if not isinstance(now, datetime) or now.utcoffset() is None:
        raise ValueError("now must be a datetime with a time zone")
    row = conn.execute(
        "select coalesce(sum((item ->> 'amount_minor')::bigint), 0) "
        "from approved_snapshots s cross join lateral jsonb_array_elements(s.canonical_json::jsonb -> 'items') item "
        "where exists (select 1 from payout_batches b where b.campaign_id = s.campaign_id::text and b.created_at > %s) "
        "and not " + CAMPAIGN_VOIDED_SQL + " and not " + ITEM_CAME_BACK_SQL,
        (now - WINDOW, list(MONEY_BACK_STATUSES)),
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
