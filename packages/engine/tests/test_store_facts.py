# Not covered here: the real UCI and CDNOW numbers (python -m mend_engine.store_facts
# computes them from the real files), the database round trip and shop_summary
# (test_tasks.py stores and reads rows), and how the website shows the new keys.
import dataclasses
import json
from datetime import date, timedelta
from pathlib import Path

import pytest
from test_backtest import SIM_CUT, simulated_shop

from mend_engine import prove_backtest, store_facts
from mend_engine.campaigns import eligibility
from mend_engine.campaigns.scoring import HORIZON_WEEKS
from mend_engine.model.backtest import (
    FORECAST_GROUPS,
    RESAMPLES,
    ForecastGroups,
    GroupCount,
    groups_rise,
    pooled_groups,
    run_backtest,
)
from mend_engine.store_facts import UCI_KEY, checked_fact

CUTOFFS = (SIM_CUT - timedelta(days=91), SIM_CUT)
OLD_KEYS = {"source", "holdout_days", "cutoffs", "converged", "model_wins", "mean_auc_gain", "decile_cutoff", "deciles", "passed"}


@pytest.fixture(scope="module")
def shop() -> dict:
    return simulated_shop()


@pytest.fixture
def fact(monkeypatch: pytest.MonkeyPatch, shop: dict) -> dict:
    monkeypatch.setattr(store_facts, "ensure_source", lambda cache: Path("unused.zip"))
    monkeypatch.setattr(store_facts, "purchase_days_from_uci", lambda path: shop)
    monkeypatch.setattr(prove_backtest, "CUTOFFS", CUTOFFS)
    return store_facts.uci_fact()


def test_the_headline_is_the_live_segment_and_the_all_customer_result_is_labelled(fact: dict, shop: dict) -> None:
    run = run_backtest(shop, CUTOFFS, prove_backtest.HOLDOUT_DAYS)
    headline, everyone = fact["headline"], fact["all_customers"]

    assert set(fact) == OLD_KEYS | {"headline", "all_customers", "bands"}
    assert (headline["group"], headline["regular_min_days"], headline["silent_min_days"]) == (
        "live segment", eligibility.REGULAR_MIN_DAYS, eligibility.SILENT_MIN_DAYS,
    )
    assert (everyone["group"], everyone["regular_min_days"], everyone["silent_min_days"]) == ("all customers", None, None)
    for block, summary, group in ((headline, run.live_segment, "live_segment"), (everyone, run.all_customers, "all_customers")):
        assert (block["confidence"], block["resamples"]) == (0.95, RESAMPLES)
        assert block["valid_cutoffs"] == summary.valid == 2
        assert block["model_wins"] == summary.model_wins
        assert (block["mean_auc_difference"], block["interval_low"], block["interval_high"]) == (summary.mean_difference, summary.low, summary.high)
        for entry, result in zip(block["cutoffs"], run.results, strict=True):
            measured = getattr(result, group)
            assert entry == {
                "cutoff": result.cutoff.isoformat(),
                "customers": measured.customers,
                "returned": measured.returned,
                "auc_model": measured.auc_model,
                "auc_recency": measured.auc_recency,
                "difference": measured.difference,
                "interval_low": measured.low,
                "interval_high": measured.high,
            }
    # The existing keys keep their meaning: every one of them is the all-customer result.
    for entry, result in zip(fact["cutoffs"], run.results, strict=True):
        assert (entry["auc_model"], entry["auc_recency"]) == (result.auc_model, result.auc_recency)
    assert fact["model_wins"] == everyone["model_wins"] and fact["mean_auc_gain"] == pytest.approx(everyone["mean_auc_difference"])
    assert headline["cutoffs"][0]["customers"] < everyone["cutoffs"][0]["customers"]
    json.dumps(fact, allow_nan=False)
    assert checked_fact(UCI_KEY, fact) is fact


def test_the_checker_reads_rows_from_before_and_refuses_a_headline_that_is_not_the_live_rule(fact: dict) -> None:
    old = {key: value for key, value in fact.items() if key in OLD_KEYS}
    headline = fact["headline"]
    first = headline["cutoffs"][0]

    assert checked_fact(UCI_KEY, old) is old
    for broken in (
        {**old, "headline": headline},
        {**fact, "headline": fact["all_customers"]},
        {**fact, "all_customers": headline},
        {**fact, "headline": {**headline, "silent_min_days": 90}},
        {**fact, "headline": {**headline, "model_wins": headline["valid_cutoffs"] + 1}},
        {**fact, "headline": {**headline, "cutoffs": headline["cutoffs"][1:]}},
        {**fact, "headline": {**headline, "cutoffs": [{**first, "returned": first["customers"] + 1}, *headline["cutoffs"][1:]]}},
        {**fact, "headline": {**headline, "interval_low": 0.5, "interval_high": 0.1}},
    ):
        assert checked_fact(UCI_KEY, broken) is None


def counted(entry: dict | None) -> GroupCount | None:
    return None if entry is None else GroupCount(entry["customers"], entry["returned"])


def with_band_cutoffs(fact: dict, cutoffs: list) -> dict:
    # Pooled and rising are worked out again from the new cutoffs, so only the change under test can break the fact.
    groups = [
        ForecastGroups(date.fromisoformat(e["cutoff"]), e["converged"], **{name: counted(e[name]) for name in FORECAST_GROUPS})
        for e in cutoffs
    ]
    pooled = pooled_groups(groups)
    pooled_fact = {name: {"customers": pooled[name].customers, "returned": pooled[name].returned} for name in FORECAST_GROUPS}
    return {**fact, "bands": {**fact["bands"], "cutoffs": cutoffs, "pooled": pooled_fact, "rising": groups_rise(pooled)}}


def test_the_bands_are_the_forecast_groups_under_todays_cut_offs(fact: dict, shop: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    run = run_backtest(shop, CUTOFFS, prove_backtest.HOLDOUT_DAYS)
    bands = fact["bands"]
    rules = ("likely_gone_below", "likely_back_from", "regular_min_days", "silent_min_days", "horizon_weeks")
    today = (eligibility.LIKELY_GONE_BELOW, eligibility.LIKELY_BACK_FROM, eligibility.REGULAR_MIN_DAYS, eligibility.SILENT_MIN_DAYS, HORIZON_WEEKS)

    assert [(bands[key], type(bands[key])) for key in rules] == [(value, type(value)) for value in today]
    assert [(e["cutoff"], e["converged"]) for e in bands["cutoffs"]] == [(r.cutoff.isoformat(), r.groups.converged) for r in run.results]
    for entry, result in zip(bands["cutoffs"], run.results, strict=True):
        assert {name: counted(entry[name]) for name in FORECAST_GROUPS} == {name: getattr(result.groups, name) for name in FORECAST_GROUPS}
    assert {name: counted(count) for name, count in bands["pooled"].items()} == run.groups_pooled
    assert bands["rising"] is run.groups_rise is True
    json.dumps(fact, allow_nan=False)
    assert checked_fact(UCI_KEY, fact) is fact

    # With the AUC bar met, passed now turns on whether the forecast groups rise.
    monkeypatch.setattr(prove_backtest, "MIN_CONVERGED", len(CUTOFFS))
    assert store_facts.uci_fact()["passed"] is True
    real_run = store_facts.run_backtest

    def no_groups(*args, **kwargs):
        found = real_run(*args, **kwargs)
        quiet = tuple(dataclasses.replace(r, groups=ForecastGroups(r.cutoff, False, None, None, None)) for r in found.results)
        return dataclasses.replace(found, results=quiet, groups_pooled=pooled_groups([]), groups_rise=False)

    monkeypatch.setattr(store_facts, "run_backtest", no_groups)
    flat = store_facts.uci_fact()
    assert flat["passed"] is False and flat["bands"]["rising"] is False
    assert checked_fact(UCI_KEY, flat) is flat


def test_a_fact_from_before_the_bands_still_reads(fact: dict) -> None:
    without = {key: value for key, value in fact.items() if key != "bands"}
    assert checked_fact(UCI_KEY, without) is without


def test_bands_that_do_not_match_todays_rule_or_their_own_sums_read_as_missing(fact: dict) -> None:
    bands = fact["bands"]
    entries = bands["cutoffs"]
    first = entries[0]
    gone = first["likely_gone"]
    pooled_back = bands["pooled"]["likely_back"]
    old = {key: value for key, value in fact.items() if key in OLD_KEYS}

    # The rebuild alone keeps a good fact good, so each case below fails for its own reason.
    assert checked_fact(UCI_KEY, with_band_cutoffs(fact, entries)) is not None
    assert first["converged"] is True
    for broken in (
        {**fact, "bands": {**bands, "likely_gone_below": 0.2}},
        {**fact, "bands": {**bands, "likely_back_from": 1}},
        {**fact, "bands": {**bands, "regular_min_days": 3.0}},
        {**fact, "bands": {**bands, "horizon_weeks": 26}},
        {**fact, "bands": {**bands, "pooled": {**bands["pooled"], "likely_back": {**pooled_back, "customers": pooled_back["customers"] + 1}}}},
        {**fact, "bands": {**bands, "rising": not bands["rising"]}},
        with_band_cutoffs(fact, [{**first, "likely_gone": {**gone, "returned": gone["customers"] + 1}}, *entries[1:]]),
        with_band_cutoffs(fact, [{**first, "converged": False}, *entries[1:]]),
        {**fact, "bands": {**bands, "note": "extra"}},
        with_band_cutoffs(fact, [{**first, "likely_gone": {**gone, "share": 0.0}}, *entries[1:]]),
        {**fact, "bands": {**bands, "cutoffs": entries[::-1]}},
        with_band_cutoffs(fact, entries[1:]),
        {**old, "bands": bands},
        {**fact, "bands": None},
    ):
        assert checked_fact(UCI_KEY, broken) is None
