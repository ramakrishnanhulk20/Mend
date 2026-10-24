"""Stores the model's headline proof numbers for the landing page: python -m mend_engine.store_facts

Runs the same work as prove_model (our BG/NBD code against the CDNOW numbers Fader,
Hardie and Lee published) and prove_backtest (the rolling backtest on the real UCI
shop), by calling their functions, and writes one model_facts row for each:
"cdnow_benchmark" and "uci_backtest". Each row is stored with the verdict of its own
proof, pass or fail, because the landing page shows what was measured, never a
number nobody measured (6j). A proof that could not run at all stores nothing.

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
from mend_engine.model.backtest import decile_table, purchase_days_from_uci, run_cutoff
from mend_engine.model.benchmark import PUBLISHED, SAMPLE_CUSTOMERS, reproduce

ENV_PATH = Path(__file__).resolve().parents[3] / ".env"
CDNOW_KEY = "cdnow_benchmark"
UCI_KEY = "uci_backtest"
CDNOW_SOURCE = "CDNOW sample, Fader, Hardie and Lee (2005)"
UCI_SOURCE = "UCI Online Retail II (Chen 2012, CC BY 4.0)"
PARAMETERS = ("r", "alpha", "a", "b", "log_likelihood")

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

    Raises SourceError or ValueError when the UCI file cannot be read or scored.
    """
    days = purchase_days_from_uci(ensure_source(CACHE_DIR))
    results = [run_cutoff(days, cutoff, prove_backtest.HOLDOUT_DAYS) for cutoff in prove_backtest.CUTOFFS]
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


def _uci_ok(value: dict) -> bool:
    keys = {"source", "holdout_days", "cutoffs", "converged", "model_wins", "mean_auc_gain", "decile_cutoff", "deciles", "passed"}
    return (
        set(value) == keys
        and value["source"] == UCI_SOURCE
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
