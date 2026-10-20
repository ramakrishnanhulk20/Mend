"""The one decimal routine for money. Every amount inside the engine is an int of cents."""

from __future__ import annotations

import re

# fullmatch, not match with "$": "$" also matches before a trailing newline, so
# "1.00\n" would slip through. re.ASCII keeps \d to 0-9, not every Unicode digit.
_AMOUNT = re.compile(r"\d{1,9}(\.\d{1,2})?", re.ASCII)

SUPPORTED_CURRENCY = "USD"
MAX_MINOR = 999_999_999_99


class MoneyError(ValueError):
    """An amount or currency the engine will not handle."""


def to_minor(value: str, currency: str = "USD") -> int:
    """Turn a decimal string such as "12.5" into cents (1250).

    Accepts only plain digits with at most two decimals, in USD. Floats, exponents,
    signs, spaces, commas, zero and more than two decimals raise MoneyError.
    """
    if type(value) is not str:
        raise MoneyError("amount must be a string")
    if currency != SUPPORTED_CURRENCY:
        raise MoneyError("only USD is supported")
    if not _AMOUNT.fullmatch(value):
        raise MoneyError("amount is not a plain decimal with at most two places")
    whole, _, fraction = value.partition(".")
    minor = int(whole) * 100 + int(fraction.ljust(2, "0") or "0")
    if minor < 1:
        raise MoneyError("amount must be at least 0.01")
    return minor


def to_decimal_string(minor: int) -> str:
    """Format cents as PayPal's decimal string: 100 becomes "1.00".

    Refuses anything that is not an int (bools included), below 1, or above the
    largest value to_minor accepts, so the two functions stay exact inverses.
    """
    if type(minor) is not int:
        raise MoneyError("minor units must be an int")
    if minor < 1 or minor > MAX_MINOR:
        raise MoneyError("minor units out of range")
    return f"{minor // 100}.{minor % 100:02d}"
