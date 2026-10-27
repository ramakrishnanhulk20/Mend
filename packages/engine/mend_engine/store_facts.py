"""Stores the model's headline proof numbers for the landing page: python -m mend_engine.store_facts

Runs the same work as prove_model (our BG/NBD code against the CDNOW numbers Fader,
Hardie and Lee published) and prove_backtest (the rolling backtest on the real UCI
shop), by calling their functions, and writes one model_facts row for each:
"cdnow_benchmark" and "uci_backtest". Each row is stored with the verdict of its own
proof, pass or fail, because the landing page shows what was measured, never a
number nobody measured (6j). A proof that could not run at all stores nothing.

The backtest row's headline is "headline": the model against recency inside the
live segment, the customers campaigns actually rank, with 95 percent intervals.
"all_customers" is the same measure over every customer, labelled as such. The
older keys keep their meaning: cutoffs, converged, model_wins and mean_auc_gain
are the all-customer numbers, deciles the all-customer decile table, and passed
prove_backtest's own bar, which is about all customers.

shop_summary reads the rows back through read_facts(), which checks each one against
the exact shape written here, so a row of any other shape is treated as missing.
Prints what it stored and ends with STORE FACTS RESULT: PASS only if both proofs met
their own bar and both rows were written. Calls no PayPal API.
"""

from __future__ import annotations

import json
import math
import sys
from collections.abc import Callable
from datetime import date, timezone
from pathlib import Path

import httpx
import psycopg
from psycopg.types.json import Jsonb

from mend_engine import prove_backtest, prove_model
from mend_engine.config import ConfigError, load_config
from mend_engine.data.uci import CACHE_DIR, SourceError, ensure_source
from mend_engine.db.connect import connect
from mend_engine.db.migrate import migrate
from mend_engine.campaigns import eligibility
from mend_engine.model.backtest import (
    CONFIDENCE,
    RESAMPLES,
    Backtest,
    GroupResult,
    decile_table,
    purchase_days_from_uci,
    run_backtest,
)
from mend_engine.model.benchmark import PUBLISHED, SAMPLE_CUSTOMERS, reproduce

ENV_PATH = Path(__file__).resolve().parents[3] / ".env"
CDNOW_KEY = "cdnow_benchmark"
UCI_KEY = "uci_backtest"
CDNOW_SOURCE = "CDNOW sample, Fader, Hardie and Lee (2005)"
UCI_SOURCE = "UCI Online Retail II (Chen 2012, CC BY 4.0)"
PARAMETERS = ("r", "alpha", "a", "b", "log_likelihood")
UCI_KEYS = frozenset({"source", "holdout_days", "cutoffs", "converged", "model_wins", "mean_auc_gain", "decile_cutoff", "deciles", "passed"})
# Rows stored before these two keys existed are still read; a row with only one of them is not.
UCI_GROUP_KEYS = frozenset({"headline", "all_customers"})
LIVE_SEGMENT = "live segment"
ALL_CUSTOMERS = "all customers"
_GROUP_KEYS = frozenset({
    "group", "regular_min_days", "silent_min_days", "confidence", "resamples", "valid_cutoffs",
    "model_wins", "mean_auc_difference", "interval_low", "interval_high", "cutoffs",
})
_GROUP_CUTOFF_KEYS = frozenset({
    "cutoff", "customers", "returned", "auc_model", "auc_recency", "difference", "interval_low", "interval_high",
})

_UPSERT = (
    "insert into model_facts (key, value) values (%s, %s) "
    "on conflict (key) do update set value = excluded.value, computed_at = now() returning computed_at"
)


def cdnow_fact() -> dict:
    """The CDNOW reproduction: our fitted parameters beside the published ones, and prove_model's verdict.

    Raises OSError, ValueError or httpx.HTTPError when the sample cannot be read.
    """
    path = prove_model.find_sample()
    data_ok = prove_model.check_data(path)
    result = reproduce(path)
    checks = [
        data_ok,
        prove_model.check_fit(result),
        prove_model.check_zero_group(result),
        prove_model.check_cumulative(result),
        prove_model.check_runaway_guard(),
    ]
    p = result.params
    return {
        "source": CDNOW_SOURCE,
        "customers": SAMPLE_CUSTOMERS,
        # float() because the fit hands back numpy numbers, which read_facts would not accept as written.
        "fitted": {name: float(value) for name, value in zip(PARAMETERS, (p.r, p.alpha, p.a, p.b, result.log_likelihood))},
        "published": {name: float(PUBLISHED[name]) for name in PARAMETERS},
        "passed": bool(all(checks) and result.within_tolerance),
    }


def uci_fact() -> dict:
    """The backtest at prove_backtest's cutoffs: AUC of the model against recency, and the latest decile table.

    headline is the live segment's result and all_customers the all-customer one,
    each per cutoff and pooled, with 95 percent bootstrap intervals (see
    _group_fact). Raises SourceError or ValueError when the UCI file cannot be read
    or scored.
    """
    days = purchase_days_from_uci(ensure_source(CACHE_DIR))
    run = run_backtest(days, prove_backtest.CUTOFFS, prove_backtest.HOLDOUT_DAYS)
    results = run.results
    for result in results:
        print(prove_backtest.cutoff_line(result), flush=True)
    converged = [r for r in results if r.converged]
    wins = sum(1 for r in converged if r.auc_model > r.auc_recency)
    gains = [r.auc_model - r.auc_recency for r in converged]
    latest = converged[-1].cutoff if converged else None
    deciles = decile_table(days, latest, prove_backtest.HOLDOUT_DAYS) if latest else []
    return {
        "source": UCI_SOURCE,
        "holdout_days": prove_backtest.HOLDOUT_DAYS,
        "cutoffs": [
            {
                "cutoff": r.cutoff.isoformat(),
                "customers": r.customers,
                "converged": r.converged,
                "auc_model": None if r.auc_model is None else float(r.auc_model),
                "auc_recency": float(r.auc_recency),
            }
            for r in results
        ],
        "converged": len(converged),
        "model_wins": wins,
        "mean_auc_gain": float(sum(gains) / len(gains)) if gains else None,
        "decile_cutoff": latest.isoformat() if latest else None,
        "deciles": [{"decile": n, "customers": int(size), "returned_share": float(rate)} for n, size, rate in deciles],
        "passed": len(converged) >= prove_backtest.MIN_CONVERGED and wins == len(converged),
        "headline": _group_fact(run, "live_segment"),
        "all_customers": _group_fact(run, "all_customers"),
    }


def _group_fact(run: Backtest, name: str) -> dict:
    """One group's record: per cutoff and pooled over the valid cutoffs, model minus recency with its interval.

    regular_min_days and silent_min_days are the live rule for the live segment and
    None for all customers. A valid cutoff is one where the difference is defined:
    the fit converged and the group holds customers who came back and customers who
    did not. Interval bounds are None where the group was too small to resample.
    """
    summary = getattr(run, name)
    live = name == "live_segment"
    return {
        "group": LIVE_SEGMENT if live else ALL_CUSTOMERS,
        "regular_min_days": eligibility.REGULAR_MIN_DAYS if live else None,
        "silent_min_days": eligibility.SILENT_MIN_DAYS if live else None,
        "confidence": CONFIDENCE,
        "resamples": RESAMPLES,
        "valid_cutoffs": summary.valid,
        "model_wins": summary.model_wins,
        "mean_auc_difference": summary.mean_difference,
        "interval_low": summary.low,
        "interval_high": summary.high,
        "cutoffs": [_group_cutoff_fact(result.cutoff, getattr(result, name)) for result in run.results],
    }


def _group_cutoff_fact(cutoff: date, group: GroupResult) -> dict:
    return {
        "cutoff": cutoff.isoformat(),
        "customers": group.customers,
        "returned": group.returned,
        "auc_model": group.auc_model,
        "auc_recency": group.auc_recency,
        "difference": group.difference,
        "interval_low": group.low,
        "interval_high": group.high,
    }


def _number(value: object) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _day(value: object) -> bool:
    try:
        return type(value) is str and date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def _whole(value: object, low: int = 0) -> bool:
    return type(value) is int and value >= low


def _between(value: object, low: float, high: float) -> bool:
    return _number(value) and low <= value <= high


def _bounds_ok(low: object, high: object) -> bool:
    return (low is None and high is None) or (_between(low, -1, 1) and _between(high, -1, 1) and low <= high)


def _cdnow_ok(value: dict) -> bool:
    return (
        set(value) == {"source", "customers", "fitted", "published", "passed"}
        and value["source"] == CDNOW_SOURCE
        and _whole(value["customers"], 1)
        and type(value["passed"]) is bool
        and all(
            type(value[side]) is dict and set(value[side]) == set(PARAMETERS) and all(_number(v) for v in value[side].values())
            for side in ("fitted", "published")
        )
    )


def _cutoff_ok(entry: object) -> bool:
    return (
        type(entry) is dict
        and set(entry) == {"cutoff", "customers", "converged", "auc_model", "auc_recency"}
        and _day(entry["cutoff"])
        and _whole(entry["customers"])
        and type(entry["converged"]) is bool
        and (_number(entry["auc_model"]) if entry["converged"] else entry["auc_model"] is None)
        and _number(entry["auc_recency"])
    )


def _decile_ok(entry: object) -> bool:
    return (
        type(entry) is dict
        and set(entry) == {"decile", "customers", "returned_share"}
        and _whole(entry["decile"], 1)
        and _whole(entry["customers"])
        and _number(entry["returned_share"])
        and 0 <= entry["returned_share"] <= 1
    )


def _group_cutoff_ok(entry: object) -> bool:
    if type(entry) is not dict or set(entry) != _GROUP_CUTOFF_KEYS:
        return False
    measured = entry["auc_model"] is not None and entry["auc_recency"] is not None
    return (
        _day(entry["cutoff"])
        and _whole(entry["customers"])
        and _whole(entry["returned"])
        and entry["returned"] <= entry["customers"]
        and all(entry[key] is None or _between(entry[key], 0, 1) for key in ("auc_model", "auc_recency"))
        and (_between(entry["difference"], -1, 1) if measured else entry["difference"] is None)
        and _bounds_ok(entry["interval_low"], entry["interval_high"])
        and (measured or entry["interval_low"] is None)
    )


def _group_ok(value: object, label: str, rule: tuple[int | None, int | None], days: list) -> bool:
    if type(value) is not dict or set(value) != _GROUP_KEYS or value["group"] != label:
        return False
    if type(value["cutoffs"]) is not list or not all(_group_cutoff_ok(entry) for entry in value["cutoffs"]):
        return False
    differences = [entry["difference"] for entry in value["cutoffs"] if entry["difference"] is not None]
    return (
        [entry["cutoff"] for entry in value["cutoffs"]] == days
        and all(type(stored) is type(wanted) and stored == wanted for stored, wanted in zip((value["regular_min_days"], value["silent_min_days"]), rule))
        and value["confidence"] == CONFIDENCE
        and type(value["resamples"]) is int and value["resamples"] == RESAMPLES
        and value["valid_cutoffs"] == len(differences)
        and value["model_wins"] == sum(1 for d in differences if d > 0)
        and (_between(value["mean_auc_difference"], -1, 1) if differences else value["mean_auc_difference"] is None)
        and _bounds_ok(value["interval_low"], value["interval_high"])
        and (bool(differences) or value["interval_low"] is None)
    )


def _uci_ok(value: dict) -> bool:
    keys = set(value)
    if keys not in (UCI_KEYS, UCI_KEYS | UCI_GROUP_KEYS):
        return False
    if keys == UCI_KEYS | UCI_GROUP_KEYS:
        # The headline must describe the rule campaigns use today, so a row stored
        # under an older rule reads as missing rather than as today's number.
        days = [entry["cutoff"] for entry in value["cutoffs"]] if type(value["cutoffs"]) is list else None
        live_rule = (eligibility.REGULAR_MIN_DAYS, eligibility.SILENT_MIN_DAYS)
        if not (
            _group_ok(value["headline"], LIVE_SEGMENT, live_rule, days)
            and _group_ok(value["all_customers"], ALL_CUSTOMERS, (None, None), days)
        ):
            return False
    return (
        value["source"] == UCI_SOURCE
        and _whole(value["holdout_days"], 1)
        and type(value["cutoffs"]) is list
        and 1 <= len(value["cutoffs"]) <= 20
        and all(_cutoff_ok(entry) for entry in value["cutoffs"])
        and _whole(value["converged"])
        and _whole(value["model_wins"])
        and (value["mean_auc_gain"] is None or _number(value["mean_auc_gain"]))
        and (value["decile_cutoff"] is None or _day(value["decile_cutoff"]))
        and type(value["deciles"]) is list
        and len(value["deciles"]) <= 10
        and all(_decile_ok(entry) for entry in value["deciles"])
        and type(value["passed"]) is bool
    )


_CHECKS: dict[str, Callable[[dict], bool]] = {CDNOW_KEY: _cdnow_ok, UCI_KEY: _uci_ok}


def checked_fact(key: str, value: object) -> dict | None:
    """value if it has exactly the shape store_facts writes for key, otherwise None."""
    check = _CHECKS.get(key)
    if check is None or type(value) is not dict:
        return None
    try:
        return value if check(value) else None
    except (TypeError, KeyError):
        return None


def read_facts(conn: psycopg.Connection) -> dict[str, dict | None]:
    """Each stored fact, with computed_at (UTC, ISO 8601) added, or None when missing or of the wrong shape."""
    rows = {key: (value, at) for key, value, at in conn.execute("select key, value, computed_at from model_facts where key = any(%s)", (list(_CHECKS),))}
    facts: dict[str, dict | None] = {}
    for key in _CHECKS:
        value, at = rows.get(key, (None, None))
        fact = checked_fact(key, value)
        facts[key] = None if fact is None else {**fact, "computed_at": at.astimezone(timezone.utc).isoformat()}
    return facts


def store(conn: psycopg.Connection, key: str, value: dict) -> str:
    """Write one fact, replacing any earlier one, and return its computed_at. Refuses a value of the wrong shape."""
    json.dumps(value, allow_nan=False)
    if checked_fact(key, value) is None:
        raise ValueError(f"{key} does not have the shape read_facts accepts")
    with conn.transaction():
        return conn.execute(_UPSERT, (key, Jsonb(value))).fetchone()[0].isoformat()


def run() -> bool:
    try:
        config = load_config(str(ENV_PATH) if ENV_PATH.is_file() else None)
    except ConfigError as exc:
        print(f"FAIL: {exc}")
        return False
    stored: list[bool] = []
    try:
        migrate(config)
        conn = connect(config)
    except psycopg.Error as exc:
        print(f"FAIL: the database could not be reached ({type(exc).__name__})")
        return False
    with conn:
        for key, compute, failures in (
            (CDNOW_KEY, cdnow_fact, (OSError, ValueError, httpx.HTTPError)),
            (UCI_KEY, uci_fact, (OSError, SourceError, ValueError)),
        ):
            try:
                value = compute()
            except failures as exc:
                print(f"FAIL: {key} could not be computed, nothing stored for it ({type(exc).__name__}: {exc})", flush=True)
                stored.append(False)
                continue
            at = store(conn, key, value)
            print(f"stored {key} at {at}: {json.dumps(value, sort_keys=True)}", flush=True)
            if not value["passed"]:
                print(f"FAIL: {key} was stored with passed false: its proof did not meet its own bar", flush=True)
            stored.append(value["passed"])
    return len(stored) == len(_CHECKS) and all(stored)


def main() -> int:
    passed = run()
    print(f"STORE FACTS RESULT: {'PASS' if passed else 'FAIL'}", flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
