"""The shop's PayPal balance, read before any payout batch is sent (C20).

PayPal's reporting balance can trail real activity by up to three hours, so two
batches sent close together can both see the same figure. The floor kept back
under every batch is what absorbs that; the daily cap bounds how much can go out
inside the lag.
"""

from __future__ import annotations

import re

from mend_engine.paypal.http import PayPalError, PayPalHttp
from mend_engine.paypal.payouts import BatchSnapshot

BALANCES_PATH = "/v1/reporting/balances?currency_code=USD"
# PayPal's Payouts fee for the API is about 0.25 USD an item, taken from the balance on
# top of the amount, so each item is held to that much more.
FEE_PER_ITEM_MINOR = 25
LOW_BALANCE = "low_balance"
BALANCE_UNAVAILABLE = "balance_unavailable"

# A balance can be zero or below zero, which money.to_minor rightly refuses for an
# amount, so it gets its own strict pattern: an optional minus, digits, at most two decimals.
_BALANCE_VALUE = re.compile(r"(-?)([0-9]{1,13})(?:\.([0-9]{1,2}))?", re.ASCII)


class BalanceTooLow(Exception):
    """The batch may not be sent now. code is "low_balance" or "balance_unavailable"."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code


def _unreadable(debug_id: str | None) -> PayPalError:
    return PayPalError(200, "UNREADABLE_BALANCE", debug_id)


def available_usd_minor(http: PayPalHttp) -> int:
    """The shop's available USD balance at PayPal, in cents, from one GET of the reporting balances.

    Reads only the one balances[] entry whose currency is "USD", and only its
    available_balance, which must be {"currency_code": "USD", "value": text} with
    the value plain digits, an optional leading minus and at most two decimals.
    Raises PayPalUnreachable on a timeout or connection failure, and PayPalError
    for any answer other than 200 or a 200 that is not exactly that shape.
    """
    response = http.request("GET", BALANCES_PATH)
    if response.status != 200:
        name = response.body.get("name")
        raise PayPalError(response.status, name if isinstance(name, str) else None, response.debug_id)
    entries = response.body.get("balances")
    if not isinstance(entries, list):
        raise _unreadable(response.debug_id)
    usd = [entry for entry in entries if isinstance(entry, dict) and entry.get("currency") == "USD"]
    if len(usd) != 1:
        raise _unreadable(response.debug_id)
    available = usd[0].get("available_balance")
    if not isinstance(available, dict) or available.get("currency_code") != "USD":
        raise _unreadable(response.debug_id)
    value = available.get("value")
    found = _BALANCE_VALUE.fullmatch(value) if type(value) is str else None
    if found is None:
        raise _unreadable(response.debug_id)
    sign, whole, fraction = found.groups()
    cents = int(whole) * 100 + int((fraction or "").ljust(2, "0"))
    return -cents if sign else cents


def check_room(http: PayPalHttp, snap: BatchSnapshot, floor_minor: int) -> None:
    """Refuse a batch the shop's balance cannot cover with the floor still left over.

    Reads the balance once. The batch needs its total plus 25 cents an item; what
    the balance has beyond that must be at least floor_minor. Raises BalanceTooLow
    "low_balance" when it is not, and "balance_unavailable" when the balance could
    not be read at all, so an unknown balance never lets money out.
    """
    try:
        available = available_usd_minor(http)
    except PayPalError as exc:
        raise BalanceTooLow(
            BALANCE_UNAVAILABLE, f"the balance could not be read (status={exc.status} name={exc.name} debug_id={exc.debug_id})"
        ) from None
    needed = sum(item.amount_minor for item in snap.items) + FEE_PER_ITEM_MINOR * len(snap.items)
    if available - needed < floor_minor:
        raise BalanceTooLow(
            LOW_BALANCE, f"available {available} cents less {needed} for the batch and its fees is below the {floor_minor} cent floor"
        )
