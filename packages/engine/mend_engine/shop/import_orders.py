"""Loads the UCI sales history as the demo shop's own order records (M2) and refunds (M4b).

Real behaviour, synthetic people: dates, amounts and items come from the source
file, and every name and email is generated from the source customer number (C25).
Descriptions are untrusted source text. They travel only as bound query values, and
nothing reads them to make a decision (C11, C22).
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Context, Decimal, Inexact, InvalidOperation, Overflow
from pathlib import Path
from zoneinfo import ZoneInfo

import psycopg

from mend_engine.data.uci import CleaningTally, RefundTally, iter_clean_lines_by_sheet, iter_refund_lines_by_sheet
from mend_engine.shop.identities import customer_ref, display_name, synthetic_email

# Approximate average of the 2010 to 2011 exchange rate. The README states it,
# because every USD amount in the demo depends on it.
GBP_TO_USD = Decimal("1.60")
CURRENCY = "USD"
SOURCE_LAST_DAY = date(2011, 12, 9)
SHIFT_TARGET_DAY = date(2026, 10, 16)
SOURCE_ZONE = ZoneInfo("Europe/London")
# About 11,000 lines per transaction: few enough commits to stay fast, small enough
# that a failure part way loses one batch, which the next run fills in.
ORDERS_PER_BATCH = 500
MAX_INTEGER = 2**31 - 1

# Products of money values must be exact. Inexact is trapped, so a product can
# never be rounded quietly; only the final step to whole cents rounds, on purpose.
_EXACT = Context(prec=28, traps=[Inexact, InvalidOperation, Overflow])
_CENT = Decimal(1)

_UPSERT_CUSTOMER = (
    "insert into shop_customers (customer_ref, display_name, email, country) values (%s, %s, %s, %s) "
    "on conflict (customer_ref) do update set "
    "display_name = excluded.display_name, email = excluded.email, country = excluded.country "
    "where (shop_customers.display_name, shop_customers.email, shop_customers.country) "
    "is distinct from (excluded.display_name, excluded.email, excluded.country)"
)
_UPSERT_ORDER = (
    "insert into shop_orders (order_ref, customer_ref, ordered_at, total_minor, currency) "
    "values (%s, %s, %s, %s, %s) "
    "on conflict (order_ref) do update set "
    "customer_ref = excluded.customer_ref, ordered_at = excluded.ordered_at, "
    "total_minor = excluded.total_minor, currency = excluded.currency "
    "where (shop_orders.customer_ref, shop_orders.ordered_at, shop_orders.total_minor, shop_orders.currency) "
    "is distinct from (excluded.customer_ref, excluded.ordered_at, excluded.total_minor, excluded.currency)"
)
_UPSERT_LINE = (
    "insert into shop_order_lines (order_ref, line_no, stock_code, description, quantity, unit_price_minor) "
    "values (%s, %s, %s, %s, %s, %s) "
    "on conflict (order_ref, line_no) do update set "
    "stock_code = excluded.stock_code, description = excluded.description, "
    "quantity = excluded.quantity, unit_price_minor = excluded.unit_price_minor "
    "where (shop_order_lines.stock_code, shop_order_lines.description, "
    "shop_order_lines.quantity, shop_order_lines.unit_price_minor) "
    "is distinct from (excluded.stock_code, excluded.description, excluded.quantity, excluded.unit_price_minor)"
)
_COUNT_EXISTING = "select count(*) from shop_orders where order_ref = any(%s)"
_UPSERT_REFUND = (
    "insert into shop_refunds (refund_ref, customer_ref, refunded_at, amount_minor) values (%s, %s, %s, %s) "
    "on conflict (refund_ref) do update set "
    "customer_ref = excluded.customer_ref, refunded_at = excluded.refunded_at, amount_minor = excluded.amount_minor "
    "where (shop_refunds.customer_ref, shop_refunds.refunded_at, shop_refunds.amount_minor) "
    "is distinct from (excluded.customer_ref, excluded.refunded_at, excluded.amount_minor)"
)
_COUNT_EXISTING_REFUNDS = "select count(*) from shop_refunds where refund_ref = any(%s)"
_INSERT_RUN = (
    "insert into import_runs (source, source_bytes, lines_read, lines_kept, week_shift) values (%s, %s, %s, %s, %s)"
)
REFUNDS_SOURCE_SUFFIX = " (refunds)"


@dataclass
class ImportResult:
    lines_read: int
    lines_kept: int
    customers: int
    orders: int
    inserted_orders: int
    total_minor: int
    week_shift: int


@dataclass
class RefundImportResult:
    """refunds counts the cancellation invoices stored; unknown_customer counts those
    skipped because their customer has no order record in the shop."""

    lines_read: int
    lines_kept: int
    refunds: int
    inserted_refunds: int
    unknown_customer: int
    total_minor: int
    week_shift: int


class ImportRefused(ValueError):
    """The source breaks a rule the import relies on. Raised before any row is written."""


@dataclass(slots=True)
class _Order:
    sheet: str
    customer_id: int
    first_local: datetime
    lines: list[tuple[str, str, int, int]] = field(default_factory=list)


@dataclass(slots=True)
class _Refund:
    sheet: str
    customer_id: int
    first_local: datetime
    lines: list[tuple[str, int, int]] = field(default_factory=list)


def weeks_to_shift(last_day: date = SOURCE_LAST_DAY, target_day: date = SHIFT_TARGET_DAY) -> int:
    """The largest whole number of weeks that moves last_day to target_day or before it.

    Raises ImportRefused if target_day is before last_day.
    """
    days = (target_day - last_day).days
    if days < 0:
        raise ImportRefused("the target day is before the source's last day")
    return days // 7


def shifted_utc(local: datetime, weeks: int) -> datetime:
    """Move a UK wall-clock time forward by whole weeks and return it in UTC.

    The wall clock moves, not the instant, so an order placed at 10:00 on a Thursday
    is still 10:00 on a Thursday in London after the shift, whatever the clocks did
    in between. Raises ImportRefused for a time that already carries a zone, or one
    that lands in a clock-change hour, where it would be missing or happen twice.
    """
    if local.tzinfo is not None:
        raise ImportRefused("source times must be plain UK local times")
    moved = local + timedelta(weeks=weeks)
    earlier = moved.replace(tzinfo=SOURCE_ZONE, fold=0)
    later = moved.replace(tzinfo=SOURCE_ZONE, fold=1)
    if earlier.utcoffset() != later.utcoffset():
        raise ImportRefused("a shifted order time falls in a clock-change hour")
    return earlier.astimezone(timezone.utc)


def usd_minor(price_gbp: Decimal) -> int:
    """Convert a GBP unit price to whole US cents: price x 1.60 x 100, rounded half up.

    Raises ImportRefused for anything but a positive finite Decimal, or a price
    that rounds to 0 cents.
    """
    if type(price_gbp) is not Decimal or not price_gbp.is_finite() or price_gbp <= 0:
        raise ImportRefused("price must be a positive Decimal")
    exact = _EXACT.multiply(_EXACT.multiply(price_gbp, GBP_TO_USD), Decimal(100))
    cents = int(exact.quantize(_CENT, rounding=ROUND_HALF_UP))
    if cents < 1:
        raise ImportRefused("price is below half a US cent")
    return cents


def import_uci(conn: psycopg.Connection, zip_path: Path) -> ImportResult:
    """Load the UCI file at zip_path as the shop's customers, orders and order lines.

    Each invoice becomes one order, keyed on its invoice number. Invoices that both
    sheets carry (1 to 9 Dec 2010) are stored once, and the import refuses to run if
    the two copies differ. Dates move by weeks_to_shift() weeks on the UK wall clock.
    Re-running with the same file changes no shop row: every write is an upsert on
    the natural key that only writes when a value differs. Each run appends one row
    to import_runs.

    Precondition: conn is in autocommit mode, so each batch commits on its own, and
    the file has been checked with ensure_source. Raises ImportRefused or
    SourceError before writing anything if the file breaks a rule.
    """
    if not conn.autocommit:
        raise ImportRefused("import_uci needs an autocommit connection so each batch commits on its own")
    weeks = weeks_to_shift()
    tally = CleaningTally()
    orders, countries = _read_orders(zip_path, tally)

    customer_rows = []
    for customer_id in sorted(countries):
        ref = customer_ref(customer_id)
        customer_rows.append((ref, display_name(ref), synthetic_email(ref), countries[customer_id]))

    order_rows = []
    for ref in sorted(orders):
        order = orders[ref]
        total = sum(quantity * unit for _code, _text, quantity, unit in order.lines)
        if not 0 < total <= MAX_INTEGER:
            raise ImportRefused(f"order {ref} total does not fit the integer column")
        ordered_at = shifted_utc(order.first_local, weeks)
        order_rows.append((ref, customer_ref(order.customer_id), ordered_at, total, CURRENCY))

    with conn.transaction(), conn.cursor() as cur:
        cur.executemany(_UPSERT_CUSTOMER, customer_rows)

    inserted = 0
    for start in range(0, len(order_rows), ORDERS_PER_BATCH):
        batch = order_rows[start : start + ORDERS_PER_BATCH]
        refs = [row[0] for row in batch]
        line_rows = [
            (ref, line_no, code, text, quantity, unit)
            for ref in refs
            for line_no, (code, text, quantity, unit) in enumerate(orders[ref].lines, start=1)
        ]
        with conn.transaction(), conn.cursor() as cur:
            existing = cur.execute(_COUNT_EXISTING, (refs,)).fetchone()[0]
            cur.executemany(_UPSERT_ORDER, batch)
            cur.executemany(_UPSERT_LINE, line_rows)
        inserted += len(batch) - existing

    with conn.transaction():
        conn.execute(_INSERT_RUN, (zip_path.name, zip_path.stat().st_size, tally.read, tally.kept, weeks))

    return ImportResult(
        lines_read=tally.read,
        lines_kept=tally.kept,
        customers=len(customer_rows),
        orders=len(order_rows),
        inserted_orders=inserted,
        total_minor=sum(row[3] for row in order_rows),
        week_shift=weeks,
    )


def import_refunds(conn: psycopg.Connection, zip_path: Path) -> RefundImportResult:
    """Load the UCI file's cancellation invoices as the shop's refunds, one row per invoice.

    Each invoice starting with C becomes one shop_refunds row keyed on its invoice
    number, for the sum of quantity x unit price over its lines, with the same
    rules as the orders: GBP to whole US cents through usd_minor, the same week
    shift on the UK wall clock, the same customer_ref. Invoices both sheets carry
    are stored once, and the import refuses to run if the two copies differ. An
    invoice whose customer has no shop record is skipped and counted, never given a
    new customer. Re-running with the same file changes no row. Each run appends one
    row to import_runs with " (refunds)" after the file name.

    Precondition: conn is in autocommit mode and import_uci has loaded the same
    file. Raises ImportRefused or SourceError before writing anything if the file
    breaks a rule.
    """
    if not conn.autocommit:
        raise ImportRefused("import_refunds needs an autocommit connection so each batch commits on its own")
    weeks = weeks_to_shift()
    tally = RefundTally()
    refunds = _read_refunds(zip_path, tally)
    known = {row[0] for row in conn.execute("select customer_ref from shop_customers")}

    rows = []
    unknown = 0
    for ref in sorted(refunds):
        refund = refunds[ref]
        owner = customer_ref(refund.customer_id)
        if owner not in known:
            unknown += 1
            continue
        amount = sum(quantity * unit for _code, quantity, unit in refund.lines)
        if not 0 < amount <= MAX_INTEGER:
            raise ImportRefused(f"refund {ref} amount does not fit the integer column")
        rows.append((ref, owner, shifted_utc(refund.first_local, weeks), amount))

    inserted = 0
    for start in range(0, len(rows), ORDERS_PER_BATCH):
        batch = rows[start : start + ORDERS_PER_BATCH]
        with conn.transaction(), conn.cursor() as cur:
            existing = cur.execute(_COUNT_EXISTING_REFUNDS, ([row[0] for row in batch],)).fetchone()[0]
            cur.executemany(_UPSERT_REFUND, batch)
        inserted += len(batch) - existing

    with conn.transaction():
        conn.execute(
            _INSERT_RUN,
            (zip_path.name + REFUNDS_SOURCE_SUFFIX, zip_path.stat().st_size, tally.read, tally.kept, weeks),
        )

    return RefundImportResult(
        lines_read=tally.read,
        lines_kept=tally.kept,
        refunds=len(rows),
        inserted_refunds=inserted,
        unknown_customer=unknown,
        total_minor=sum(row[3] for row in rows),
        week_shift=weeks,
    )


def _read_refunds(zip_path: Path, tally: RefundTally) -> dict[str, _Refund]:
    refunds: dict[str, _Refund] = {}
    copies: dict[str, _Refund] = {}
    cents_for: dict[Decimal, int] = {}
    for sheet, line in iter_refund_lines_by_sheet(zip_path, tally):
        if line.invoiced_at_local.date() > SOURCE_LAST_DAY:
            raise ImportRefused(f"invoice {line.invoice} is dated after {SOURCE_LAST_DAY}")
        first = refunds.get(line.invoice)
        book = copies if first is not None and first.sheet != sheet else refunds
        refund = book.get(line.invoice)
        if refund is None:
            refund = book[line.invoice] = _Refund(sheet, line.customer_id, line.invoiced_at_local)
        elif refund.customer_id != line.customer_id:
            raise ImportRefused(f"invoice {line.invoice} names two customers")
        if line.invoiced_at_local < refund.first_local:
            refund.first_local = line.invoiced_at_local
        unit = cents_for.get(line.price_gbp)
        if unit is None:
            unit = cents_for[line.price_gbp] = usd_minor(line.price_gbp)
        refund.lines.append((line.stock_code, line.quantity, unit))

    for ref, copy in copies.items():
        first = refunds[ref]
        if (copy.customer_id, copy.first_local, Counter(copy.lines)) != (
            first.customer_id,
            first.first_local,
            Counter(first.lines),
        ):
            raise ImportRefused(f"invoice {ref} differs between the two sheets")
    return refunds


def _read_orders(zip_path: Path, tally: CleaningTally) -> tuple[dict[str, _Order], dict[int, str]]:
    orders: dict[str, _Order] = {}
    copies: dict[str, _Order] = {}
    latest: dict[int, tuple[datetime, str, str]] = {}
    cents_for: dict[Decimal, int] = {}
    for sheet, line in iter_clean_lines_by_sheet(zip_path, tally):
        if line.invoiced_at_local.date() > SOURCE_LAST_DAY:
            raise ImportRefused(f"invoice {line.invoice} is dated after {SOURCE_LAST_DAY}")
        first = orders.get(line.invoice)
        book = copies if first is not None and first.sheet != sheet else orders
        order = book.get(line.invoice)
        if order is None:
            order = book[line.invoice] = _Order(sheet, line.customer_id, line.invoiced_at_local)
        elif order.customer_id != line.customer_id:
            raise ImportRefused(f"invoice {line.invoice} names two customers")
        if line.invoiced_at_local < order.first_local:
            order.first_local = line.invoiced_at_local
        unit = cents_for.get(line.price_gbp)
        if unit is None:
            unit = cents_for[line.price_gbp] = usd_minor(line.price_gbp)
        order.lines.append((line.stock_code, line.description, line.quantity, unit))
        # A few customers appear under two countries; the one on their latest order wins.
        seen = (line.invoiced_at_local, line.invoice)
        known = latest.get(line.customer_id)
        if known is None or seen > known[:2]:
            latest[line.customer_id] = (*seen, line.country)

    for ref, copy in copies.items():
        first = orders[ref]
        if (copy.customer_id, copy.first_local, Counter(copy.lines)) != (
            first.customer_id,
            first.first_local,
            Counter(first.lines),
        ):
            raise ImportRefused(f"invoice {ref} differs between the two sheets")
    return orders, {customer_id: entry[2] for customer_id, entry in latest.items()}
