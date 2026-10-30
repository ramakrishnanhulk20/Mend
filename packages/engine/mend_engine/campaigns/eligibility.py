"""Who may be in a campaign: members whose shop history makes them quiet regulars (C28).

Only a member row makes someone a candidate, so a shop customer who never joined
can never be drafted. The member is linked to their shop history by email through
the one normaliser, and only when PayPal verified that email and the member agreed
to a consent wording in ACCEPTED_CONSENT_VERSIONS; the payout receiver still comes
only from the member row.

A member is in one measurement at a time (C4, C6). A measurement starts at approval:
while an approved, in-flight or still-measuring campaign of the same scope holds them,
in either arm, they are not a candidate for another one. Drafts hold nobody, so two
drafts may share members, and approval refuses the second ("member_held").
The scope is the owner's campaigns for an owner draft and one demo session's own
campaigns for that session's draft (C19), so a visitor's toy campaign never shrinks
the owner's pool or another visitor's. An owner draft also never takes a member past
what they paid: every reward that left the shop for them in the last 365 days, plus
the new one, stays within what they paid net of every refund on record.
"""

from __future__ import annotations

import math
import re
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import date, datetime, timedelta

import psycopg

from mend_engine.campaigns.attribution import WINDOW as ATTRIBUTION_WINDOW
from mend_engine.campaigns.scoring import ScoreSet, net_of_later_refunds
from mend_engine.campaigns.spend import CAMPAIGN_VOIDED_SQL, ITEM_CAME_BACK_SQL, MONEY_BACK_STATUSES
from mend_engine.members.consent import ACCEPTED_CONSENT_VERSIONS
from mend_engine.members.membership import customer_refs_by_email
from mend_engine.paypal.payouts import normalise_email

REGULAR_MIN_DAYS = 3
SILENT_MIN_DAYS = 60
# On the shop's own history, pooled over the backtest's five converged cutoffs, about
# 1 in 10 quiet regulars scored below 0.1 came back within 13 weeks with no campaign,
# and about 6 in 10 scored 1.0 or more did. A nudge is wasted on both: the first
# rarely answers one, and the second mostly comes back without it.
LIKELY_GONE_BELOW = 0.1
LIKELY_BACK_FROM = 1.0
LIKELY_GONE = "likely_gone"
WORTH_A_NUDGE = "worth_a_nudge"
LIKELY_BACK = "likely_back"
REWARD_LOOKBACK = timedelta(days=365)

_SESSION_ID = re.compile(r"[0-9a-f]{64}", re.ASCII)

# When the campaign of row "c" was first sent: its first recorded move to submitted, or,
# for a campaign sent before moves were recorded, its earliest payout_batches row (the
# same fallback campaigns.spend counts money from). Null when it has neither.
_SENT_AT_SQL = (
    "coalesce((select min(s.moved_at) from campaign_status_moves s where s.campaign_id = c.campaign_id "
    "and s.to_status = 'submitted'), (select min(b.created_at) from payout_batches b where b.campaign_id = c.campaign_id::text))"
)
# Every member a campaign of the scope holds, in either arm. A measurement starts at
# approval, so a draft or a campaign awaiting approval holds nobody and an abandoned
# draft never locks anyone out; approval itself refuses a campaign whose member is held
# (approval.approve, "member_held"). A sent campaign holds until its attribution window
# closes, 30 days after it was first sent (campaigns.attribution), or for good with no
# send time on record. Every other status holds, one in flight or one added later
# included, so a new status fails closed.
_HELD_SQL = (
    "select distinct cm.member_id from campaign_members cm join campaigns c on c.campaign_id = cm.campaign_id "
    "left join campaign_owners o on o.campaign_id = c.campaign_id "
    "where cm.member_id is not null and {scope} and c.status not in ('draft', 'awaiting_approval', 'voided') "
    "and not (c.status in ('submitted', 'completed') and coalesce(" + _SENT_AT_SQL + " <= now() - %s, false))"
)
# The owner's campaigns are every campaign no demo session created, so one an operator
# script drafted with no owner row counts as the owner's.
_OWNER_CAMPAIGNS = "o.role is distinct from 'demo'"
_SESSION_CAMPAIGNS = "o.role = 'demo' and o.session_id = %s"
# Cents that left the shop for each receiver in the lookback, from every campaign
# whichever role made it, by batch rows written in that time. Voided campaigns and
# items whose money never left or came back are left out by the same two rules the
# shop's daily cap uses (campaigns.spend).
_SENT_SQL = (
    "select item ->> 'receiver_email', sum((item ->> 'amount_minor')::bigint) "
    "from approved_snapshots s cross join lateral jsonb_array_elements(s.canonical_json::jsonb -> 'items') item "
    "where exists (select 1 from payout_batches b where b.campaign_id = s.campaign_id::text and b.created_at > now() - %s) "
    "and not " + CAMPAIGN_VOIDED_SQL + " and not " + ITEM_CAME_BACK_SQL + " group by 1"
)


@dataclass(frozen=True)
class DraftScope:
    """Whose campaigns a new draft must not overlap: the owner's, or one demo session's.

    Raises ValueError unless role is "owner" with no session, or "demo" with a
    session id of 64 lowercase hex characters.
    """

    role: str
    session: str | None = None

    def __post_init__(self) -> None:
        owner = self.role == "owner" and self.session is None
        demo = self.role == "demo" and type(self.session) is str and _SESSION_ID.fullmatch(self.session) is not None
        if not (owner or demo):
            raise ValueError("a draft scope is the owner's, or one demo session's")


OWNER_SCOPE = DraftScope("owner")
# The scope build_draft drafts for when nothing says otherwise. The owner's is the
# default because it holds owner money to the 365-day line, so a caller that forgets
# to set a scope never gets a looser rule.
_SCOPE: ContextVar[DraftScope] = ContextVar("mend_draft_scope", default=OWNER_SCOPE)


@dataclass(frozen=True)
class Candidate:
    """paid_minor is the most a new reward may be for this member: what they paid net of
    refunds, less, for an owner draft, what already left the shop for them in 365 days."""

    member_id: uuid.UUID
    customer_ref: str
    score: float
    paid_minor: int


@contextmanager
def drafting_for(scope: DraftScope) -> Iterator[None]:
    """Make scope the one quiet_regular_members uses in this thread and context until the block ends.

    build_draft calls quiet_regular_members with no scope, so this is how a task
    drafts for the actor it checked. Raises ValueError if scope is not a DraftScope.
    """
    if not isinstance(scope, DraftScope):
        raise ValueError("scope must be a DraftScope")
    token = _SCOPE.set(scope)
    try:
        yield
    finally:
        _SCOPE.reset(token)


def forecast_group(score: float) -> str:
    """Which forecast group a score puts a customer in: LIKELY_GONE, WORTH_A_NUDGE or LIKELY_BACK.

    score is expected purchases over the next 13 weeks. Below LIKELY_GONE_BELOW is
    LIKELY_GONE, LIKELY_BACK_FROM or more is LIKELY_BACK, and everything between is
    WORTH_A_NUDGE. Raises ValueError for a bool, anything but an int or a float, NaN,
    an infinity or a negative score, so a broken score never lands in a group.
    """
    if isinstance(score, bool) or not isinstance(score, (int, float)):
        raise ValueError("a score must be a number")
    if not math.isfinite(score) or score < 0:
        raise ValueError("a score must be a finite number from 0 up")
    if score < LIKELY_GONE_BELOW:
        return LIKELY_GONE
    if score >= LIKELY_BACK_FROM:
        return LIKELY_BACK
    return WORTH_A_NUDGE


def nudge_order(paid_minor: int, customer_ref: str) -> tuple[int, str]:
    """The sort key that puts the biggest spender first and settles equal spend by customer_ref.

    paid_minor is what the customer paid to as_of net of refunds to as_of
    (ScoreSet.paid_minor), the number the console shows as "Spent", so the list and
    the draft rank by the same number.
    """
    return (-paid_minor, customer_ref)


def worth_a_nudge_refs(scores: ScoreSet) -> list[str]:
    """Every customer who bought on 3 or more days, has been silent 60 or more days and is worth a nudge, biggest spenders first.

    Reads the shop's records only, never members, so it is the whole group a member
    could be drafted from, in the order quiet_regular_members ranks it: nudge_order on
    scores.paid_minor, equal spend settled by customer_ref. Worth a nudge is
    forecast_group's WORTH_A_NUDGE, and a score forecast_group refuses raises
    ValueError. Raises ValueError if the scores did not converge.
    """
    if not scores.converged:
        raise ValueError("the model did not converge, so nobody can be ranked")
    worth = [
        ref
        for ref, score in scores.scores.items()
        if scores.purchase_days[ref] >= REGULAR_MIN_DAYS
        and scores.days_silent[ref] >= SILENT_MIN_DAYS
        and forecast_group(score) == WORTH_A_NUDGE
    ]
    return sorted(worth, key=lambda ref: nudge_order(scores.paid_minor[ref], ref))


def quiet_regular_members(
    conn: psycopg.Connection, scores: ScoreSet, as_of: date, scope: DraftScope | None = None
) -> list[Candidate]:
    """Members who bought on 3 or more days, have been silent 60 or more days and are worth a nudge, biggest spenders first.

    scores must come from score_customers at this same as_of. Worth a nudge means
    forecast_group puts the member's score in WORTH_A_NUDGE: from 0.1 up to, but not
    including, 1.0 expected purchases over the next 13 weeks. A member likely gone or
    likely back anyway is not a candidate, and a score forecast_group refuses raises
    ValueError. Biggest spender means most paid to as_of net of refunds to as_of
    (scores.paid_minor, the console's "Spent"), through nudge_order; equal spend falls
    back to customer_ref order so the ranking is repeatable. A member whose email
    PayPal has not verified, who agreed to no accepted consent wording, or whose email
    matches no shop customer or more than one, is not a candidate. Nor is one a campaign of
    scope still holds (scope, or the one drafting_for set, or the owner's), nor one
    with nothing left to be paid: no reward may exceed what they paid by as_of net
    of every refund recorded up to now (net_of_later_refunds), and for the owner's
    scope, what already left the shop for them in the last 365 days counts against
    that too (C4).

    Raises ValueError if as_of is not a plain date, the scores were computed for a
    different day, the scores did not converge, or scope is not a DraftScope.
    """
    if isinstance(as_of, datetime) or not isinstance(as_of, date):
        raise ValueError("as_of must be a date, not a datetime")
    if scores.as_of != as_of:
        raise ValueError("the scores were computed for a different day")
    if not scores.converged:
        raise ValueError("the model did not converge, so nobody can be ranked")
    scope = _SCOPE.get() if scope is None else scope
    if not isinstance(scope, DraftScope):
        raise ValueError("scope must be a DraftScope")
    refs = customer_refs_by_email(conn)
    held = held_members(conn, scope)
    regulars: list[tuple[uuid.UUID, str, str]] = []
    for member_id, email in conn.execute(
        "select member_id, paypal_email from members where email_verified and consent_version = any(%s)",
        (sorted(ACCEPTED_CONSENT_VERSIONS),),
    ):
        if member_id in held:
            continue
        ref = refs.get(normalise_email(email))
        if ref is None or ref not in scores.scores:
            continue
        if scores.purchase_days[ref] < REGULAR_MIN_DAYS or scores.days_silent[ref] < SILENT_MIN_DAYS:
            continue
        if forecast_group(scores.scores[ref]) != WORTH_A_NUDGE:
            continue
        regulars.append((member_id, normalise_email(email), ref))
    paid = net_of_later_refunds(conn, scores, [ref for _member_id, _email, ref in regulars])
    sent = sent_by_receiver(conn) if scope.role == "owner" else {}
    candidates = []
    for member_id, email, ref in regulars:
        room = paid[ref] - sent.get(email, 0)
        if room < 1:
            continue
        candidates.append(Candidate(member_id, ref, scores.scores[ref], room))
    candidates.sort(key=lambda c: nudge_order(scores.paid_minor.get(c.customer_ref, 0), c.customer_ref))
    return candidates


def held_members(conn: psycopg.Connection, scope: DraftScope) -> set[uuid.UUID]:
    """Every member a campaign of scope still holds, so no draft of that scope may take them (C6)."""
    if scope.role == "owner":
        rows = conn.execute(_HELD_SQL.format(scope=_OWNER_CAMPAIGNS), (ATTRIBUTION_WINDOW,))
    else:
        rows = conn.execute(_HELD_SQL.format(scope=_SESSION_CAMPAIGNS), (scope.session, ATTRIBUTION_WINDOW))
    return {member_id for (member_id,) in rows}


def sent_by_receiver(conn: psycopg.Connection) -> dict[str, int]:
    """Cents that left the shop in the last 365 days, keyed by receiver email after the one normaliser."""
    sent: dict[str, int] = {}
    for receiver, total in conn.execute(_SENT_SQL, (REWARD_LOOKBACK, list(MONEY_BACK_STATUSES))):
        key = normalise_email(receiver)
        sent[key] = sent.get(key, 0) + int(total)
    return sent
