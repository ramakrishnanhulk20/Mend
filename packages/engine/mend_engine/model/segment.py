"""Which ranking of the live segment best finds who will not come back: python -m mend_engine.model.segment

Campaigns rank the live segment (eligibility's rule: 3 or more purchase days and 60
or more days silent) by BG/NBD expected purchases. This measures that ranking and
four others inside the same segment, on the UCI history at prove_backtest's
cutoffs, each against recency, the rule a shop owner would use without a model:

  expected purchases  BG/NBD expected purchases over the holdout, fewest first (what campaigns use)
  recency             days since the last purchase day, most first
  frequency           purchase days up to the cutoff, most first
  rank average        the mean of a customer's frequency rank and recency rank, highest first
  probability alive   BG/NBD chance the customer is still buying, lowest first

AUC and the bootstrap are backtest's own (auc and difference_interval), so these
numbers read beside prove_backtest's. A cutoff is valid when the fit converged and
the segment holds customers who came back and customers who did not. One set of
valid cutoffs serves every ranking, so the rows compare.

The rule, fixed before the alternatives were measured: a ranking beats recency only
if its AUC is higher at 4 or more of the valid cutoffs and the pooled 95 percent
interval of its difference from recency lies wholly above 0. This module only
measures. It does not change the ranking campaigns use, touches no database and
calls no PayPal API.
"""

from __future__ import annotations

import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np
from scipy.stats import rankdata

from mend_engine.campaigns import eligibility
from mend_engine.model.backtest import CutoffScores, Paired, auc, difference_interval, live_segment, score_cutoff
from mend_engine.model.bgnbd import Params, _checked

MIN_WINS = 4
BASELINE = "recency"


@dataclass(frozen=True)
class Ranking:
    """A way to order the segment. at_risk gives each member's score, higher meaning ranked first."""

    name: str
    description: str
    at_risk: Callable[[CutoffScores, np.ndarray], np.ndarray]


@dataclass(frozen=True)
class SegmentCutoff:
    """The live segment at one cutoff. left_out says why the cutoff is not valid, None when it is."""

    cutoff: date
    customers: int
    returned: int
    left_out: str | None


@dataclass(frozen=True)
class RankingAtCutoff:
    """One ranking at one valid cutoff: its AUC, its AUC minus recency's, and that difference's 95 percent interval."""

    cutoff: date
    auc: float
    difference: float
    low: float | None
    high: float | None


@dataclass(frozen=True)
class RankingResult:
    """One ranking over the valid cutoffs.

    wins counts the valid cutoffs where its AUC is above recency's. mean_difference
    is the mean of its differences, and low and high bound the pooled 95 percent
    interval from one bootstrap over every valid cutoff together. Any of the three
    is None when nothing could be measured or resampled. beats_recency applies the
    rule in the module docstring.
    """

    name: str
    description: str
    cutoffs: tuple[RankingAtCutoff, ...]
    wins: int
    mean_difference: float | None
    low: float | None
    high: float | None
    beats_recency: bool


@dataclass(frozen=True)
class Comparison:
    """Every cutoff's live segment, in the order given, and each ranking's record in RANKINGS order."""

    cutoffs: tuple[SegmentCutoff, ...]
    rankings: tuple[RankingResult, ...]


def probability_alive(params: Params, x, t_x, T) -> np.ndarray:
    """BG/NBD chance that each customer is still active at T (Fader, Hardie and Lee 2005).

    1 / (1 + [x > 0] a / (b + x - 1) ((alpha + T) / (alpha + t_x)) ** (r + x)), the
    share of equation 6's likelihood in which the customer has not dropped out,
    worked in logs so heavy buyers do not overflow. A customer with no repeat
    purchase is rated certainly active, which is why bgnbd does not offer this for
    ranking a whole shop; everyone in the live segment has repeats. Raises
    ValueError on invalid histories, as bgnbd does.
    """
    x, t_x, T = _checked(x, t_x, T)
    repeat = x > 0
    b_shift = np.where(repeat, params.b + x - 1.0, 1.0)
    log_odds = np.log(params.a) - np.log(b_shift) + (params.r + x) * (np.log(params.alpha + T) - np.log(params.alpha + t_x))
    return np.where(repeat, np.exp(-np.logaddexp(0.0, log_odds)), 1.0)


def beats_recency(wins: int, low: float | None) -> bool:
    """The rule fixed before the measurement: ahead at MIN_WINS or more valid cutoffs, and a pooled interval wholly above 0."""
    return wins >= MIN_WINS and low is not None and low > 0


def _rank_average(scores: CutoffScores, members: np.ndarray) -> np.ndarray:
    # Ranked within the segment, because the segment is the group being ordered.
    return (rankdata(scores.days_before[members]) + rankdata(scores.days_silent[members])) / 2


RANKINGS: tuple[Ranking, ...] = (
    Ranking("expected purchases", "BG/NBD expected purchases, fewest first; what campaigns use", lambda s, m: -s.expected[m]),
    Ranking(BASELINE, "days since the last purchase day, most first", lambda s, m: s.days_silent[m]),
    Ranking("frequency", "purchase days, most first", lambda s, m: s.days_before[m].astype(float)),
    Ranking("rank average", "mean of the frequency and recency ranks, highest first", _rank_average),
    Ranking(
        "probability alive",
        "BG/NBD chance still active, lowest first",
        lambda s, m: -probability_alive(s.params, s.x[m], s.t_x[m], s.T[m]),
    ),
)


def compare_rankings(
    purchase_days: Mapping[str, Sequence[date]], cutoffs: Sequence[date], holdout_days: int = 91
) -> Comparison:
    """Measure every ranking in RANKINGS inside the live segment at each cutoff, against recency.

    Raises ValueError as backtest.score_cutoff does, or if cutoffs is empty or names
    a day twice.
    """
    if not cutoffs:
        raise ValueError("compare_rankings needs at least one cutoff")
    if len(set(cutoffs)) != len(cutoffs):
        raise ValueError("each cutoff may appear only once")
    segments = []
    measured: dict[str, list[RankingAtCutoff]] = {r.name: [] for r in RANKINGS}
    pairs: dict[str, list[Paired]] = {r.name: [] for r in RANKINGS}
    for cutoff in cutoffs:
        scores = score_cutoff(purchase_days, cutoff, holdout_days)
        members = live_segment(scores)
        gone = scores.days_after[members] == 0
        count = int(members.sum())
        returned = count - int(gone.sum())
        if scores.params is None:
            segments.append(SegmentCutoff(cutoff, count, returned, "the fit did not converge"))
            continue
        if not 0 < returned < count:
            segments.append(SegmentCutoff(cutoff, count, returned, "the segment needs customers who came back and customers who did not"))
            continue
        segments.append(SegmentCutoff(cutoff, count, returned, None))
        names = [name for name, member in zip(scores.customers, members) if member]
        baseline = scores.days_silent[members]
        baseline_auc = auc(baseline, gone)
        for ranking in RANKINGS:
            at_risk = np.asarray(ranking.at_risk(scores, members), dtype=float)
            pair = Paired(names, at_risk, baseline, gone)
            low, high = difference_interval([pair]) or (None, None)
            score = auc(at_risk, gone)
            measured[ranking.name].append(RankingAtCutoff(cutoff, score, score - baseline_auc, low, high))
            pairs[ranking.name].append(pair)
    return Comparison(tuple(segments), tuple(_record(r, measured[r.name], pairs[r.name]) for r in RANKINGS))


def _record(ranking: Ranking, cutoffs: list[RankingAtCutoff], pairs: list[Paired]) -> RankingResult:
    wins = sum(1 for c in cutoffs if c.difference > 0)
    mean = float(sum(c.difference for c in cutoffs) / len(cutoffs)) if cutoffs else None
    low, high = (difference_interval(pairs) if pairs else None) or (None, None)
    return RankingResult(
        name=ranking.name,
        description=ranking.description,
        cutoffs=tuple(cutoffs),
        wins=wins,
        mean_difference=mean,
        low=low,
        high=high,
        beats_recency=ranking.name != BASELINE and beats_recency(wins, low),
    )


def _signed(value: float | None) -> str:
    return "n/a" if value is None else f"{value:+.3f}"


def _bounds(low: float | None, high: float | None) -> str:
    return "none, too few to resample" if low is None else f"{low:+.3f} to {high:+.3f}"


def report(comparison: Comparison) -> list[str]:
    """The table main prints: the segment at each cutoff, AUC by cutoff, then each ranking against recency."""
    rule = f"{eligibility.REGULAR_MIN_DAYS}+ purchase days, {eligibility.SILENT_MIN_DAYS}+ days silent"
    lines = [f"live segment ({rule}) at each cutoff:"]
    for segment in comparison.cutoffs:
        share = f"{100 * segment.returned / segment.customers:.0f} percent came back" if segment.customers else "nobody"
        status = "valid" if segment.left_out is None else f"left out: {segment.left_out}"
        lines.append(f"  {segment.cutoff}: {segment.customers:,} customers, {share}; {status}")
    valid = [s.cutoff for s in comparison.cutoffs if s.left_out is None]
    width = max(len(r.name) for r in comparison.rankings)
    lines.append("AUC inside the segment, by cutoff (0.5 is a coin toss):")
    lines.append(f"  {'ranking':<{width}}  " + "  ".join(f"{d}" for d in valid))
    for ranking in comparison.rankings:
        lines.append(f"  {ranking.name:<{width}}  " + "  ".join(f"{c.auc:>10.3f}" for c in ranking.cutoffs))
    lines.append("each ranking minus recency, by cutoff, with its 95 percent interval:")
    for ranking in comparison.rankings:
        if ranking.name == BASELINE:
            continue
        cells = "; ".join(f"{c.cutoff} {_signed(c.difference)} ({_bounds(c.low, c.high)})" for c in ranking.cutoffs)
        lines.append(f"  {ranking.name}: {cells}")
    lines.append(f"verdict (beats recency only if ahead at {MIN_WINS}+ of {len(valid)} valid cutoffs and the pooled interval is wholly above 0):")
    lines.append(f"  {'ranking':<{width}}  ahead   mean   pooled 95 percent interval  verdict")
    for ranking in comparison.rankings:
        if ranking.name == BASELINE:
            aucs = [c.auc for c in ranking.cutoffs]
            mean_auc = f", mean AUC {sum(aucs) / len(aucs):.3f}" if aucs else ""
            lines.append(f"  {ranking.name:<{width}}  the baseline{mean_auc}")
            continue
        verdict = "beats recency" if ranking.beats_recency else "does not beat recency"
        lines.append(
            f"  {ranking.name:<{width}}  {ranking.wins} of {len(ranking.cutoffs)}  {_signed(ranking.mean_difference)}  "
            f"{_bounds(ranking.low, ranking.high):<26}  {verdict}"
        )
    return lines


def main() -> int:
    from mend_engine import prove_backtest
    from mend_engine.data.uci import CACHE_DIR, SourceError, ensure_source
    from mend_engine.model.backtest import purchase_days_from_uci

    try:
        started = time.perf_counter()
        days = purchase_days_from_uci(ensure_source(CACHE_DIR))
        last_day = max(d[-1] for d in days.values())
        print(f"data: UCI Online Retail II (Chen 2012, CC BY 4.0), {len(days):,} customers, read in {time.perf_counter() - started:.1f} seconds", flush=True)
        late = [c for c in prove_backtest.CUTOFFS if c + timedelta(days=prove_backtest.HOLDOUT_DAYS) > last_day]
        if late:
            print(f"FAIL: the holdout after {', '.join(map(str, late))} runs past the last day in the file")
            return 1
        comparison = compare_rankings(days, prove_backtest.CUTOFFS, prove_backtest.HOLDOUT_DAYS)
    except (SourceError, ValueError) as exc:
        print(f"FAIL: {type(exc).__name__}: {exc}")
        return 1
    for line in report(comparison):
        print(line, flush=True)
    winners = [r.name for r in comparison.rankings if r.beats_recency]
    print(f"SEGMENT RESULT: {', '.join(winners) + ' beat recency' if winners else 'no ranking beats recency'}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
