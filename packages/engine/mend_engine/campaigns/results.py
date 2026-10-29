"""What a campaign achieved: rewarded members against the held-back ones (C6, C8, A9).

Real returns and simulated returns are counted apart. Only real returns enter the
rates, the test and the verdict; simulated ones are shown beside them so a demo
can be seen working without its button presses passing for lift.

The test is Fisher's exact test, one-sided, because at 30 members an arm a handful
of returns is common and the normal approximation then calls a lift where there is
none: 3 of 30 against 0 of 30 gave a z-test p of 0.038, and the exact p is 0.119.
A verdict also needs the window closed, 30 members an arm and at least 5 expected
returns an arm. Until then there is no verdict and no p-value at all, so no number
is shown for a test that has not earned one (6j).

Spend is the amount of every item PayPal says is SUCCESS or still PENDING (an
unknown status counts as PENDING), priced from the frozen approved snapshot by sender_item_id.
The payouts block prices every item of the batch the same way and says where each
one stands, so a reward that failed, waits unclaimed or came back is shown plainly.
The rows say the same for each customer on their own, by ref and the shop's synthetic
display name only, read from Mend's ledger and records and never from PayPal, so a
results read costs no PayPal call.
"""

from __future__ import annotations

import re
import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta

import psycopg
from scipy.stats import fisher_exact

from mend_engine.campaigns.approval import frozen_snapshot
from mend_engine.campaigns.attribution import attribution_window
from mend_engine.campaigns.spend import database_now
from mend_engine.events.payout_status import UNREADABLE, effective
from mend_engine.members.membership import SOURCE_SEED, customer_refs_by_email
from mend_engine.paypal.payouts import BatchSnapshot, normalise_email

MIN_PER_ARM = 30
MIN_EXPECTED_RETURNS = 5
SIGNIFICANCE = 0.05
TOO_EARLY = "too early to tell"
TOO_FEW = "too few returns to tell"
SPENT_STATUSES = ("SUCCESS", "PENDING")
CLAIMED_STATUSES = ("SUCCESS",)
UNCLAIMED_STATUSES = ("UNCLAIMED",)
RETURNED_STATUSES = ("RETURNED", "REFUNDED", "REVERSED")
FAILED_STATUSES = ("FAILED", "BLOCKED")
# PayPal returns an unclaimed payout to the shop by itself this long after sending it.
UNCLAIMED_RETURN_AFTER = timedelta(days=30)
# The shape the console accepts for a row's payout status (packages/web/src/server/runs.ts).
# The ledger can store PayPal's word at up to 36 characters, so a longer one is shown as
# UNKNOWN rather than failing the whole results answer at the console.
_SHOWN_STATUS = re.compile(r"[A-Z_]{1,32}", re.ASCII)


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
class RowStanding:
    """One campaign row, rewarded or held back: never a member, customer or PayPal identifier (C12, C15).

    display_name is display_names' rule: the shop's synthetic name for the row's
    customer, or None once its member left. payout_status is the reward's payout item status exactly as Mend's ledger stores
    it; None for a held-back row, whatever the ledger holds under its ref, and for a
    reward with no item in the ledger yet; UNKNOWN, the ledger's word for a status it
    cannot read, for an item stored twice or under a status that is not 1 to 32
    capital letters and underscores. stand_in is stand_in_refs' rule. simulated_return
    and real_return say whether a simulated or a real purchase is attributed to the
    row, kept apart as in ArmResults.
    """

    ref: str
    role: str
    rank: int
    display_name: str | None
    stand_in: bool
    payout_status: str | None
    simulated_return: bool
    real_return: bool


@dataclass(frozen=True)
class CampaignResults:
    """Money in USD cents. p_value is None until the verdict gate passes (see campaign_results); window times are UTC."""

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
    rows: tuple[RowStanding, ...]


def lift_p_value(rewarded_returns: int, rewarded: int, holdout_returns: int, holdout: int) -> float:
    """One-sided p-value that rewarded members return more often than held-back ones.

    Fisher's exact test on the two-by-two table of returned and not returned, with
    the alternative "greater": the chance, if the cashback did nothing, of the
    rewarded arm holding this many of the returns or more. One-sided, because the
    question is whether the cashback brought customers back, not whether the arms
    differ either way. When nobody or everybody returned, the arms cannot differ and
    the p-value is 1. Raises ValueError unless each arm has at least 1 member and
    each count is a whole number from 0 up to its arm's size.
    """
    for returns, size in ((rewarded_returns, rewarded), (holdout_returns, holdout)):
        if type(returns) is not int or type(size) is not int or size < 1 or not 0 <= returns <= size:
            raise ValueError("each arm needs at least 1 member and a return count from 0 to its size")
    table = [[rewarded_returns, rewarded - rewarded_returns], [holdout_returns, holdout - holdout_returns]]
    return float(fisher_exact(table, alternative="greater").pvalue)


def campaign_results(conn: psycopg.Connection, campaign_id: uuid.UUID) -> CampaignResults:
    """The campaign's results as they stand now, by the database's clock.

    The verdict gate opens only when the 30-day window has closed, each arm has 30
    or more members, and each arm would expect at least 5 real returns if the
    cashback did nothing (its size times the overall return rate). Until then
    verdict is "too early to tell" while the window is open, "too few returns to tell"
    once it has closed, and p_value is None. After that, verdict is
    "rewarded customers came back more (one-sided p = ...)" when Fisher's one-sided
    p-value is below 0.05, else "no measurable difference yet (one-sided p = ...)".

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
    if not window_open and _enough_to_test(rewarded, holdout):
        p_value = lift_p_value(rewarded.real_returns, rewarded.members, holdout.real_returns, holdout.members)
    if p_value is None:
        # A closed window with too few members or expected returns will not get more data.
        verdict = TOO_EARLY if window_open else TOO_FEW
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
        rows=_row_standings(conn, campaign_id),
    )


def stand_in_refs(conn: psycopg.Connection, campaign_id: uuid.UUID) -> frozenset[str]:
    """Refs of the campaign's rows whose member the demo seed script joined (members.source 'seed'), whom no person agreed to be.

    A row whose member left has no member and is not one of them: only people who
    joined can leave, never a stand-in (tasks.leave).
    """
    return frozenset(
        ref
        for (ref,) in conn.execute(
            "select cm.ref from campaign_members cm join members m on m.member_id = cm.member_id "
            "where cm.campaign_id = %s and m.source = %s",
            (campaign_id, SOURCE_SEED),
        )
    )


def display_names(conn: psycopg.Connection, campaign_id: uuid.UUID) -> dict[str, str | None]:
    """Each row's customer's synthetic display name (shop_customers), the name the quiet regulars list shows, by ref.

    The customer is the one a verified member's email matches by the one email
    normaliser, as eligibility matched them when the campaign was drafted. A row
    whose member left has no member (its member_id is emptied once the campaign is
    past approval) and maps to None, as would a member whose email no longer matches
    exactly one shop customer. The name is never rebuilt from the snapshot's
    receiver, so nobody who left is named again (C28).
    """
    emails = conn.execute(
        "select cm.ref, m.paypal_email from campaign_members cm "
        "left join members m on m.member_id = cm.member_id and m.email_verified where cm.campaign_id = %s",
        (campaign_id,),
    ).fetchall()
    refs = customer_refs_by_email(conn)
    customer_of = {ref: refs.get(normalise_email(email)) if email is not None else None for ref, email in emails}
    wanted = sorted({customer for customer in customer_of.values() if customer is not None})
    names = dict(conn.execute("select customer_ref, display_name from shop_customers where customer_ref = any(%s)", (wanted,)))
    return {ref: names.get(customer) if customer is not None else None for ref, customer in customer_of.items()}


def _row_standings(conn: psycopg.Connection, campaign_id: uuid.UUID) -> tuple[RowStanding, ...]:
    """Every row of the campaign in rank order, as RowStanding says."""
    stand_ins = stand_in_refs(conn, campaign_id)
    names = display_names(conn, campaign_id)
    # A payout item's sender_item_id is its row's ref (approval.current_snapshot).
    ledger: dict[str, list[str]] = {}
    for sender_item_id, status in conn.execute(
        "select i.sender_item_id, i.status from payout_items i "
        "join payout_batches b on b.sender_batch_id = i.sender_batch_id where b.campaign_id = %s",
        (str(campaign_id),),
    ):
        ledger.setdefault(sender_item_id, []).append(status)
    returned = set(conn.execute("select distinct ref, simulated from attributions where campaign_id = %s", (campaign_id,)).fetchall())
    rows = conn.execute(
        "select ref, role, rank from campaign_members where campaign_id = %s order by rank", (campaign_id,)
    ).fetchall()
    return tuple(
        RowStanding(
            ref=ref,
            role=role,
            rank=rank,
            display_name=names.get(ref),
            stand_in=ref in stand_ins,
            payout_status=_shown_status(ledger.get(ref, [])) if role == "reward" else None,
            simulated_return=(ref, True) in returned,
            real_return=(ref, False) in returned,
        )
        for ref, role, rank in rows
    )


def _shown_status(stored: list[str]) -> str | None:
    if not stored:
        return None
    # The ledger holds one row per item; if it ever held two, neither is believed, as in _payout_standing.
    if len(stored) == 1 and _SHOWN_STATUS.fullmatch(stored[0]):
        return stored[0]
    return UNREADABLE


def _arm(members: int, real: int, simulated: int) -> ArmResults:
    return ArmResults(members, real, real / members if members else None, simulated)


def _enough_to_test(rewarded: ArmResults, holdout: ArmResults) -> bool:
    if rewarded.members < MIN_PER_ARM or holdout.members < MIN_PER_ARM:
        return False
    # The smaller arm expects the fewest returns: size * returns / members, kept in
    # whole numbers so the boundary at exactly 5 is not lost to rounding.
    returns = rewarded.real_returns + holdout.real_returns
    members = rewarded.members + holdout.members
    return min(rewarded.members, holdout.members) * returns >= MIN_EXPECTED_RETURNS * members


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
