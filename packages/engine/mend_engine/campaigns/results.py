"""What a campaign achieved: rewarded members against the held-back ones (C6, C8).

Real returns and simulated returns are counted apart. Only real returns enter the
rates, the test and the verdict; simulated ones are shown beside them so a demo
can be seen working without its button presses passing for lift. Spend is the
amount of every item PayPal says is SUCCESS or still PENDING (an unknown status
counts as PENDING), priced from the frozen approved snapshot by sender_item_id.
"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass
from datetime import datetime

import psycopg
from scipy.stats import norm

from mend_engine.campaigns.approval import frozen_snapshot
from mend_engine.campaigns.attribution import attribution_window
from mend_engine.campaigns.spend import database_now
from mend_engine.events.payout_status import effective

MIN_PER_ARM = 30
SIGNIFICANCE = 0.05
TOO_EARLY = "too early to tell"
SPENT_STATUSES = ("SUCCESS", "PENDING")


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
    spend, fees = _spend_and_fees(conn, campaign_id)

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
    )


def _arm(members: int, real: int, simulated: int) -> ArmResults:
    return ArmResults(members, real, real / members if members else None, simulated)


def _spend_and_fees(conn: psycopg.Connection, campaign_id: uuid.UUID) -> tuple[int, int]:
    snap = frozen_snapshot(conn, campaign_id)
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
