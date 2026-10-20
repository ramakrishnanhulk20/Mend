# Not covered here: currencies other than USD beyond the refusal, PayPal's own
# rounding of fees, and amounts above the 9-digit ceiling except at the boundary.
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from mend_engine.money import MAX_MINOR, MoneyError, to_decimal_string, to_minor

valid_amounts = st.from_regex(r"\A[0-9]{1,9}(\.[0-9]{1,2})?\Z", fullmatch=True).filter(
    lambda s: Decimal(s) >= Decimal("0.01")
)


@given(valid_amounts)
def test_round_trip_keeps_the_value(text: str) -> None:
    minor = to_minor(text)
    formatted = to_decimal_string(minor)
    assert Decimal(formatted) == Decimal(text)
    assert to_minor(formatted) == minor


@given(st.integers(min_value=1, max_value=MAX_MINOR))
def test_formatting_any_valid_cent_count_parses_back(minor: int) -> None:
    assert to_minor(to_decimal_string(minor)) == minor


def test_known_values() -> None:
    assert to_minor("1") == 100
    assert to_minor("1.5") == 150
    assert to_minor("0.01") == 1
    assert to_decimal_string(100) == "1.00"
    assert to_decimal_string(1) == "0.01"


@pytest.mark.parametrize(
    "bad",
    ["1e3", "-1", "+1", "1.005", "0", "0.00", "", " 1", "1 ", "1,00", "1.", ".5", "1.00\n",
     "1234567890", "١"],
)
def test_refuses_malformed_strings(bad: str) -> None:
    with pytest.raises(MoneyError):
        to_minor(bad)


def test_refuses_a_float() -> None:
    with pytest.raises(MoneyError):
        to_minor(1.5)  # type: ignore[arg-type]


def test_refuses_other_currencies() -> None:
    with pytest.raises(MoneyError):
        to_minor("1.00", "EUR")


@pytest.mark.parametrize("bad", [0, -1, MAX_MINOR + 1, True, 1.0])
def test_to_decimal_string_refuses_out_of_range_or_non_int(bad: object) -> None:
    with pytest.raises(MoneyError):
        to_decimal_string(bad)  # type: ignore[arg-type]
