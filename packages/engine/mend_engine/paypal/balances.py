"""The shop's PayPal balance, read before any payout batch is sent (C20).

PayPal's reporting balance can trail real activity by up to three hours, so a batch
sent a moment ago may not show in it yet. The room a batch may use is therefore the
reported balance less every batch Mend itself claimed in the last 6 hours, twice
the lag, whether or not the figure shows it already: that errs towards sending
less. The read, the check and the claim all happen under one lock in one
transaction, so two senders can never both spend the same room.
"""

from __future__ import annotations

import re
from datetime import timedelta

import psycopg
from psycopg.pq import TransactionStatus

from mend_engine.campaigns.spend import CAMPAIGN_VOIDED_SQL, CLAIMED_SINCE_SQL, database_now
from mend_engine.paypal.http import PayPalError, PayPalHttp
from mend_engine.paypal.payouts import BatchSnapshot

BALANCES_PATH = "/v1/reporting/balances?currency_code=USD"
# PayPal's Payouts fee for the API is about 0.25 USD an item, taken from the balance on
# top of the amount, so each item is held to that much more.
FEE_PER_ITEM_MINOR = 25
# Taken by every first send and every resend before the balance read, and held to the
# end of the transaction that claims the batch. Any fixed number works, as for
# spend.DAILY_CAP_LOCK, which is always taken after this one.
BALANCE_LOCK = 7731300008
OUTFLOW_WINDOW = timedelta(hours=6)
# Parameters: the fee per item, the campaign being sent, and the start of the window.
# Every item, with its fee, of every other campaign whose latest claim is after that
# start. Items PayPal reports as failed or returned still count: whether the lagging
# figure shows them back yet is unknown. Only a voided campaign, which never sent
# anything, is left out.
_OUTFLOWS_SQL = (
    "select coalesce(sum((item ->> 'amount_minor')::bigint + %s), 0) "
    "from approved_snapshots s cross join lateral jsonb_array_elements(s.canonical_json::jsonb -> 'items') item "
    "where s.campaign_id::text <> %s and " + CLAIMED_SINCE_SQL + " and not " + CAMPAIGN_VOIDED_SQL
)
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


def lock_balance(conn: psycopg.Connection) -> None:
    """Take BALANCE_LOCK until the current transaction ends.

    Raises RuntimeError outside a transaction, where the lock would end at once.
    """
    if conn.info.transaction_status != TransactionStatus.INTRANS:
        raise RuntimeError("the balance lock needs an open transaction")
    conn.execute("select pg_advisory_xact_lock(%s)", (BALANCE_LOCK,))


def recent_outflows_minor(conn: psycopg.Connection, campaign_id: str) -> int:
    """Cents, fees included, in every batch Mend claimed in the last 6 hours for a campaign other than campaign_id.

    A campaign counts from its latest move into submitting, as for the daily cap,
    and counts every item of its frozen snapshot plus 25 cents each, unless it is
    voided. Ledger rows with no frozen snapshot (the M1 proof payouts) are not counted.
    """
    since = database_now(conn) - OUTFLOW_WINDOW
    return int(conn.execute(_OUTFLOWS_SQL, (FEE_PER_ITEM_MINOR, campaign_id, since)).fetchone()[0])


def check_room(conn: psycopg.Connection, http: PayPalHttp, snap: BatchSnapshot, floor_minor: int) -> None:
    """Refuse a batch the shop's balance cannot cover with the floor still left over.

    Must run inside the transaction that then claims the batch: it takes
    BALANCE_LOCK first, which that transaction keeps until it commits, so the next
    sender's check sees this claim. Reads the balance once, then takes off
    recent_outflows_minor for every other campaign. The batch needs its total plus
    25 cents an item; what is left beyond that must be at least floor_minor.

    Raises BalanceTooLow "low_balance" when it is not, and "balance_unavailable"
    when the balance could not be read at all, so an unknown balance never lets
    money out; RuntimeError outside a transaction, with nothing read.
    """
    lock_balance(conn)
    try:
        available = available_usd_minor(http)
    except PayPalError as exc:
        raise BalanceTooLow(
            BALANCE_UNAVAILABLE, f"the balance could not be read (status={exc.status} name={exc.name} debug_id={exc.debug_id})"
        ) from None
    outflows = recent_outflows_minor(conn, snap.campaign_id)
    needed = sum(item.amount_minor for item in snap.items) + FEE_PER_ITEM_MINOR * len(snap.items)
    if available - outflows - needed < floor_minor:
        raise BalanceTooLow(
            LOW_BALANCE,
            f"available {available} cents less {outflows} sent in the last 6 hours and {needed} for the batch and its fees "
            f"is below the {floor_minor} cent floor",
        )
