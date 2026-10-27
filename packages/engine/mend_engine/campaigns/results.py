"""What a campaign achieved: rewarded members against the held-back ones (C6, C8).

Real returns and simulated returns are counted apart. Only real returns enter the
rates, the test and the verdict; simulated ones are shown beside them so a demo
can be seen working without its button presses passing for lift. Spend is the
amount of every item PayPal says is SUCCESS or still PENDING (an unknown status
counts as PENDING), priced from the frozen approved snapshot by sender_item_id.
The payouts block prices every item of the batch the same way and says where each
one stands, so a reward that failed, waits unclaimed or came back is shown plainly.
"""

from __future__ import annotations

import math
import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta

import psycopg
from scipy.stats import norm

from mend_engine.campaigns.approval import frozen_snapshot
from mend_engine.campaigns.attribution import attribution_window
from mend_engine.campaigns.spend import database_now
from mend_engine.events.payout_status import effective
from mend_engine.paypal.payouts import BatchSnapshot

MIN_PER_ARM = 30
SIGNIFICANCE = 0.05
TOO_EARLY = "too early to tell"
SPENT_STATUSES = ("SUCCESS", "PENDING")
CLAIMED_STATUSES = ("SUCCESS",)
UNCLAIMED_STATUSES = ("UNCLAIMED",)
RETURNED_STATUSES = ("RETURNED", "REFUNDED", "REVERSED")
FAILED_STATUSES = ("FAILED", "BLOCKED")
# PayPal returns an unclaimed payout to the shop by itself this long after sending it.
UNCLAIMED_RETURN_AFTER = timedelta(days=30)


@dataclass(frozen=True)
class PayoutStanding:
    """Where each item of the campaign's batch stands now, in USD cents at its approved amount.

    Realised first: claimed_minor (SUCCESS) is in the customer's PayPal account.
    Not realised: unclaimed_minor (UNCLAIMED) has left the shop's balance but waits
    for the customer to claim it, and pending_minor is every item not in another
    bucket, one PayPal has not reported on yet included. returned_minor (RETURNED,
    REFUNDED, REVERSED) came back to the shop; failed_minor (FAILED, BLOCKED) never
    left it.
    items counts the snapshot's items and by_status counts them by the status every
    decision reads (effective), so its keys are only ever PayPal's known statuses,
    with an unknown or missing status counted as PENDING. unclaimed_return_by is 30
    days after the earliest ledger row of a batch holding an UNCLAIMED item, when
    PayPal returns that money by itself, or None when nothing waits. Everything is
    zero, and by_status empty, until the campaign has a payout batch.
    """

    items: int
    by_status: dict[str, int]
    claimed_minor: int
    unclaimed_minor: int
    returned_minor: int
    failed_minor: int
    pending_minor: int
    unclaimed_return_by: datetime | None


@dataclass(frozen=True)
class ArmResults:
    """One arm. real_rate is real_returns / members, None for an empty arm; simulated_returns never enters it."""

    members: int
    real_returns: int
    real_rate: float | None
    simulated_returns: int


@dataclass(frozen=True)
class CampaignResults:
    """Money in USD cents. p_value is None unless both arms have a member; window times are UTC."""

    campaign_id: uuid.UUID
    status: str
    rewarded: ArmResults
    holdout: ArmResults
    spend_minor: int
    fees_minor: int
    window_starts_at: datetime | None
    window_ends_at: datetime | None
    window_open: bool
    p_value: float | None
    verdict: str
    payouts: PayoutStanding


def lift_p_value(rewarded_returns: int, rewarded: int, holdout_returns: int, holdout: int) -> float:
    """One-sided p-value that rewarded members return more often than held-back ones.

    The pooled two-proportion z-test. One-sided, because the question is whether the
    cashback brought customers back, not whether the arms differ either way. When
    nobody or everybody returned, the arms cannot differ and z is taken as 0.
    Raises ValueError unless each arm has at least 1 member and each count is a
    whole number from 0 up to its arm's size.
    """
    for returns, size in ((rewarded_returns, rewarded), (holdout_returns, holdout)):
        if type(returns) is not int or type(size) is not int or size < 1 or not 0 <= returns <= size:
            raise ValueError("each arm needs at least 1 member and a return count from 0 to its size")
    pooled = (rewarded_returns + holdout_returns) / (rewarded + holdout)
    spread = math.sqrt(pooled * (1 - pooled) * (1 / rewarded + 1 / holdout))
    z = 0.0 if spread == 0 else (rewarded_returns / rewarded - holdout_returns / holdout) / spread
    return float(norm.sf(z))


def campaign_results(conn: psycopg.Connection, campaign_id: uuid.UUID) -> CampaignResults:
    """The campaign's results as they stand now, by the database's clock.

    verdict is "too early to tell" while either arm has fewer than 30 members or
    the 30-day window has not closed (or never opened); after that, "rewarded
    customers came back more (one-sided p = ...)" when the one-sided p-value is
    below 0.05, else "no measurable difference yet (one-sided p = ...)".

    Raises ValueError for a campaign_id that is not a UUID, LookupError for no such
    campaign, and SnapshotRefused if the frozen snapshot no longer matches its hash.
    """
    if not isinstance(campaign_id, uuid.UUID):
        raise ValueError("campaign_id must be a UUID")
    row = conn.execute("select status from campaigns where campaign_id = %s", (campaign_id,)).fetchone()
    if row is None:
        raise LookupError("no such campaign")
    sizes = dict(
        conn.execute(
            "select role, count(*) from campaign_members where campaign_id = %s group by role", (campaign_id,)
        ).fetchall()
    )
    returns: dict[tuple[str, bool], int] = {
        (role, simulated): count
        for role, simulated, count in conn.execute(
            "select role, simulated, count(distinct ref) from attributions where campaign_id = %s group by role, simulated",
            (campaign_id,),
        )
    }
    rewarded = _arm(sizes.get("reward", 0), returns.get(("reward", False), 0), returns.get(("reward", True), 0))
    holdout = _arm(sizes.get("holdout", 0), returns.get(("holdout", False), 0), returns.get(("holdout", True), 0))
    snap = frozen_snapshot(conn, campaign_id)
    spend, fees = _spend_and_fees(conn, campaign_id, snap)

    window = attribution_window(conn, campaign_id)
    window_open = window is None or database_now(conn) < window[1]
    p_value = None
    if rewarded.members >= 1 and holdout.members >= 1:
        p_value = lift_p_value(rewarded.real_returns, rewarded.members, holdout.real_returns, holdout.members)
    if window_open or rewarded.members < MIN_PER_ARM or holdout.members < MIN_PER_ARM or p_value is None:
        verdict = TOO_EARLY
    elif p_value < SIGNIFICANCE:
        verdict = f"rewarded customers came back more ({_p_text(p_value)})"
    else:
        verdict = f"no measurable difference yet ({_p_text(p_value)})"
    return CampaignResults(
        campaign_id=campaign_id,
        status=row[0],
        rewarded=rewarded,
        holdout=holdout,
        spend_minor=spend,
        fees_minor=fees,
        window_starts_at=window[0] if window else None,
        window_ends_at=window[1] if window else None,
        window_open=window_open,
        p_value=p_value,
        verdict=verdict,
        payouts=_payout_standing(conn, campaign_id, snap),
    )


def _arm(members: int, real: int, simulated: int) -> ArmResults:
    return ArmResults(members, real, real / members if members else None, simulated)


def _payout_standing(conn: psycopg.Connection, campaign_id: uuid.UUID, snap: BatchSnapshot | None) -> PayoutStanding:
    batch = conn.execute("select 1 from payout_batches where campaign_id = %s", (str(campaign_id),)).fetchone()
    if snap is None or batch is None:
        return PayoutStanding(0, {}, 0, 0, 0, 0, 0, None)
    ledger: dict[str, list[tuple[str, datetime]]] = {}
    for sender_item_id, status, batch_created_at in conn.execute(
        "select i.sender_item_id, i.status, b.created_at from payout_items i "
        "join payout_batches b on b.sender_batch_id = i.sender_batch_id where b.campaign_id = %s",
        (str(campaign_id),),
    ):
        ledger.setdefault(sender_item_id, []).append((status, batch_created_at))
    by_status: Counter[str] = Counter()
    claimed = unclaimed = returned = failed = pending = 0
    waiting_since: datetime | None = None
    for item in snap.items:
        rows = ledger.get(item.sender_item_id, [])
        # The ledger holds one row per item; if it ever held two, neither is believed.
        status, batch_created_at = rows[0] if len(rows) == 1 else (None, None)
        current = effective(status)
        by_status[current] += 1
        if current in CLAIMED_STATUSES:
            claimed += item.amount_minor
        elif current in UNCLAIMED_STATUSES:
            unclaimed += item.amount_minor
            if waiting_since is None or batch_created_at < waiting_since:
                waiting_since = batch_created_at
        elif current in RETURNED_STATUSES:
            returned += item.amount_minor
        elif current in FAILED_STATUSES:
            failed += item.amount_minor
        else:
            pending += item.amount_minor
    return PayoutStanding(
        items=len(snap.items),
        by_status=dict(by_status),
        claimed_minor=claimed,
        unclaimed_minor=unclaimed,
        returned_minor=returned,
        failed_minor=failed,
        pending_minor=pending,
        unclaimed_return_by=waiting_since + UNCLAIMED_RETURN_AFTER if waiting_since is not None else None,
    )


def _spend_and_fees(conn: psycopg.Connection, campaign_id: uuid.UUID, snap: BatchSnapshot | None) -> tuple[int, int]:
    price = {item.sender_item_id: item.amount_minor for item in snap.items} if snap else {}
    spend = fees = 0
    for sender_item_id, status, fee_minor in conn.execute(
        "select i.sender_item_id, i.status, i.fee_minor from payout_items i "
        "join payout_batches b on b.sender_batch_id = i.sender_batch_id where b.campaign_id = %s",
        (str(campaign_id),),
    ):
        if effective(status) in SPENT_STATUSES:
            spend += price.get(sender_item_id, 0)
        fees += fee_minor or 0
    return spend, fees


def _p_text(p_value: float) -> str:
    return "one-sided p < 0.001" if p_value < 0.001 else f"one-sided p = {p_value:.3f}"
