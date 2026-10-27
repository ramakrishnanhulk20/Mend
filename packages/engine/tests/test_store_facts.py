# Not covered here: the real UCI and CDNOW numbers (python -m mend_engine.store_facts
# computes them from the real files), the database round trip and shop_summary
# (test_tasks.py stores and reads rows), and how the website shows the new keys.
import json
from datetime import timedelta
from pathlib import Path

import pytest
from test_backtest import SIM_CUT, simulated_shop

from mend_engine import prove_backtest, store_facts
from mend_engine.campaigns import eligibility
from mend_engine.model.backtest import RESAMPLES, run_backtest
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

    assert set(fact) == OLD_KEYS | {"headline", "all_customers"}
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
