# Not covered here: the real UCI numbers and the verdicts they give (python -m
# mend_engine.model.segment prints them), whether any ranking would raise a
# campaign's lift (a ranking test on a fixed log never sends anything), and the
# bootstrap's coverage. The segment uses the day rules only: no membership, no refunds.
import math
from datetime import timedelta

import numpy as np
import pytest
from test_backtest import SIM_CUT, simulated_shop

from mend_engine.campaigns import eligibility
from mend_engine.model import backtest, segment
from mend_engine.model.backtest import auc, run_cutoff
from mend_engine.model.bgnbd import FitResult, Params
from mend_engine.model.segment import BASELINE, beats_recency, compare_rankings, probability_alive, report

CUTOFFS = (SIM_CUT - timedelta(days=182), SIM_CUT - timedelta(days=91), SIM_CUT)


@pytest.fixture(scope="module")
def shop() -> dict:
    return simulated_shop()


def test_probability_alive_matches_the_papers_formula_by_hand() -> None:
    params = Params(r=0.243, alpha=4.414, a=0.793, b=2.426)
    x, t_x, T = np.array([0.0, 2.0, 2.0]), np.array([0.0, 30.43, 10.0]), np.array([38.86, 38.86, 38.86])

    found = probability_alive(params, x, t_x, T)

    def by_hand(x: float, t_x: float) -> float:
        odds = params.a / (params.b + x - 1) * ((params.alpha + 38.86) / (params.alpha + t_x)) ** (params.r + x)
        return 1 / (1 + odds)

    assert found[0] == 1.0
    assert found[1] == pytest.approx(by_hand(2, 30.43), rel=1e-12)
    assert found[2] == pytest.approx(by_hand(2, 10.0), rel=1e-12)
    # The same two purchases, the last one longer ago: less likely still active.
    assert found[2] < found[1]
    with pytest.raises(ValueError):
        probability_alive(params, np.array([1.0]), np.array([5.0]), np.array([4.0]))


@pytest.mark.parametrize(
    ("wins", "low", "beats"),
    [(4, 0.001, True), (5, 0.02, True), (3, 0.05, False), (5, 0.0, False), (5, -0.01, False), (4, None, False)],
)
def test_the_rule_needs_four_wins_and_a_pooled_interval_wholly_above_zero(wins: int, low: float | None, beats: bool) -> None:
    assert beats_recency(wins, low) is beats


def test_every_ranking_is_measured_inside_the_live_segment_against_recency(shop: dict) -> None:
    comparison = compare_rankings(shop, CUTOFFS)
    rows = {r.name: r for r in comparison.rankings}

    assert [r.name for r in comparison.rankings] == [r.name for r in segment.RANKINGS]
    for at_cutoff in comparison.cutoffs:
        live = run_cutoff(shop, at_cutoff.cutoff).live_segment
        assert (at_cutoff.customers, at_cutoff.returned, at_cutoff.left_out) == (live.customers, live.returned, None)
    baseline = rows[BASELINE]
    assert all((c.difference, c.low, c.high) == (0.0, 0.0, 0.0) for c in baseline.cutoffs)
    assert (baseline.wins, baseline.low, baseline.high, baseline.beats_recency) == (0, 0.0, 0.0, False)
    for c in rows["expected purchases"].cutoffs:
        live = run_cutoff(shop, c.cutoff).live_segment
        # Today's ranking measured here is exactly rule 1's live-segment model number.
        assert (c.auc, c.difference, c.low, c.high) == (live.auc_model, live.difference, live.low, live.high)
    for c in rows["frequency"].cutoffs:
        seen = {k: [d for d in days if d <= c.cutoff] for k, days in shop.items()}
        members = [
            k for k, days in seen.items()
            if len(days) >= eligibility.REGULAR_MIN_DAYS and (c.cutoff - days[-1]).days >= eligibility.SILENT_MIN_DAYS
        ]
        end = c.cutoff + timedelta(days=91)
        gone = np.array([not any(c.cutoff < d <= end for d in shop[k]) for k in members])
        assert c.auc == auc(np.array([len(seen[k]) for k in members], dtype=float), gone)
    for row in comparison.rankings:
        assert len(row.cutoffs) == 3 and row.mean_difference == pytest.approx(sum(c.difference for c in row.cutoffs) / 3, abs=1e-15)
        assert row.low <= row.high and all(math.isfinite(c.auc) for c in row.cutoffs)
    lines = report(comparison)
    assert sum(1 for line in lines if "does not beat recency" in line or line.rstrip().endswith(" beats recency")) == 4


def test_a_cutoff_whose_fit_did_not_converge_is_left_out_for_every_ranking(monkeypatch: pytest.MonkeyPatch, shop: dict) -> None:
    real_fit, calls = backtest.fit, []

    def first_fit_fails(*args, **kwargs) -> FitResult:
        found = real_fit(*args, **kwargs)
        calls.append(found)
        return found if len(calls) > 1 else FitResult(found.params, found.log_likelihood, False, "not converged: forced for this test")

    monkeypatch.setattr(backtest, "fit", first_fit_fails)
    comparison = compare_rankings(shop, CUTOFFS)

    assert comparison.cutoffs[0].left_out == "the fit did not converge"
    assert all([c.cutoff for c in row.cutoffs] == list(CUTOFFS[1:]) for row in comparison.rankings)
    with pytest.raises(ValueError):
        compare_rankings(shop, ())
    with pytest.raises(ValueError):
        compare_rankings(shop, (SIM_CUT, SIM_CUT))
