"""Proves the customer model against a published benchmark: python -m mend_engine.prove_model

Fits our own BG/NBD code to the CDNOW sample and compares it with the numbers
Fader, Hardie and Lee (2005) published for the same data, then shows that a
degenerate input is reported as not converged instead of returning runaway
parameters. Ends with MODEL RESULT: PASS only if every check holds.

It uses a local copy of the sample if one exists (the project's reference folder,
then packages/engine/.data). Otherwise it downloads the file once into
packages/engine/.data, which git ignores, because the data carry no licence.
"""

from __future__ import annotations

import sys
from pathlib import Path

import httpx
import numpy as np

from mend_engine.model.benchmark import (
    CDNOW_SAMPLE_SIZE,
    CDNOW_SAMPLE_URL,
    LOG_LIKELIHOOD_TOLERANCE,
    PAPER_CUMULATIVE_UNDER_PERCENT,
    PARAMETER_TOLERANCE,
    SAMPLE_CUSTOMERS,
    ZERO_GROUP_MEAN_TOLERANCE,
    BenchmarkResult,
    load_cdnow_sample,
    reproduce,
)
from mend_engine.model.bgnbd import fit

ENGINE_DIR = Path(__file__).resolve().parents[1]
REFERENCE_COPY = ENGINE_DIR.parents[1] / "reference" / "meendum-data" / "raw" / "cdnow" / "CDNOW_sample.zip"
CACHE_COPY = ENGINE_DIR / ".data" / "CDNOW_sample.zip"
DOWNLOAD_TIMEOUT_SECONDS = 30.0
# The host answers "Access Denied" (HTTP 465) to httpx's default User-Agent but
# serves a plainly named client.
USER_AGENT = "mend-engine/0.1 (CDNOW benchmark download)"

# From the sample's read-me (6,919 records, 2,357 customers) and the paper's
# purchase-day counting (223 same-day rows merge away).
EXPECTED_ROWS = 6919
EXPECTED_CUSTOMER_DAYS = 6696
# The degenerate-input test in tests/test_bgnbd.py uses the same line.
EXTREME_PARAMETER = 1e6


def find_sample() -> Path:
    """Return a local copy of the sample of the right size, downloading one if none exists."""
    for candidate in (REFERENCE_COPY, CACHE_COPY):
        if candidate.is_file() and candidate.stat().st_size == CDNOW_SAMPLE_SIZE:
            return candidate
    return download_sample(CACHE_COPY)


def download_sample(target: Path) -> Path:
    """Fetch the sample into target, refusing redirects and any body that is not exactly the known size."""
    print(f"downloading the CDNOW sample from {CDNOW_SAMPLE_URL}", flush=True)
    body = bytearray()
    with httpx.stream(
        "GET",
        CDNOW_SAMPLE_URL,
        headers={"User-Agent": USER_AGENT},
        timeout=DOWNLOAD_TIMEOUT_SECONDS,
        follow_redirects=False,
    ) as response:
        if response.status_code != 200:
            raise ValueError(f"download answered HTTP {response.status_code}")
        for chunk in response.iter_bytes():
            body.extend(chunk)
            if len(body) > CDNOW_SAMPLE_SIZE:
                raise ValueError(f"download is larger than {CDNOW_SAMPLE_SIZE} bytes")
    if len(body) != CDNOW_SAMPLE_SIZE:
        raise ValueError(f"download is {len(body)} bytes, expected {CDNOW_SAMPLE_SIZE}")
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    partial.write_bytes(bytes(body))
    partial.replace(target)
    return target


def check_data(path: Path) -> bool:
    purchases = load_cdnow_sample(path)
    rows = sum(len(days) for days in purchases.values())
    customer_days = sum(len(set(days)) for days in purchases.values())
    customers = len(purchases)
    print(f"data: CDNOW sample, {rows:,} rows, {customer_days:,} customer-days, {customers:,} customers")
    ok = (rows, customer_days, customers) == (EXPECTED_ROWS, EXPECTED_CUSTOMER_DAYS, SAMPLE_CUSTOMERS)
    if not ok:
        print(f"FAIL: expected {EXPECTED_ROWS:,} rows, {EXPECTED_CUSTOMER_DAYS:,} customer-days, "
              f"{SAMPLE_CUSTOMERS:,} customers")
    return ok


def check_fit(result: BenchmarkResult) -> bool:
    p, pub = result.params, result.published
    print(f"fit: r {p.r:.4f} alpha {p.alpha:.4f} a {p.a:.4f} b {p.b:.4f} LL {result.log_likelihood:.2f}")
    print(f"published: r {pub['r']:.3f} alpha {pub['alpha']:.3f} a {pub['a']:.3f} b {pub['b']:.3f} "
          f"LL {pub['log_likelihood']:.1f}")
    fitted = {"r": p.r, "alpha": p.alpha, "a": p.a, "b": p.b}
    off = [f"{name} off by {abs(value - pub[name]):.4f}" for name, value in fitted.items()
           if abs(value - pub[name]) > PARAMETER_TOLERANCE]
    ll_gap = abs(result.log_likelihood - pub["log_likelihood"])
    if ll_gap > LOG_LIKELIHOOD_TOLERANCE:
        off.append(f"LL off by {ll_gap:.2f}")
    if not result.converged:
        off.append(result.fit_message)
    if off:
        print(f"match: FAILED, {'; '.join(off)}")
        return False
    print(f"match: every parameter within {PARAMETER_TOLERANCE:g}, LL within {LOG_LIKELIHOOD_TOLERANCE:g}")
    return True


def check_zero_group(result: BenchmarkResult) -> bool:
    print(f"zero group: {result.zero_group_size:,} customers, {result.zero_group_holdout_purchases:,} holdout "
          f"purchases, predicted mean {result.zero_group_predicted_mean:.3f} "
          f"(published {result.published['zero_group_predicted_mean']:.2f})")
    pub = result.published
    ok = (
        result.zero_group_size == pub["zero_group_size"]
        and result.zero_group_holdout_purchases == pub["zero_group_holdout_purchases"]
        and abs(result.zero_group_predicted_mean - pub["zero_group_predicted_mean"]) <= ZERO_GROUP_MEAN_TOLERANCE
    )
    if not ok:
        print(f"FAIL: published {pub['zero_group_size']:,} customers and {pub['zero_group_holdout_purchases']:,} "
              f"purchases exactly, and a mean within {ZERO_GROUP_MEAN_TOLERANCE:g} of "
              f"{pub['zero_group_predicted_mean']:g}")
    return ok


def check_cumulative(result: BenchmarkResult) -> bool:
    actual, expected = result.cumulative_week78_actual, result.cumulative_week78_expected
    error = 100.0 * (expected - actual) / actual
    print(f"cumulative week 78: actual {actual:,}, expected {expected:,.0f}, error {error:.1f} percent "
          f"(paper: about {PAPER_CUMULATIVE_UNDER_PERCENT} percent under)")
    # The paper states a whole percent, so the check is that ours rounds to the same.
    ok = PAPER_CUMULATIVE_UNDER_PERCENT - 0.5 <= -error < PAPER_CUMULATIVE_UNDER_PERCENT + 0.5
    if not ok:
        print(f"FAIL: under-forecast does not round to {PAPER_CUMULATIVE_UNDER_PERCENT} percent")
    return ok


def check_runaway_guard() -> bool:
    # Nobody ever returns: the likelihood keeps rising as the purchase rate falls to
    # zero, the case that sent an unbounded search off to 5e15 on a UCI cutoff.
    T = np.linspace(1.0, 39.0, 500)
    zeros = np.zeros_like(T)
    result = fit(zeros, zeros, T)
    largest = max(result.params.r, result.params.alpha, result.params.a, result.params.b)
    if result.converged or largest > EXTREME_PARAMETER:
        print(f"runaway guard: FAILED, converged={result.converged}, largest parameter {largest:.3g}")
        return False
    print("runaway guard: a degenerate input returns converged=False instead of extreme parameters")
    return True


def run() -> bool:
    try:
        path = find_sample()
        data_ok = check_data(path)
        result = reproduce(path)
    except (OSError, ValueError, httpx.HTTPError) as exc:
        print(f"FAIL: could not read the CDNOW sample: {exc}")
        return False
    checks = [
        data_ok,
        check_fit(result),
        check_zero_group(result),
        check_cumulative(result),
        check_runaway_guard(),
    ]
    print(f"timing: fit took {result.fit_seconds:.2f} seconds")
    # The module's own verdict must agree with the checks printed here.
    if not result.within_tolerance:
        print("FAIL: reproduce() reports the benchmark outside tolerance")
        return False
    return all(checks)


def main() -> int:
    passed = run()
    print(f"MODEL RESULT: {'PASS' if passed else 'FAIL'}", flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
