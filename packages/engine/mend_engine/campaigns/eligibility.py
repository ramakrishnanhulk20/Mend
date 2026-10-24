"""Who may be in a campaign: members whose shop history makes them quiet regulars (C28).

Only a member row makes someone a candidate, so a shop customer who never joined
can never be drafted. The member is linked to their shop history by email through
the one normaliser, and only when PayPal verified that email; the payout receiver
still comes only from the member row.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, datetime

import psycopg

from mend_engine.campaigns.scoring import ScoreSet
from mend_engine.members.membership import customer_refs_by_email
from mend_engine.paypal.payouts import normalise_email

REGULAR_MIN_DAYS = 3
SILENT_MIN_DAYS = 60


@dataclass(frozen=True)
class Candidate:
    member_id: uuid.UUID
    customer_ref: str
    score: float
    paid_minor: int


def quiet_regular_members(conn: psycopg.Connection, scores: ScoreSet, as_of: date) -> list[Candidate]:
    """Members who bought on 3 or more days and have been silent 60 or more days, most at risk first.

    scores must come from score_customers at this same as_of. Most at risk means
    fewest expected purchases over the next 13 weeks; equal scores fall back to
    customer_ref order so the ranking is repeatable. A member whose email PayPal has
    not verified, or that matches no shop customer or more than one, is not a
    candidate. Nor is one whose refunds cancel everything they paid: no reward may
    exceed what they paid net of refunds, so they could be paid nothing (C4).

    Raises ValueError if as_of is not a plain date, the scores were computed for a
    different day, or the scores did not converge.
    """
    if isinstance(as_of, datetime) or not isinstance(as_of, date):
        raise ValueError("as_of must be a date, not a datetime")
    if scores.as_of != as_of:
        raise ValueError("the scores were computed for a different day")
    if not scores.converged:
        raise ValueError("the model did not converge, so nobody can be ranked")
    refs = customer_refs_by_email(conn)
    candidates = []
    for member_id, email in conn.execute("select member_id, paypal_email from members where email_verified"):
        ref = refs.get(normalise_email(email))
        if ref is None or ref not in scores.scores:
            continue
        if scores.purchase_days[ref] < REGULAR_MIN_DAYS or scores.days_silent[ref] < SILENT_MIN_DAYS:
            continue
        if scores.paid_minor[ref] < 1:
            continue
        candidates.append(Candidate(member_id, ref, scores.scores[ref], scores.paid_minor[ref]))
    candidates.sort(key=lambda c: (c.score, c.customer_ref))
    return candidates
