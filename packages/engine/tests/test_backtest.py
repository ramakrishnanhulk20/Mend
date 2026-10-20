# Not covered here: the real UCI numbers (prove_backtest runs all six cutoffs on the
# real file), whether a given cutoff's fit converges on real data, seasonality, and
# any lift from a campaign. A backtest on a fixed log tests the ranking, never a send.
import io
import math
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pytest
from hypothesis import given
from hypothesis import strategies as st
from openpyxl import Workbook

from mend_engine.data.uci import COLUMNS, SHEETS, XLSX_NAME
from mend_engine.model import backtest
from mend_engine.model.backtest import auc, decile_table, purchase_days_from_uci, run_cutoff
from mend_engine.model.bgnbd import FitResult, Params

D = date
CUT = D(2024, 6, 30)
# 91 days after the cutoff is 29 Sep 2024, the last day that counts as coming back.
HAND = {
    "steady": [D(2024, 3, 1), D(2024, 4, 1), D(2024, 5, 1), D(2024, 6, 1), D(2024, 6, 30), D(2024, 7, 15), D(2024, 8, 20)],
    "lapsed-back": [D(2024, 1, 5), D(2024, 1, 20), D(2024, 2, 10), D(2024, 8, 15)],
    "lapsed-gone": [D(2023, 12, 1), D(2023, 12, 20), D(2024, 1, 10), D(2024, 4, 1)],
    "nearly-lapsed": [D(2024, 1, 1), D(2024, 2, 1), D(2024, 4, 2)],
    "edge-in": [D(2024, 2, 1), D(2024, 3, 1), D(2024, 3, 15), D(2024, 9, 29)],
    "edge-out": [D(2024, 2, 2), D(2024, 3, 2), D(2024, 3, 16), D(2024, 9, 30)],
    "one-timer": [D(2024, 6, 1)],
    "two-days": [D(2024, 2, 1), D(2024, 2, 15)],
    "late": [D(2024, 7, 10), D(2024, 8, 1)],
}
# Every customer bought once before the cutoff, so nobody has a repeat to fit on.
ONE_TIMERS = {
    f"o{i}": [D(2024, 1, 1) + timedelta(days=9 * i)] + ([D(2024, 7, 1) + timedelta(days=i)] if i % 2 else [])
    for i in range(20)
}
SIM_CUT = D(2023, 12, 31)


def simulated_shop(customers: int = 600, seed: int = 7) -> dict[str, list[date]]:
    # Drawn from the BG/NBD story itself (gamma rates, beta dropout after each
    # purchase), so a working fit must rank these customers well.
    rng = np.random.default_rng(seed)
    start = D(2023, 1, 2)
    shop = {}
    for number in range(customers):
        rate = rng.gamma(0.8, 1 / 4.0)
        drop = rng.beta(0.5, 3.0)
        week = rng.uniform(0, 26)
        weeks = [week]
        while rng.random() >= drop:
            week += rng.exponential(1 / rate)
            if week > 65:
                break
            weeks.append(week)
        shop[f"c{number}"] = sorted({start + timedelta(days=int(w * 7)) for w in weeks})
    return shop


@pytest.mark.parametrize(
    ("scores", "did_not_return", "expected"),
    [
        ([1.0, 2.0, 3.0, 4.0], [0, 0, 1, 1], 1.0),
        ([4.0, 3.0, 2.0, 1.0], [0, 0, 1, 1], 0.0),
        ([5.0, 5.0, 5.0, 5.0], [0, 1, 0, 1], 0.5),
        # Pairs (gone, back): 0.35 > 0.1, 0.35 < 0.4, 0.8 > 0.1, 0.8 > 0.4, so 3 of 4.
        ([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1], 0.75),
        # Pairs: 2 > 1, 2 ties 2 (half), 3 > 1, 3 > 2, so 3.5 of 4.
        ([1.0, 2.0, 2.0, 3.0], [0, 1, 0, 1], 0.875),
    ],
)
def test_auc_hand_examples(scores: list, did_not_return: list, expected: float) -> None:
    assert auc(np.array(scores), np.array(did_not_return)) == expected
    assert auc(np.array(scores), np.array(did_not_return, dtype=bool)) == expected


@given(st.lists(st.tuples(st.integers(0, 4), st.booleans()), min_size=2, max_size=40))
def test_auc_matches_counting_every_pair(rows: list) -> None:
    scores = np.array([score for score, _ in rows], dtype=float)
    gone = np.array([label for _, label in rows])
    if gone.all() or not gone.any():
        return
    # Small integer scores make ties common, which is where a rank formula goes wrong.
    pairs = [(g, b) for g in scores[gone] for b in scores[~gone]]
    by_hand = sum(1.0 if g > b else 0.5 if g == b else 0.0 for g, b in pairs) / len(pairs)
    assert auc(scores, gone) == pytest.approx(by_hand, abs=1e-12)


@pytest.mark.parametrize(
    ("scores", "did_not_return"),
    [
        ([1.0, 2.0], [1, 1]),
        ([1.0, 2.0], [0, 0]),
        ([1.0, 2.0, 3.0], [0, 1]),
        ([1.0, float("nan")], [0, 1]),
        ([1.0, float("inf")], [0, 1]),
        ([1.0, 2.0], [0, 2]),
        ([1.0, 2.0], [0.0, 0.5]),
        ([[1.0, 2.0]], [[0, 1]]),
        (["a", "b"], [0, 1]),
    ],
)
def test_auc_refuses_input_it_cannot_score(scores: list, did_not_return: list) -> None:
    with pytest.raises(ValueError):
        auc(np.array(scores), np.array(did_not_return))


def test_run_cutoff_counts_known_returners_by_hand() -> None:
    result = run_cutoff(HAND, CUT)

    # "late" first bought after the cutoff, so 8 of the 9 are scored.
    assert result.customers == 8
    # Back within 91 days: steady (2 days), lapsed-back (1), edge-in on the last day (1).
    # edge-out comes back one day too late; late's days are not in the cohort.
    assert result.actual_purchase_days == 4
    # 3 or more days and silent 90 or more: lapsed-back 141, lapsed-gone exactly 90,
    # edge-in 107, edge-out 106. nearly-lapsed is silent 89; two-days has only 2 days.
    assert result.lapsed_regulars == 4
    assert result.lapsed_returned_share == 0.5
    # Gone, by days silent: 90, 89, 106, 29, 136. Back: 0, 141, 107. Every gone
    # customer beats steady (5 pairs) and only two-days beats edge-in (1), so 6 of 15.
    assert result.auc_recency == pytest.approx(0.4, abs=1e-12)
    assert (result.auc_model is None) == (result.predicted_purchase_days is None) == (not result.converged)


def test_a_fit_that_does_not_converge_is_reported_not_scored() -> None:
    result = run_cutoff(ONE_TIMERS, CUT)

    assert result.converged is False
    assert result.auc_model is None
    assert result.predicted_purchase_days is None
    assert result.customers == 20
    assert result.actual_purchase_days == 10
    assert 0.0 <= result.auc_recency <= 1.0
    assert result.lapsed_regulars == 0 and math.isnan(result.lapsed_returned_share)


def test_model_ranks_a_shop_drawn_from_its_own_story() -> None:
    result = run_cutoff(simulated_shop(), SIM_CUT)

    assert result.converged is True
    assert result.customers == 600
    assert result.auc_model > 0.8
    assert result.predicted_purchase_days == pytest.approx(result.actual_purchase_days, rel=0.15)


def test_decile_table_sums_to_the_customer_count() -> None:
    shop = simulated_shop()
    table = decile_table(shop, SIM_CUT)
    customers = run_cutoff(shop, SIM_CUT).customers

    assert [decile for decile, _, _ in table] == list(range(1, 11))
    assert sum(size for _, size, _ in table) == customers
    assert max(size for _, size, _ in table) - min(size for _, size, _ in table) <= 1
    assert all(0.0 <= rate <= 1.0 for _, _, rate in table)
    # Decile 1 is the least at risk, so it must come back more often than decile 10.
    assert table[0][2] > table[-1][2]


def test_decile_table_refuses_a_fit_that_did_not_converge() -> None:
    with pytest.raises(ValueError, match="did not converge"):
        decile_table(ONE_TIMERS, CUT)


def test_decile_table_refuses_fewer_than_ten_customers(monkeypatch: pytest.MonkeyPatch) -> None:
    fixed = FitResult(Params(r=0.5, alpha=5.0, a=0.5, b=3.0), 0.0, True, "converged: fixed for this test")
    monkeypatch.setattr(backtest, "fit", lambda *args, **kwargs: fixed)
    with pytest.raises(ValueError, match="at least 10"):
        decile_table(HAND, CUT)


@pytest.mark.parametrize(
    ("days", "cutoff", "holdout_days"),
    [
        (HAND, datetime(2024, 6, 30, 12, 0), 91),
        (HAND, CUT, 0),
        (HAND, CUT, True),
        (HAND, CUT, 91.0),
        (HAND, date.max, 91),
        (HAND, D(2020, 1, 1), 91),
        ({"a": [D(2024, 1, 1), D(2024, 1, 1)]}, CUT, 91),
        ({"a": [D(2024, 1, 1), D(2024, 7, 1)], "b": [D(2024, 2, 1), D(2024, 7, 2)]}, CUT, 91),
    ],
)
def test_run_cutoff_refuses_what_it_cannot_score(days: dict, cutoff: date, holdout_days: int) -> None:
    with pytest.raises(ValueError):
        run_cutoff(days, cutoff, holdout_days)


def write_source(path: Path, first: list, second: list) -> Path:
    workbook = Workbook()
    workbook.remove(workbook.active)
    for name, rows in zip(SHEETS, (first, second)):
        sheet = workbook.create_sheet(name)
        sheet.append(COLUMNS)
        for row in rows:
            sheet.append(row)
    buffer = io.BytesIO()
    workbook.save(buffer)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(XLSX_NAME, buffer.getvalue())
    return path


def test_purchase_days_from_uci_takes_each_invoice_once_on_its_own_date(tmp_path: Path) -> None:
    uk = "United Kingdom"
    first = [
        (489434, "85123A", "WHITE HANGING HEART", 6, datetime(2009, 12, 1, 7, 45), 2.55, 13085, uk),
        (489434, 21232, "TRINKET BOX", 24, datetime(2009, 12, 1, 7, 45), 1.25, 13085, uk),
        (489500, 22350, "CAT BOWL", 2, datetime(2009, 12, 1, 15, 0), 2.55, 13085, uk),
        ("C489449", 22087, "BUNTING", -12, datetime(2009, 12, 3, 9, 0), 2.95, 13085, uk),
        (536365, 22111, "HOT WATER BOTTLE", 1, datetime(2010, 12, 1, 8, 26), 4.25, 17850, uk),
    ]
    second = [
        # The second sheet's copy of 536365 is given another date here only so that
        # reading it twice would show up; in the real file both copies agree.
        (536365, 22111, "HOT WATER BOTTLE", 1, datetime(2010, 12, 2, 8, 26), 4.25, 17850, uk),
        (540000, 22112, "MUG", 3, datetime(2011, 1, 5, 10, 0), 1.5, 17850, uk),
        (540001, 22113, "MUG", 3, datetime(2011, 1, 6, 10, 0), 1.5, 9999, uk),
    ]

    days = purchase_days_from_uci(write_source(tmp_path / "s.zip", first, second))

    assert list(days) == ["9999", "13085", "17850"]
    assert days == {
        "9999": [D(2011, 1, 6)],
        "13085": [D(2009, 12, 1)],
        "17850": [D(2010, 12, 1), D(2011, 1, 5)],
    }
