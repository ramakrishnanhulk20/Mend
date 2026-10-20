"""The outside check: our BG/NBD code against Fader, Hardie and Lee (2005) on the CDNOW sample.

The paper fits the model to 2,357 CDNOW customers on the first 39 weeks of 1997
(calibration) and forecasts weeks 40 to 78 (holdout). It publishes the fitted
parameters, the log-likelihood and the holdout behaviour of the customers who made
no repeat purchase in calibration. Matching those numbers with code we wrote is what
lets an outsider trust the model before it touches a real shop's customers.

The CDNOW files carry no licence, so the sample is read from a local copy and never
stored in the repo. prove_model fetches it from CDNOW_SAMPLE_URL when needed.
"""

from __future__ import annotations

import hashlib
import re
import time
import zipfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import numpy as np

from mend_engine.model.bgnbd import (
    Params,
    expected_purchases,
    expected_purchases_unconditional,
    fit,
)
from mend_engine.model.rfm import summarise

CDNOW_SAMPLE_URL = "http://www.brucehardie.com/datasets/CDNOW_sample.zip"
CDNOW_SAMPLE_SIZE = 51656
# The file is served over plain http, so its size alone is not proof it is the real one.
CDNOW_SAMPLE_SHA256 = "7c487a00ae6c66a49b8edcd287f81f585785dcdfdb5c9c2c8606414803aa282f"
SAMPLE_MEMBER = "CDNOW_sample.txt"
# The real member is 228,327 bytes. The cap stops a swapped archive from unpacking
# into memory without limit.
_MEMBER_MAX_BYTES = 1_000_000
SAMPLE_CUSTOMERS = 2357

# Paper section 7: calibration ends after week 39, the holdout runs to week 78.
# 30 Sep 1997 is 272 days, 38.857 weeks, after 1 Jan, the paper's T for a customer
# who first bought on 1 January.
CALIBRATION_END = date(1997, 9, 30)
HOLDOUT_END = date(1998, 6, 30)
WEEK_DAYS = 7.0

# Table 2 and section 7 of the paper.
PUBLISHED = {
    "r": 0.243,
    "alpha": 4.414,
    "a": 0.793,
    "b": 2.426,
    "log_likelihood": -9582.4,
    "zero_group_size": 1411,
    "zero_group_holdout_purchases": 334,
    "zero_group_predicted_mean": 0.23,
}
# Section 7: "under-forecasting by ... 4%" for cumulative repeat purchases at week 78.
# It is not the error over the holdout weeks alone, which is 11 to 12 percent.
PAPER_CUMULATIVE_UNDER_PERCENT = 4

PARAMETER_TOLERANCE = 0.002
LOG_LIKELIHOOD_TOLERANCE = 0.1
ZERO_GROUP_MEAN_TOLERANCE = 0.01

_ROW = re.compile(r"\s*([0-9]{1,6})\s+([0-9]{1,4})\s+([0-9]{8})\s+([0-9]{1,4})\s+([0-9]{1,7}\.[0-9]{2})\s*", re.ASCII)


@dataclass(frozen=True)
class BenchmarkResult:
    """Our fit and holdout numbers next to the paper's.

    within_tolerance is True only when the fit converged, every parameter is within
    PARAMETER_TOLERANCE of the paper, the log-likelihood within
    LOG_LIKELIHOOD_TOLERANCE, the zero group's size and holdout purchases match
    exactly, and its predicted mean is within ZERO_GROUP_MEAN_TOLERANCE.
    """

    params: Params
    log_likelihood: float
    published: dict[str, float]
    within_tolerance: bool
    zero_group_size: int
    zero_group_holdout_purchases: int
    zero_group_predicted_mean: float
    cumulative_week78_actual: int
    cumulative_week78_expected: float
    converged: bool
    fit_message: str
    fit_seconds: float


def load_cdnow_sample(path: Path) -> dict[str, list[date]]:
    """Read CDNOW_sample.zip into one sorted list of purchase dates per customer.

    Keys are the sample ids ("1" to "2357"). Each row of the file is one entry, so a
    customer who bought twice on one day has that day twice: the row count stays
    visible, and the caller merges same-day rows before summarising.

    Raises ValueError if the file is not exactly CDNOW_SAMPLE_SIZE bytes with the known
    SHA-256, is not a
    zip holding CDNOW_sample.txt within the size cap, or has any row that is not five
    well-formed fields, or a sample id outside 1 to 2357 or tied to two master ids.
    """
    path = Path(path)
    size = path.stat().st_size
    if size != CDNOW_SAMPLE_SIZE:
        raise ValueError(f"{path} is {size} bytes, the CDNOW sample is {CDNOW_SAMPLE_SIZE}")
    if hashlib.sha256(path.read_bytes()).hexdigest() != CDNOW_SAMPLE_SHA256:
        raise ValueError(f"{path} does not match the known CDNOW sample checksum")
    try:
        with zipfile.ZipFile(path) as archive:
            info = archive.getinfo(SAMPLE_MEMBER)
            if info.file_size > _MEMBER_MAX_BYTES:
                raise ValueError(f"{SAMPLE_MEMBER} is larger than the {_MEMBER_MAX_BYTES} byte cap")
            with archive.open(info) as member:
                raw = member.read(_MEMBER_MAX_BYTES + 1)
    except (zipfile.BadZipFile, KeyError) as exc:
        raise ValueError(f"{path} is not the CDNOW sample archive") from exc
    if len(raw) > _MEMBER_MAX_BYTES:
        raise ValueError(f"{SAMPLE_MEMBER} is larger than the {_MEMBER_MAX_BYTES} byte cap")
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError as exc:
        raise ValueError(f"{SAMPLE_MEMBER} is not plain ASCII") from exc

    purchases: dict[str, list[date]] = {}
    master_of: dict[str, str] = {}
    for number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        match = _ROW.fullmatch(line)
        if match is None:
            raise ValueError(f"row {number} is not five well-formed fields")
        master, sample, stamp, _cds, _dollars = match.groups()
        sample_id = int(sample)
        if not 1 <= sample_id <= SAMPLE_CUSTOMERS:
            raise ValueError(f"row {number} has sample id {sample_id}, outside 1 to {SAMPLE_CUSTOMERS}")
        customer = str(sample_id)
        if master_of.setdefault(customer, master) != master:
            raise ValueError(f"row {number}: sample id {sample_id} is tied to two master ids")
        try:
            day = date(int(stamp[:4]), int(stamp[4:6]), int(stamp[6:]))
        except ValueError as exc:
            raise ValueError(f"row {number} has an impossible date {stamp}") from exc
        purchases.setdefault(customer, []).append(day)
    if not purchases:
        raise ValueError(f"{SAMPLE_MEMBER} has no rows")
    for days in purchases.values():
        days.sort()
    return purchases


def reproduce(path: Path) -> BenchmarkResult:
    """Fit the CDNOW sample the way the paper does and compare with its published numbers.

    Merges same-day rows, summarises in weeks at CALIBRATION_END, fits, then checks
    the customers with no calibration repeat purchase over the holdout and the
    cumulative repeat purchases through week 78. Raises ValueError if the file is
    not the CDNOW sample (see load_cdnow_sample).
    """
    days_by_customer = {customer: sorted(set(days)) for customer, days in load_cdnow_sample(path).items()}
    summaries = summarise(days_by_customer, CALIBRATION_END, unit_days=WEEK_DAYS)
    x = np.array([s.x for s in summaries], dtype=float)
    t_x = np.array([s.t_x for s in summaries])
    T = np.array([s.T for s in summaries])

    started = time.perf_counter()
    result = fit(x, t_x, T)
    fit_seconds = time.perf_counter() - started
    params = result.params

    holdout_weeks = (HOLDOUT_END - CALIBRATION_END).days / WEEK_DAYS
    holdout = np.array([
        sum(1 for day in days_by_customer[s.customer] if CALIBRATION_END < day <= HOLDOUT_END)
        for s in summaries
    ])
    zero = x == 0
    zero_group_size = int(zero.sum())
    zero_group_holdout = int(holdout[zero].sum())
    zero_group_mean = float(expected_purchases(params, holdout_weeks, x[zero], t_x[zero], T[zero]).mean())

    # Everything after each customer's first day counts as a repeat purchase.
    cumulative_actual = sum(
        sum(1 for day in days_by_customer[s.customer][1:] if day <= HOLDOUT_END) for s in summaries
    )
    # Each customer has been watched for T in calibration plus the holdout weeks.
    ages, counts = np.unique(T + holdout_weeks, return_counts=True)
    cumulative_expected = float(sum(
        count * expected_purchases_unconditional(params, float(age)) for age, count in zip(ages, counts)
    ))

    fitted = {"r": params.r, "alpha": params.alpha, "a": params.a, "b": params.b}
    within = (
        result.converged
        and all(abs(fitted[name] - PUBLISHED[name]) <= PARAMETER_TOLERANCE for name in fitted)
        and abs(result.log_likelihood - PUBLISHED["log_likelihood"]) <= LOG_LIKELIHOOD_TOLERANCE
        and zero_group_size == PUBLISHED["zero_group_size"]
        and zero_group_holdout == PUBLISHED["zero_group_holdout_purchases"]
        and abs(zero_group_mean - PUBLISHED["zero_group_predicted_mean"]) <= ZERO_GROUP_MEAN_TOLERANCE
    )
    return BenchmarkResult(
        params=params,
        log_likelihood=result.log_likelihood,
        published=dict(PUBLISHED),
        within_tolerance=bool(within),
        zero_group_size=zero_group_size,
        zero_group_holdout_purchases=zero_group_holdout,
        zero_group_predicted_mean=zero_group_mean,
        cumulative_week78_actual=int(cumulative_actual),
        cumulative_week78_expected=cumulative_expected,
        converged=result.converged,
        fit_message=result.message,
        fit_seconds=fit_seconds,
    )
