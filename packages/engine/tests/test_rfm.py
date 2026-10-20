# Not covered here: merging same-day rows (the caller does that, see benchmark.py),
# time zones, and real shop logs. The CDNOW summaries are checked in test_benchmark.py.
from datetime import date, datetime

import pytest

from mend_engine.model.rfm import Summary, summarise

END = date(2024, 3, 31)


def test_hand_example_with_three_customers() -> None:
    days = {
        "one-timer": [date(2024, 1, 1)],
        "regular": [date(2024, 2, 12), date(2024, 4, 10), date(2024, 1, 1), date(2024, 1, 15)],
        "too-late": [date(2024, 4, 2), date(2024, 4, 9)],
    }

    result = summarise(days, END)

    # 1 Jan to 31 Mar 2024 is 90 days (a leap year), so T is 90 / 7 weeks for both.
    # The regular's last repeat inside the window is 12 Feb, 42 days after the first.
    # The 10 Apr purchase is after the end and does not count.
    assert result == [
        Summary(customer="one-timer", x=0, t_x=0.0, T=90 / 7),
        Summary(customer="regular", x=2, t_x=6.0, T=90 / 7),
    ]


def test_first_purchase_on_the_last_day_is_kept_with_zero_age() -> None:
    assert summarise({"late": [END]}, END) == [Summary(customer="late", x=0, t_x=0.0, T=0.0)]


def test_unit_days_sets_the_time_scale() -> None:
    days = {"regular": [date(2024, 1, 1), date(2024, 1, 15)]}
    assert summarise(days, END, unit_days=1.0) == [Summary(customer="regular", x=1, t_x=14.0, T=90.0)]


@pytest.mark.parametrize(
    "days",
    [
        {"dup": [date(2024, 1, 1), date(2024, 1, 1)]},
        {"empty": []},
        {"clock": [datetime(2024, 1, 1, 9, 30)]},
        {"text": ["2024-01-01"]},
        {7: [date(2024, 1, 1)]},
    ],
)
def test_refuses_bad_days(days: dict) -> None:
    with pytest.raises(ValueError):
        summarise(days, END)


@pytest.mark.parametrize("unit_days", [0.0, -7.0, float("nan"), float("inf"), True])
def test_refuses_bad_unit_days(unit_days: float) -> None:
    with pytest.raises(ValueError):
        summarise({"a": [date(2024, 1, 1)]}, END, unit_days=unit_days)


def test_refuses_a_datetime_calibration_end() -> None:
    with pytest.raises(ValueError):
        summarise({"a": [date(2024, 1, 1)]}, datetime(2024, 3, 31, 23, 59))
