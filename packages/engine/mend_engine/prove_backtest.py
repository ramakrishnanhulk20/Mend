"""Tests the lapse model on the real UK shop's history: python -m mend_engine.prove_backtest

Reads the UCI Online Retail II file (Chen 2012, CC BY 4.0) on its own dates. At six
cutoffs from June 2010 to September 2011 it fits the model on everything up to the
cutoff, then checks who actually came back in the next 91 days, and compares the
model's ranking with the plain "days since last order" rule in three groups, live
segment first: the live segment (the quiet regulars campaigns pick from, by eligibility's
rule), the backtest's target group, and all customers. Each model-minus-recency
difference is printed with its 95 percent bootstrap interval, and each group's
summary with one pooled interval over its valid cutoffs. A cutoff whose fit did not
converge is printed as such and left out of every summary.

Ends with BACKTEST RESULT: PASS only if, over all customers, the model beats the
plain rule at every converged cutoff and at least four cutoffs converged. It also
needs the forecast groups to rise: pooled over the converged cutoffs, quiet regulars
called likely gone came back on their own less often than those worth a nudge, and
those less often than the ones called likely back. The AUC bar is about all
customers only; the live segment's AUC numbers are printed first so they are read
first, and are not part of it. It touches no database and calls no PayPal API.
"""

from __future__ import annotations

import math
import sys
import time
from collections.abc import Mapping
from datetime import date, timedelta

from mend_engine.campaigns import eligibility
from mend_engine.campaigns.scoring import HORIZON_WEEKS
from mend_engine.data.uci import CACHE_DIR, SourceError, ensure_source
from mend_engine.model.backtest import (
    FORECAST_GROUPS,
    GROUPS,
    CutoffResult,
    ForecastGroups,
    GroupCount,
    GroupResult,
    GroupSummary,
    decile_table,
    purchase_days_from_uci,
    run_backtest,
)

# The data brief's own cutoffs, so its table can be read beside this output. The
# last one's holdout ends on 9 Dec 2011, the file's final day.
CUTOFFS = (
    date(2010, 6, 9),
    date(2010, 9, 9),
    date(2010, 12, 9),
    date(2011, 3, 9),
    date(2011, 6, 9),
    date(2011, 9, 9),
)
HOLDOUT_DAYS = 91
MIN_CONVERGED = 4
_RULE = f"{eligibility.REGULAR_MIN_DAYS}+ purchase days, {eligibility.SILENT_MIN_DAYS}+ days silent"
LABELS = {
    "live_segment": f"quiet regulars ({_RULE}, the pool campaigns pick from)",
    "target_group": f"target group ({_RULE})",
    "all_customers": "all customers",
}
FORECAST_LABELS = {
    eligibility.LIKELY_GONE: "likely gone",
    eligibility.WORTH_A_NUDGE: "worth a nudge",
    eligibility.LIKELY_BACK: "likely back",
}


def percent(share: float) -> str:
    return "n/a" if math.isnan(share) else f"{100 * share:.0f} percent"


def signed(value: float | None) -> str:
    return "n/a" if value is None else f"{value:+.3f}"


def interval(low: float | None, high: float | None) -> str:
    return "no interval: too few customers to resample" if low is None else f"95 percent interval {low:+.3f} to {high:+.3f}"


def cutoff_line(result: CutoffResult) -> str:
    fitted = "fit converged" if result.converged else "fit did not converge"
    predicted = f"predicted {result.predicted_purchase_days:,.0f}, " if result.converged else ""
    return (
        f"{result.cutoff}: {result.customers:,} customers had bought, {fitted}; "
        f"purchase days in the next {HOLDOUT_DAYS}: {predicted}actual {result.actual_purchase_days:,}"
    )


def group_line(name: str, group: GroupResult) -> str:
    if group.customers == 0:
        return f"  {LABELS[name]}: nobody"
    came_back = f"{group.customers:,} customers, {percent(group.returned / group.customers)} came back with no campaign"
    if group.auc_recency is None:
        return f"  {LABELS[name]}: {came_back}; no AUC, the group needs customers who came back and customers who did not"
    recency = f"AUC recency {group.auc_recency:.3f}"
    if group.difference is None:
        return f"  {LABELS[name]}: {came_back}; fit did not converge, {recency}"
    return (
        f"  {LABELS[name]}: {came_back}; AUC model {group.auc_model:.3f}, {recency}; "
        f"model minus recency {signed(group.difference)}, {interval(group.low, group.high)}"
    )


def summary_line(name: str, summary: GroupSummary) -> str:
    if summary.valid == 0:
        return f"  {LABELS[name]}: no valid cutoff"
    return (
        f"  {LABELS[name]}: model ahead at {summary.model_wins} of {summary.valid} valid cutoffs, "
        f"mean model minus recency {signed(summary.mean_difference)}, pooled {interval(summary.low, summary.high)}"
    )


def forecast_counts(counts: Mapping[str, GroupCount]) -> str:
    parts = []
    for name in FORECAST_GROUPS:
        count = counts[name]
        share = count.returned / count.customers if count.customers else math.nan
        parts.append(f"{FORECAST_LABELS[name]} {count.returned:,} of {count.customers:,} ({percent(share)})")
    return ", ".join(parts)


def forecast_line(groups: ForecastGroups) -> str:
    if not groups.converged:
        return f"{groups.cutoff}: fit did not converge"
    return f"{groups.cutoff}: {forecast_counts({name: getattr(groups, name) for name in FORECAST_GROUPS})}"


def run() -> bool:
    started = time.perf_counter()
    path = ensure_source(CACHE_DIR)
    days = purchase_days_from_uci(path)
    read_seconds = time.perf_counter() - started
    customer_days = sum(len(d) for d in days.values())
    first_day = min(d[0] for d in days.values())
    last_day = max(d[-1] for d in days.values())
    print(
        f"data: UCI Online Retail II (Chen 2012, CC BY 4.0), {len(days):,} customers, "
        f"{customer_days:,} purchase days, {first_day} to {last_day}, read in {read_seconds:.1f} seconds",
        flush=True,
    )
    # A holdout running past the data would count customers as gone who simply
    # had not been recorded yet.
    late = [c for c in CUTOFFS if c + timedelta(days=HOLDOUT_DAYS) > last_day]
    if late:
        print(f"FAIL: the holdout after {', '.join(map(str, late))} runs past the last day in the file")
        return False

    scoring_started = time.perf_counter()
    run_result = run_backtest(days, CUTOFFS, HOLDOUT_DAYS)
    results = run_result.results
    for result in results:
        print(cutoff_line(result), flush=True)
        for name in GROUPS:
            print(group_line(name, getattr(result, name)), flush=True)
    print("each group over its valid cutoffs (fit converged, and some came back and some did not):")
    for name in GROUPS:
        print(summary_line(name, getattr(run_result, name)), flush=True)
    print(
        f"forecast groups among quiet regulars (orders expected over {HORIZON_WEEKS} weeks; "
        f"came back within {HOLDOUT_DAYS} days with no campaign):"
    )
    for result in results:
        print(forecast_line(result.groups), flush=True)
    pooled_cutoffs = sum(1 for r in results if r.groups.converged)
    print(f"pooled over {pooled_cutoffs} cutoffs: {forecast_counts(run_result.groups_pooled)}")
    print(f"forecast groups rise from likely gone to worth a nudge to likely back: {'PASS' if run_result.groups_rise else 'FAIL'}", flush=True)

    converged = [r for r in results if r.converged]
    if converged:
        latest = converged[-1].cutoff
        print(f"decile table at {latest} (decile 1 = least at risk), share who came back within {HOLDOUT_DAYS} days:")
        for decile, size, rate in decile_table(days, latest, HOLDOUT_DAYS):
            print(f"  decile {decile:>2}: {size:>4,} customers, {percent(rate)}")
    scoring_seconds = time.perf_counter() - scoring_started

    wins = sum(1 for r in converged if r.auc_model > r.auc_recency)
    gains = [r.auc_model - r.auc_recency for r in converged]
    gain = f"{sum(gains) / len(gains):.3f}" if gains else "n/a"
    print(f"the PASS bar, all customers: model beats recency at {wins} of {len(converged)} converged cutoffs, mean AUC gain {gain}")
    excluded = [str(r.cutoff) for r in results if not r.converged]
    if excluded:
        print(f"left out of every summary because the fit did not converge: {', '.join(excluded)}")
    print(f"timing: reading the file {read_seconds:.1f} seconds, fitting and scoring {scoring_seconds:.1f} seconds")
    return len(converged) >= MIN_CONVERGED and wins == len(converged) and run_result.groups_rise


def main() -> int:
    try:
        passed = run()
    except (SourceError, ValueError) as exc:
        print(f"FAIL: {type(exc).__name__}: {exc}")
        passed = False
    except Exception as exc:
        print(f"FAIL: stopped: {type(exc).__name__}")
        passed = False
    print(f"BACKTEST RESULT: {'PASS' if passed else 'FAIL'}", flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
