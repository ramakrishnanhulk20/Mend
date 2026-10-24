"""Scores every shop customer's lapse risk from the shop's own order records.

BG/NBD is fitted on each customer's purchase days up to and including the as_of
day, then gives each customer's expected purchases over the next 13 weeks: the
fewer, the more at risk. Only shop records are read, never PayPal data (PLAN 3a).
Refunds lower what a customer has paid, never their purchase days.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone

import numpy as np
import psycopg

from mend_engine.model.bgnbd import expected_purchases, fit
from mend_engine.model.rfm import summarise

# The demo shop trades on the UK clock, the same clock the import shifted dates on,
# so a "purchase day" is a London calendar day.
from mend_engine.shop.import_orders import SOURCE_ZONE as SHOP_ZONE

HORIZON_WEEKS = 13
UNIT_DAYS = 7.0


@dataclass
class ScoreSet:
    """Each scored customer's numbers, keyed by customer_ref, as of one day.

    purchase_days, days_silent and paid_minor cover every customer who had bought
    by as_of. scores holds expected purchases over the next 13 weeks and is empty
    when converged is False; message then says why, and nobody may be ranked.
    paid_minor is what the customer paid the shop up to as_of minus their refunds up
    to as_of, in USD cents, never below 0 (paid_net_of_refunds). as_of travels with
    the numbers so they cannot be ranked against another day.
    """

    converged: bool
    message: str
    scores: dict[str, float]
    purchase_days: dict[str, int]
    days_silent: dict[str, int]
    paid_minor: dict[str, int]
    as_of: date


def _check_day(as_of: date) -> None:
    if isinstance(as_of, datetime) or not isinstance(as_of, date):
        raise ValueError("as_of must be a date, not a datetime")


def _end_of_day_utc(as_of: date) -> datetime:
    return datetime.combine(as_of + timedelta(days=1), time.min, tzinfo=SHOP_ZONE).astimezone(timezone.utc)


def paid_net_of_refunds(
    conn: psycopg.Connection, as_of: date, customer_refs: Sequence[str] | None = None
) -> dict[str, int]:
    """What each customer paid the shop by the end of the London day as_of, minus their refunds by then.

    In USD cents, never below 0. Covers every customer with an order by then, or
    only those in customer_refs. This is the one place a paid amount is worked
    out, so the draft and the approval re-check compare against the same number.

    Raises ValueError if as_of is not a plain date.
    """
    _check_day(as_of)
    end = _end_of_day_utc(as_of)
    only = "" if customer_refs is None else " and customer_ref = any(%s)"
    args: tuple = (end,) if customer_refs is None else (end, list(customer_refs))
    paid = dict(
        conn.execute(
            "select customer_ref, sum(total_minor) from shop_orders where ordered_at < %s and currency = 'USD'"
            + only
            + " group by customer_ref",
            args,
        )
    )
    refunded = dict(
        conn.execute(
            "select customer_ref, sum(amount_minor) from shop_refunds where refunded_at < %s" + only + " group by customer_ref",
            args,
        )
    )
    return {ref: max(int(total) - int(refunded.get(ref, 0)), 0) for ref, total in paid.items()}


def score_customers(conn: psycopg.Connection, as_of: date) -> ScoreSet:
    """Fit BG/NBD on every shop customer's purchase days up to as_of and score them.

    A purchase day is a London calendar day with at least one order from that
    customer, up to and including as_of. Uses the model's own convergence rule; a
    fit that does not converge, or that cannot run at all (nobody had bought by
    as_of), comes back with converged False and no scores, never a fallback.

    Raises ValueError if as_of is not a plain date.
    """
    _check_day(as_of)
    end = _end_of_day_utc(as_of)

    days: dict[str, set[date]] = {}
    rows = conn.execute(
        "select customer_ref, ordered_at from shop_orders where ordered_at < %s and currency = 'USD'", (end,)
    )
    for customer_ref, ordered_at in rows:
        days.setdefault(customer_ref, set()).add(ordered_at.astimezone(SHOP_ZONE).date())
    paid = paid_net_of_refunds(conn, as_of)

    purchase_days = {ref: len(seen) for ref, seen in days.items()}
    days_silent = {ref: (as_of - max(seen)).days for ref, seen in days.items()}
    unscored = ScoreSet(False, "", {}, purchase_days, days_silent, paid, as_of)

    summaries = summarise({ref: sorted(seen) for ref, seen in days.items()}, as_of, unit_days=UNIT_DAYS)
    if not summaries:
        unscored.message = f"not converged: nobody had bought by {as_of}"
        return unscored
    x = np.array([s.x for s in summaries], dtype=float)
    t_x = np.array([s.t_x for s in summaries])
    T = np.array([s.T for s in summaries])
    try:
        result = fit(x, t_x, T)
    except (ValueError, RuntimeError) as exc:
        unscored.message = f"not converged: the fit could not run ({exc})"
        return unscored
    if not result.converged:
        unscored.message = result.message
        return unscored
    expected = expected_purchases(result.params, float(HORIZON_WEEKS), x, t_x, T)
    scores = {summary.customer: float(value) for summary, value in zip(summaries, expected)}
    return ScoreSet(True, result.message, scores, purchase_days, days_silent, paid, as_of)
