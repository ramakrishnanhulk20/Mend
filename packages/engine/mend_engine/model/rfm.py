"""Turns each customer's purchase days into the three numbers the BG/NBD model reads."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime


@dataclass(frozen=True)
class Summary:
    """One customer's history at the calibration end.

    x is the number of repeat purchase days (the first day is the trial, not a repeat),
    t_x is the time from the first purchase to the last repeat (0 when x is 0), and
    T is the time from the first purchase to the calibration end. Times are in units
    of unit_days, weeks by default.
    """

    customer: str
    x: int
    t_x: float
    T: float


def summarise(
    purchase_days: Mapping[str, Sequence[date]],
    calibration_end: date,
    unit_days: float = 7.0,
) -> list[Summary]:
    """Build one Summary per customer, in the order of purchase_days.

    Each customer's days must already be one entry per calendar day; order does not
    matter. Days after calibration_end are ignored. Customers whose first purchase is
    after calibration_end are left out, because they had no time in the calibration
    window at all.

    Raises ValueError if unit_days is not a positive finite number, a customer id is
    not a string, a customer has no days, a day repeats, or a value is not a plain
    date (datetimes are refused because comparing them with dates fails or silently
    shifts by the time of day).
    """
    if isinstance(calibration_end, datetime) or not isinstance(calibration_end, date):
        raise ValueError("calibration_end must be a date, not a datetime")
    if isinstance(unit_days, bool) or not isinstance(unit_days, (int, float)):
        raise ValueError("unit_days must be a number")
    if not math.isfinite(unit_days) or unit_days <= 0:
        raise ValueError("unit_days must be a positive finite number")

    summaries: list[Summary] = []
    for customer, days in purchase_days.items():
        if not isinstance(customer, str):
            raise ValueError("customer ids must be strings")
        ordered = sorted(_checked_days(customer, days))
        first = ordered[0]
        if first > calibration_end:
            continue
        repeats = [d for d in ordered[1:] if d <= calibration_end]
        t_x = (repeats[-1] - first).days / unit_days if repeats else 0.0
        T = (calibration_end - first).days / unit_days
        summaries.append(Summary(customer=customer, x=len(repeats), t_x=t_x, T=T))
    return summaries


def _checked_days(customer: str, days: Sequence[date]) -> list[date]:
    checked = list(days)
    if not checked:
        raise ValueError(f"customer {customer!r} has no purchase days")
    for day in checked:
        if isinstance(day, datetime) or not isinstance(day, date):
            raise ValueError(f"customer {customer!r} has a value that is not a plain date")
    if len(set(checked)) != len(checked):
        raise ValueError(f"customer {customer!r} has the same day twice; merge same-day rows first")
    return checked
