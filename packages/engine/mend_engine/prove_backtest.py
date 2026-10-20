"""Tests the lapse model on the real UK shop's history: python -m mend_engine.prove_backtest

Reads the UCI Online Retail II file (Chen 2012, CC BY 4.0) on its own dates. At six
cutoffs from June 2010 to September 2011 it fits the model on everything up to the
cutoff, then checks who actually came back in the next 91 days, and compares the
model's ranking with the plain "days since last order" rule. A cutoff whose fit did
not converge is printed as such and left out of the summary.

Ends with BACKTEST RESULT: PASS only if the model beats the plain rule at every
converged cutoff and at least four cutoffs converged. It touches no database and
calls no PayPal API.
"""

from __future__ import annotations

import math
import sys
import time
from datetime import date, timedelta

from mend_engine.data.uci import CACHE_DIR, SourceError, ensure_source
from mend_engine.model.backtest import CutoffResult, decile_table, purchase_days_from_uci, run_cutoff

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


def percent(share: float) -> str:
    return "n/a" if math.isnan(share) else f"{100 * share:.0f} percent"


def cutoff_line(result: CutoffResult) -> str:
    model = f"AUC model {result.auc_model:.3f}, " if result.converged else "fit did not converge, "
    predicted = f"predicted {result.predicted_purchase_days:,.0f}, " if result.converged else ""
    return (
        f"{result.cutoff}: {result.customers:,} customers, {model}AUC recency {result.auc_recency:.3f}, "
        f"lapsed regulars {result.lapsed_regulars:,}, came back anyway {percent(result.lapsed_returned_share)}; "
        f"purchase days in the next {HOLDOUT_DAYS}: {predicted}actual {result.actual_purchase_days:,}"
    )


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
    results = []
    for cutoff in CUTOFFS:
        result = run_cutoff(days, cutoff, HOLDOUT_DAYS)
        results.append(result)
        print(cutoff_line(result), flush=True)

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
    print(f"model beats recency at {wins} of {len(converged)} converged cutoffs, mean AUC gain {gain}")
    excluded = [str(r.cutoff) for r in results if not r.converged]
    if excluded:
        print(f"left out of the summary because the fit did not converge: {', '.join(excluded)}")
    print(f"timing: reading the file {read_seconds:.1f} seconds, fitting and scoring {scoring_seconds:.1f} seconds")
    return len(converged) >= MIN_CONVERGED and wins == len(converged)


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
