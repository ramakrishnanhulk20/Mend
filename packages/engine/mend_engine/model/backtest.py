"""Tests the lapse model on a shop's own past: who did it say would go quiet, and did they?

Rolling origin: pretend each cutoff day is today, fit BG/NBD on the purchase days up
to and including it, rank every customer by lapse risk, then look at the next
holdout_days to see who actually came back. The model's ranking is compared with
the plain rule a shop owner would use without it: the longer since the last
purchase, the more at risk.

The measure is AUC: the chance that a customer who did not come back was ranked as
more at risk than one who did. 0.5 is a coin toss and 1.0 is a perfect ranking.

Each cutoff is measured in three groups, because a ranking that sorts every
customer well can still tie the plain rule among the few a campaign actually ranks:
the live segment (eligibility's own rule, the customers campaigns rank), the
backtest's target group, and all customers. Every model-minus-recency difference
carries a 95 percent bootstrap interval, so a gap smaller than the noise reads as
one.
"""

from __future__ import annotations

import math
from bisect import bisect_right
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np

from mend_engine.campaigns import eligibility
from mend_engine.data.uci import iter_clean_lines_by_sheet
from mend_engine.model.bgnbd import Params, expected_purchases, fit
from mend_engine.model.rfm import summarise

UNIT_DAYS = 7.0
# The target group is the campaign's own rule, read from eligibility rather than
# copied, so the backtest can never again describe a group campaigns do not use.
REGULAR_MIN_DAYS = eligibility.REGULAR_MIN_DAYS
SILENT_MIN_DAYS = eligibility.SILENT_MIN_DAYS
DECILES = 10
RESAMPLES = 1000
BOOTSTRAP_SEED = 0
CONFIDENCE = 0.95
# Attribute names of the three groups on CutoffResult and Backtest, live segment first.
GROUPS = ("live_segment", "target_group", "all_customers")


@dataclass(frozen=True)
class GroupResult:
    """How the model's ranking and recency's compare inside one group at one cutoff.

    customers counts the group and returned those of them who bought again within
    the holdout. auc_recency is None when the group lacks a customer who came back
    or one who did not; auc_model is None then too, and also when the fit did not
    converge. difference is auc_model minus auc_recency, None when either is. low
    and high bound its 95 percent bootstrap interval, None when difference is None
    or the group is too small to resample (see difference_interval).
    """

    customers: int
    returned: int
    auc_model: float | None
    auc_recency: float | None
    difference: float | None
    low: float | None
    high: float | None


@dataclass(frozen=True)
class CutoffResult:
    """What one cutoff showed.

    customers counts everyone who had bought by the cutoff. auc_model and
    predicted_purchase_days are None when the fit did not converge, because its
    parameters mean nothing then. auc_model and auc_recency cover all customers.
    lapsed_regulars counts the target group and lapsed_returned_share is the share
    of it who came back within the holdout with no campaign at all, NaN when the
    group is empty. Purchase-day counts cover the holdout only. live_segment,
    target_group and all_customers measure the two rankings inside each group.
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
    live_segment: GroupResult
    target_group: GroupResult
    all_customers: GroupResult


@dataclass(frozen=True)
class GroupSummary:
    """One group over a run of cutoffs, counting only the valid ones: those where its difference is defined.

    model_wins counts the valid cutoffs where the model's AUC is higher.
    mean_difference is the mean of their differences, and low and high bound its 95
    percent interval from one bootstrap over all of them together (see
    difference_interval). All three are None when no cutoff is valid; low and high
    are None too when the group is too small to resample.
    """

    valid: int
    model_wins: int
    mean_difference: float | None
    low: float | None
    high: float | None


@dataclass(frozen=True)
class Backtest:
    """run_cutoff at each cutoff, in the order given, with each group's summary over them."""

    results: tuple[CutoffResult, ...]
    live_segment: GroupSummary
    target_group: GroupSummary
    all_customers: GroupSummary


@dataclass(frozen=True, eq=False)
class CutoffScores:
    """Every customer who had bought by cutoff, in one order across all the arrays.

    params and expected (expected purchases over the holdout) are None when the fit
    did not converge. x, t_x and T are the model's inputs in weeks (rfm.summarise).
    days_before counts purchase days up to and including the cutoff, days_silent
    the days since the last of them, and days_after the purchase days in the holdout.
    """

    cutoff: date
    holdout_days: int
    customers: tuple[str, ...]
    params: Params | None
    expected: np.ndarray | None
    x: np.ndarray
    t_x: np.ndarray
    T: np.ndarray
    days_silent: np.ndarray
    days_before: np.ndarray
    days_after: np.ndarray


@dataclass(frozen=True, eq=False)
class Paired:
    """Two at-risk rankings of one group at one cutoff, for difference_interval.

    customers names each row once. first and second are at-risk scores (higher
    means more at risk) and did_not_return the labels, all in the customers' order.
    """

    customers: Sequence[str]
    first: np.ndarray
    second: np.ndarray
    did_not_return: np.ndarray


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


def difference_interval(
    parts: Sequence[Paired], *, resamples: int = RESAMPLES, seed: int = BOOTSTRAP_SEED
) -> tuple[float, float] | None:
    """95 percent bootstrap interval on the mean over parts of AUC(first) minus AUC(second).

    Each part is one group at one cutoff. A resample draws, with replacement, as many
    customers as appear in any part, and a customer drawn k times counts k times in
    every part they belong to. Cutoffs share customers, and drawing them together
    keeps that overlap from making the interval look tighter than the data allow.
    Both rankings are scored on the same draw, so the interval is on the paired
    difference. With one part this is the ordinary bootstrap of that group. The
    bounds are the 2.5th and 97.5th percentiles of the resampled means, from a
    generator seeded with seed, so the same input always gives the same interval.

    Returns None if any resample leaves a part without a customer who came back or
    without one who did not. The AUC is undefined on that draw, and an interval built
    from the other draws alone would claim more than the data show. In practice this
    happens only for groups of a few dozen customers or fewer.

    Raises ValueError if parts is empty, a part names a customer twice or its arrays
    do not match its customers, a part's scores or labels fail auc's checks (both
    kinds of customer must be present), resamples is not a whole number from 1 up,
    or seed is not a whole number from 0 up.
    """
    if isinstance(resamples, bool) or not isinstance(resamples, int) or resamples < 1:
        raise ValueError("resamples must be a whole number from 1 up")
    if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
        raise ValueError("seed must be a whole number from 0 up")
    if not parts:
        raise ValueError("difference_interval needs at least one group")
    position: dict[str, int] = {}
    prepared = []
    for part in parts:
        names = list(part.customers)
        if len(set(names)) != len(names):
            raise ValueError("a group names the same customer twice")
        first, second, labels = (np.asarray(values) for values in (part.first, part.second, part.did_not_return))
        if not first.shape == second.shape == labels.shape == (len(names),):
            raise ValueError("each group's scores and labels must have one entry per customer")
        auc(first, labels)
        auc(second, labels)
        rows = np.array([position.setdefault(name, len(position)) for name in names])
        prepared.append((rows, first.astype(float), second.astype(float), labels.astype(bool)))

    rng = np.random.default_rng(seed)
    everyone = len(position)
    means = np.empty(resamples)
    for draw in range(resamples):
        times = np.bincount(rng.integers(0, everyone, everyone), minlength=everyone)
        total = 0.0
        for rows, first, second, gone in prepared:
            taken = np.repeat(np.arange(rows.size), times[rows])
            kept = gone[taken]
            if kept.all() or not kept.any():
                return None
            total += auc(first[taken], kept) - auc(second[taken], kept)
        means[draw] = total / len(prepared)
    tail = 100 * (1 - CONFIDENCE) / 2
    low, high = np.percentile(means, [tail, 100 - tail])
    return float(low), float(high)


def live_segment(scores: CutoffScores) -> np.ndarray:
    """Which customers the campaign rule would rank at the cutoff, by eligibility's own constants.

    Only the purchase-day rules: the UCI history carries no membership or verified
    email, and refunds are not part of a customer's purchase days.
    """
    return (scores.days_before >= eligibility.REGULAR_MIN_DAYS) & (scores.days_silent >= eligibility.SILENT_MIN_DAYS)


def target_group(scores: CutoffScores) -> np.ndarray:
    """Which customers are in the backtest's target group: REGULAR_MIN_DAYS and SILENT_MIN_DAYS."""
    return (scores.days_before >= REGULAR_MIN_DAYS) & (scores.days_silent >= SILENT_MIN_DAYS)


def run_cutoff(purchase_days: Mapping[str, Sequence[date]], cutoff: date, holdout_days: int = 91) -> CutoffResult:
    """Fit on purchase days up to and including cutoff and score the next holdout_days.

    The model ranks by expected purchases over the holdout (13 weeks for the default
    91 days), fewer meaning more at risk. Recency ranks by days since the last
    purchase day, more meaning more at risk. A customer returned if they bought on
    any day after cutoff up to and including cutoff + holdout_days. Customers whose
    first purchase is after cutoff are left out. Both rankings are then measured
    inside the live segment, the target group and all customers, each AUC on that
    group alone, with the model-minus-recency interval from difference_interval.

    Raises ValueError if cutoff is not a plain date, holdout_days is not a whole
    number from 1 up, the days are invalid (see rfm.summarise), nobody had bought by
    cutoff, or everyone or nobody returned (AUC is undefined then).
    """
    return _measured(score_cutoff(purchase_days, cutoff, holdout_days))[0]


def run_backtest(
    purchase_days: Mapping[str, Sequence[date]], cutoffs: Sequence[date], holdout_days: int = 91
) -> Backtest:
    """run_cutoff at each cutoff, then each group's record over the cutoffs where its difference is defined.

    The pooled interval comes from one bootstrap over every valid cutoff at once, so
    a customer who sits in several cutoffs' group is drawn together in all of them.
    Raises ValueError as run_cutoff does, or if cutoffs is empty or names a day twice.
    """
    if not cutoffs:
        raise ValueError("run_backtest needs at least one cutoff")
    if len(set(cutoffs)) != len(cutoffs):
        raise ValueError("each cutoff may appear only once")
    results = []
    pairs: dict[str, list[Paired]] = {name: [] for name in GROUPS}
    for cutoff in cutoffs:
        result, paired = _measured(score_cutoff(purchase_days, cutoff, holdout_days))
        results.append(result)
        for name, pair in paired.items():
            if pair is not None:
                pairs[name].append(pair)
    summaries = {name: _summary([getattr(r, name) for r in results], pairs[name]) for name in GROUPS}
    return Backtest(results=tuple(results), **summaries)


def _measured(scores: CutoffScores) -> tuple[CutoffResult, dict[str, Paired | None]]:
    returned = scores.days_after > 0
    gone = ~returned
    lapsed = target_group(scores)
    lapsed_count = int(lapsed.sum())
    converged = scores.expected is not None
    groups = {
        "live_segment": _group(scores, live_segment(scores)),
        "target_group": _group(scores, lapsed),
        "all_customers": _group(scores, np.ones(returned.size, dtype=bool)),
    }
    result = CutoffResult(
        cutoff=scores.cutoff,
        customers=int(returned.size),
        converged=converged,
        auc_model=auc(-scores.expected, gone) if converged else None,
        auc_recency=auc(scores.days_silent, gone),
        lapsed_regulars=lapsed_count,
        lapsed_returned_share=float(returned[lapsed].mean()) if lapsed_count else math.nan,
        predicted_purchase_days=float(scores.expected.sum()) if converged else None,
        actual_purchase_days=int(scores.days_after.sum()),
        **{name: group for name, (group, _) in groups.items()},
    )
    return result, {name: pair for name, (_, pair) in groups.items()}


def _group(scores: CutoffScores, members: np.ndarray) -> tuple[GroupResult, Paired | None]:
    gone = scores.days_after[members] == 0
    count = int(members.sum())
    returned = count - int(gone.sum())
    if not 0 < returned < count:
        return GroupResult(count, returned, None, None, None, None, None), None
    silent = scores.days_silent[members]
    recency = auc(silent, gone)
    if scores.expected is None:
        return GroupResult(count, returned, None, recency, None, None, None), None
    model_scores = -scores.expected[members]
    model = auc(model_scores, gone)
    names = [name for name, member in zip(scores.customers, members) if member]
    pair = Paired(names, model_scores, silent, gone)
    low, high = difference_interval([pair]) or (None, None)
    return GroupResult(count, returned, model, recency, model - recency, low, high), pair


def _summary(groups: Sequence[GroupResult], pairs: Sequence[Paired]) -> GroupSummary:
    differences = [g.difference for g in groups if g.difference is not None]
    if not differences:
        return GroupSummary(0, 0, None, None, None)
    low, high = difference_interval(pairs) or (None, None)
    return GroupSummary(
        valid=len(differences),
        model_wins=sum(1 for d in differences if d > 0),
        mean_difference=float(sum(differences) / len(differences)),
        low=low,
        high=high,
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
    scores = score_cutoff(purchase_days, cutoff, holdout_days)
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


def score_cutoff(purchase_days: Mapping[str, Sequence[date]], cutoff: date, holdout_days: int = 91) -> CutoffScores:
    """Fit BG/NBD on purchase days up to and including cutoff and gather every customer's numbers.

    Raises ValueError if cutoff is not a plain date, holdout_days is not a whole
    number from 1 up, the days are invalid (see rfm.summarise), or nobody had bought
    by cutoff.
    """
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
    return CutoffScores(
        cutoff=cutoff,
        holdout_days=holdout_days,
        customers=tuple(s.customer for s in summaries),
        params=result.params if result.converged else None,
        expected=expected,
        x=x,
        t_x=t_x,
        T=T,
        days_silent=np.array(silent, dtype=float),
        days_before=np.array(before),
        days_after=np.array(after),
    )
