"""Tests the lapse model on a shop's own past: who did it say would go quiet, and did they?

Rolling origin: pretend each cutoff day is today, fit BG/NBD on the purchase days up
to and including it, rank every customer by lapse risk, then look at the next
holdout_days to see who actually came back. The model's ranking is compared with
the plain rule a shop owner would use without it: the longer since the last
purchase, the more at risk.

The measure is AUC: the chance that a customer who did not come back was ranked as
more at risk than one who did. 0.5 is a coin toss and 1.0 is a perfect ranking.
"""

from __future__ import annotations

import math
from bisect import bisect_right
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np

from mend_engine.data.uci import iter_clean_lines_by_sheet
from mend_engine.model.bgnbd import expected_purchases, fit
from mend_engine.model.rfm import summarise

UNIT_DAYS = 7.0
# The campaign's target group: bought on 3 or more days, then silent 90 or more.
REGULAR_MIN_DAYS = 3
SILENT_MIN_DAYS = 90
DECILES = 10


@dataclass(frozen=True)
class CutoffResult:
    """What one cutoff showed.

    customers counts everyone who had bought by the cutoff. auc_model and
    predicted_purchase_days are None when the fit did not converge, because its
    parameters mean nothing then. lapsed_returned_share is the share of lapsed
    regulars who came back within the holdout with no campaign at all, NaN when there
    are no lapsed regulars. Purchase-day counts cover the holdout only.
    """

    cutoff: date
    customers: int
    converged: bool
    auc_model: float | None
    auc_recency: float
    lapsed_regulars: int
    lapsed_returned_share: float
    predicted_purchase_days: float | None
    actual_purchase_days: int


@dataclass(frozen=True)
class _Scores:
    expected: np.ndarray | None
    days_silent: np.ndarray
    days_before: np.ndarray
    days_after: np.ndarray


def purchase_days_from_uci(zip_path: Path) -> dict[str, list[date]]:
    """Read the UCI file into each customer's purchase days, sorted, one entry per day.

    A purchase day is a calendar day with at least one kept line for that customer,
    on the file's own dates with no shift. Keys are the customer ids as text
    ("13085"), in numeric order. An invoice both sheets carry (1 to 9 Dec 2010) is
    taken from the first sheet that has it, the same rule the importer uses.

    Precondition: zip_path has been checked with ensure_source. Raises SourceError if
    the file's shape differs from the real UCI file.
    """
    owner: dict[str, str] = {}
    days: dict[int, set[date]] = {}
    for sheet, line in iter_clean_lines_by_sheet(zip_path):
        if owner.setdefault(line.invoice, sheet) != sheet:
            continue
        days.setdefault(line.customer_id, set()).add(line.invoiced_at_local.date())
    return {str(customer): sorted(days[customer]) for customer in sorted(days)}


def auc(at_risk_scores: np.ndarray, did_not_return: np.ndarray) -> float:
    """Chance that a customer who did not return scores as more at risk than one who did.

    Computed with the Mann-Whitney rank formula: ties share the average of their
    ranks, so a tied pair counts as half. at_risk_scores are finite numbers, higher
    meaning more at risk. did_not_return holds True or 1 for a customer who did not
    come back and False or 0 for one who did.

    Raises ValueError if the arrays are not 1-D and the same length, a score is not
    finite, a label is not 0 or 1, or either group is empty (the chance is undefined
    then, and 0.5 would look like an answer).
    """
    try:
        scores = np.asarray(at_risk_scores, dtype=float)
    except (TypeError, ValueError) as exc:
        raise ValueError("at_risk_scores must be numbers") from exc
    labels = np.asarray(did_not_return)
    if scores.ndim != 1 or labels.ndim != 1:
        raise ValueError("at_risk_scores and did_not_return must be 1-D arrays")
    if scores.size != labels.size:
        raise ValueError("at_risk_scores and did_not_return must have the same length")
    if not np.all(np.isfinite(scores)):
        raise ValueError("at_risk_scores must be finite")
    if labels.dtype != bool:
        if labels.dtype.kind not in "iuf" or not np.all((labels == 0) | (labels == 1)):
            raise ValueError("did_not_return must hold only True/False or 0/1")
        labels = labels == 1
    gone = int(labels.sum())
    back = labels.size - gone
    if gone == 0 or back == 0:
        raise ValueError("auc needs at least one customer who returned and one who did not")

    _, group, sizes = np.unique(scores, return_inverse=True, return_counts=True)
    ends = np.cumsum(sizes)
    # A tie group holding ranks s+1 to e has average rank (s + 1 + e) / 2. Keeping
    # twice that value leaves every number a whole one, so the half-credit for ties
    # is exact instead of a rounded float.
    twice_rank = (ends - sizes + 1 + ends)[group]
    twice_wins = int(twice_rank[labels].sum()) - gone * (gone + 1)
    return twice_wins / (2 * gone * back)


def run_cutoff(purchase_days: Mapping[str, Sequence[date]], cutoff: date, holdout_days: int = 91) -> CutoffResult:
    """Fit on purchase days up to and including cutoff and score the next holdout_days.

    The model ranks by expected purchases over the holdout (13 weeks for the default
    91 days), fewer meaning more at risk. Recency ranks by days since the last
    purchase day, more meaning more at risk. A customer returned if they bought on
    any day after cutoff up to and including cutoff + holdout_days. Customers whose
    first purchase is after cutoff are left out.

    Raises ValueError if cutoff is not a plain date, holdout_days is not a whole
    number from 1 up, the days are invalid (see rfm.summarise), nobody had bought by
    cutoff, or everyone or nobody returned (AUC is undefined then).
    """
    scores = _score(purchase_days, cutoff, holdout_days)
    returned = scores.days_after > 0
    gone = ~returned
    lapsed = (scores.days_before >= REGULAR_MIN_DAYS) & (scores.days_silent >= SILENT_MIN_DAYS)
    lapsed_count = int(lapsed.sum())
    converged = scores.expected is not None
    return CutoffResult(
        cutoff=cutoff,
        customers=int(returned.size),
        converged=converged,
        auc_model=auc(-scores.expected, gone) if converged else None,
        auc_recency=auc(scores.days_silent, gone),
        lapsed_regulars=lapsed_count,
        lapsed_returned_share=float(returned[lapsed].mean()) if lapsed_count else math.nan,
        predicted_purchase_days=float(scores.expected.sum()) if converged else None,
        actual_purchase_days=int(scores.days_after.sum()),
    )


def decile_table(
    purchase_days: Mapping[str, Sequence[date]], cutoff: date, holdout_days: int = 91
) -> list[tuple[int, int, float]]:
    """Split the customers into ten equal groups by model risk and give each group's return rate.

    Rows are (decile, customers, share who returned within the holdout). Decile 1 is
    the least at risk (most expected purchases) and decile 10 the most. Group sizes
    differ by at most one; customers with the same score keep their input order, so
    a tie can fall either side of a boundary.

    Raises ValueError as run_cutoff does, and also if the fit did not converge or
    there are fewer than ten customers.
    """
    scores = _score(purchase_days, cutoff, holdout_days)
    if scores.expected is None:
        raise ValueError(f"the fit at {cutoff} did not converge, so there is no model ranking to split")
    if scores.expected.size < DECILES:
        raise ValueError(f"a decile table needs at least {DECILES} customers")
    returned = scores.days_after > 0
    order = np.argsort(-scores.expected, kind="stable")
    return [
        (number, int(group.size), float(returned[group].mean()))
        for number, group in enumerate(np.array_split(order, DECILES), start=1)
    ]


def _score(purchase_days: Mapping[str, Sequence[date]], cutoff: date, holdout_days: int) -> _Scores:
    if isinstance(cutoff, datetime) or not isinstance(cutoff, date):
        raise ValueError("cutoff must be a date, not a datetime")
    if isinstance(holdout_days, bool) or not isinstance(holdout_days, int) or holdout_days < 1:
        raise ValueError("holdout_days must be a whole number from 1 up")
    try:
        holdout_end = cutoff + timedelta(days=holdout_days)
    except OverflowError:
        raise ValueError("cutoff plus holdout_days is past the last representable date") from None

    # summarise validates every customer's days, so the loop below can trust them.
    summaries = summarise(purchase_days, cutoff, unit_days=UNIT_DAYS)
    if not summaries:
        raise ValueError(f"nobody had bought by {cutoff}")
    silent, before, after = [], [], []
    for summary in summaries:
        ordered = sorted(purchase_days[summary.customer])
        seen = bisect_right(ordered, cutoff)
        silent.append((cutoff - ordered[seen - 1]).days)
        before.append(seen)
        after.append(bisect_right(ordered, holdout_end) - seen)

    x = np.array([s.x for s in summaries], dtype=float)
    t_x = np.array([s.t_x for s in summaries])
    T = np.array([s.T for s in summaries])
    result = fit(x, t_x, T)
    expected = expected_purchases(result.params, holdout_days / UNIT_DAYS, x, t_x, T) if result.converged else None
    return _Scores(
        expected=expected,
        days_silent=np.array(silent, dtype=float),
        days_before=np.array(before),
        days_after=np.array(after),
    )
