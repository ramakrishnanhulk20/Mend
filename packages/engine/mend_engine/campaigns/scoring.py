"""Scores every shop customer's lapse risk from the shop's own order records.

BG/NBD is fitted on each customer's purchase days up to and including the as_of
day, then gives each customer's expected purchases over the next 13 weeks: the
fewer, the more at risk. Only shop records are read, never PayPal data (PLAN 3a).
Refunds lower what a customer has paid, never their purchase days.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
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
# A fit reads every order and runs an optimiser, the heaviest thing a visitor can
# start; one kept per day and data version means a burst of page loads costs one fit.
SCORE_CACHE_ENTRIES = 4
_SCORE_CACHE: OrderedDict[tuple, ScoreSet] = OrderedDict()
_CACHE_LOCK = threading.Lock()
_FIT_LOCK = threading.Lock()


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


def end_of_day_utc(as_of: date) -> datetime:
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
    end = end_of_day_utc(as_of)
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


def net_of_later_refunds(conn: psycopg.Connection, scores: ScoreSet, customer_refs: Sequence[str]) -> dict[str, int]:
    """scores.paid_minor for each of customer_refs, less every refund recorded after the end of the London day scores.as_of.

    scores.paid_minor already nets the refunds up to as_of, so this is what each
    customer paid by as_of net of every refund on record now, never below 0 (C4): a
    refund recorded after the scoring day still lowers what a draft may pay. A ref
    with no paid amount counts as 0.
    """
    later = dict(
        conn.execute(
            "select customer_ref, sum(amount_minor) from shop_refunds where refunded_at >= %s and customer_ref = any(%s) "
            "group by customer_ref",
            (end_of_day_utc(scores.as_of), list(customer_refs)),
        )
    )
    return {ref: max(scores.paid_minor.get(ref, 0) - int(later.get(ref, 0)), 0) for ref in customer_refs}


def score_customers(conn: psycopg.Connection, as_of: date) -> ScoreSet:
    """Fit BG/NBD on every shop customer's purchase days up to as_of and score them.

    A purchase day is a London calendar day with at least one order from that
    customer, up to and including as_of. Uses the model's own convergence rule; a
    fit that does not converge, or that cannot run at all (nobody had bought by
    as_of), comes back with converged False and no scores, never a fallback.

    The answer is kept in this process's memory for as_of and the data version
    (_data_version), at most SCORE_CACHE_ENTRIES of them, least recently used
    dropped first, so asking again costs one small query instead of a fit (C20).
    One fit runs at a time in the process. Every caller gets its own copy.

    Raises ValueError if as_of is not a plain date.
    """
    _check_day(as_of)
    key = (as_of, *_data_version(conn))
    with _CACHE_LOCK:
        kept = _SCORE_CACHE.get(key)
        if kept is not None:
            _SCORE_CACHE.move_to_end(key)
            return _copy(kept)
    with _FIT_LOCK:
        # Another caller may have fitted the same scores while this one waited.
        with _CACHE_LOCK:
            kept = _SCORE_CACHE.get(key)
        if kept is None:
            kept = _fit_scores(conn, as_of)
        with _CACHE_LOCK:
            _SCORE_CACHE[key] = kept
            _SCORE_CACHE.move_to_end(key)
            while len(_SCORE_CACHE) > SCORE_CACHE_ENTRIES:
                _SCORE_CACHE.popitem(last=False)
    return _copy(kept)


def _data_version(conn: psycopg.Connection) -> tuple:
    """Which records the scores are read from, and a cheap mark of what they hold.

    The server, database and schema, then for shop_orders and for shop_refunds the
    row count, largest key, money total and latest time. Any added, removed or
    re-priced row changes it. Not covered: an edit in place that keeps all four the
    same; the shop's records are only ever added to by the importers.
    """
    row = conn.execute(
        "select current_database(), current_schema(), "
        "(select count(*) from shop_orders), (select max(order_ref) from shop_orders), "
        "(select coalesce(sum(total_minor), 0) from shop_orders), (select max(ordered_at) from shop_orders), "
        "(select count(*) from shop_refunds), (select max(refund_ref) from shop_refunds), "
        "(select coalesce(sum(amount_minor), 0) from shop_refunds), (select max(refunded_at) from shop_refunds)"
    ).fetchone()
    return (conn.info.host, conn.info.port, *row)


def _copy(scores: ScoreSet) -> ScoreSet:
    return ScoreSet(
        scores.converged,
        scores.message,
        dict(scores.scores),
        dict(scores.purchase_days),
        dict(scores.days_silent),
        dict(scores.paid_minor),
        scores.as_of,
    )


def _fit_scores(conn: psycopg.Connection, as_of: date) -> ScoreSet:
    end = end_of_day_utc(as_of)

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
