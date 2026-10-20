"""Proves M2 on the real UCI file and the engine's database: python -m mend_engine.prove_m2

Checks the source file, the cleaning counts, the imported customers and orders, the
money and the date shift against a second, separate read of the file, that a second
import changes nothing, and that every identity is synthetic. Prints PASS or FAIL
per line and a final M2 RESULT line. It calls no PayPal API.
"""

from __future__ import annotations

import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

import psycopg

from mend_engine.config import ConfigError, load_config
from mend_engine.data.uci import CACHE_DIR, UCI_SIZE, SourceError, cleaning_report, ensure_source, iter_clean_lines_by_sheet
from mend_engine.db.connect import connect
from mend_engine.shop.identities import SYNTHETIC_DOMAIN
from mend_engine.shop.import_orders import (
    GBP_TO_USD,
    SHIFT_TARGET_DAY,
    SOURCE_LAST_DAY,
    ImportRefused,
    ImportResult,
    import_uci,
)

ENV_PATH = Path(__file__).resolve().parents[3] / ".env"
# The data brief's own count of the same file with the same rules.
EXPECTED_KEPT = 802_634
EXPECTED_CUSTOMERS = 5_852
EXPECTED_ORDERS = 36_594
# A loose ceiling for one file read plus batched writes on a laptop.
IMPORT_BUDGET_SECONDS = 300
LONDON = ZoneInfo("Europe/London")
CHECKS = 8

_MONEY_COLUMNS = (("shop_orders", "total_minor"), ("shop_order_lines", "unit_price_minor"), ("shop_order_lines", "quantity"))


@dataclass
class SourceView:
    """What the file itself says each order should be, read without the importer."""

    totals: dict[str, int] = field(default_factory=dict)
    earliest: dict[str, datetime] = field(default_factory=dict)
    gbp_total: Decimal = Decimal(0)
    stored_lines: int = 0
    repeated_lines: int = 0
    all_decimal: bool = True


class Proof:
    def __init__(self) -> None:
        self.results: list[bool] = []

    def line(self, ok: bool, text: str) -> None:
        self.results.append(ok)
        print(f"[{'PASS' if ok else 'FAIL'}] {text}", flush=True)


def describe(exc: BaseException) -> str:
    # Database errors can quote row values, so only the engine's own messages are shown.
    if isinstance(exc, (SourceError, ImportRefused, ConfigError)):
        return f"{type(exc).__name__}: {exc}"
    return type(exc).__name__


def usd(minor: int) -> str:
    return f"{minor // 100:,}.{minor % 100:02d}"


def read_source(path: Path) -> SourceView:
    view = SourceView()
    owner: dict[str, str] = {}
    for sheet, line in iter_clean_lines_by_sheet(path):
        view.all_decimal = view.all_decimal and type(line.price_gbp) is Decimal
        if owner.setdefault(line.invoice, sheet) != sheet:
            view.repeated_lines += 1
            continue
        cents = int((line.price_gbp * GBP_TO_USD * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))
        view.totals[line.invoice] = view.totals.get(line.invoice, 0) + line.quantity * cents
        known = view.earliest.get(line.invoice)
        view.earliest[line.invoice] = line.invoiced_at_local if known is None else min(known, line.invoiced_at_local)
        view.gbp_total += line.quantity * line.price_gbp
        view.stored_lines += 1
    return view


def fingerprint(conn: psycopg.Connection) -> tuple:
    # xmin changes whenever a row is rewritten, even with the same values.
    return conn.execute(
        "select "
        "(select md5(string_agg(c.xmin::text || c::text, '|' order by c.customer_ref)) from shop_customers c), "
        "(select md5(string_agg(o.xmin::text || o::text, '|' order by o.order_ref)) from shop_orders o), "
        "(select md5(string_agg(l.xmin::text || l::text, '|' order by l.order_ref, l.line_no)) from shop_order_lines l)"
    ).fetchone()


def check_counts(proof: Proof, conn: psycopg.Connection, result: ImportResult, view: SourceView) -> None:
    customers, orders, lines = conn.execute(
        "select (select count(*) from shop_customers), (select count(*) from shop_orders), "
        "(select count(*) from shop_order_lines)"
    ).fetchone()
    ok = (
        customers == result.customers == EXPECTED_CUSTOMERS
        and orders == result.orders == EXPECTED_ORDERS
        and lines == view.stored_lines == result.lines_kept - view.repeated_lines
    )
    proof.line(
        ok,
        f"customers: {customers:,}; orders: {orders:,}; {lines:,} order lines stored, as the "
        f"{view.repeated_lines:,} lines both sheets carry for 1 to 9 Dec 2010 are stored once",
    )


def check_money(proof: Proof, conn: psycopg.Connection, result: ImportResult, view: SourceView) -> None:
    stored = dict(conn.execute("select order_ref, total_minor from shop_orders"))
    order_sum, line_sum = conn.execute(
        "select (select coalesce(sum(total_minor), 0) from shop_orders), "
        "(select coalesce(sum(quantity::bigint * unit_price_minor), 0) from shop_order_lines)"
    ).fetchone()
    types = {
        (table, column): kind
        for table, column, kind in conn.execute(
            "select table_name, column_name, data_type from information_schema.columns "
            "where table_schema = current_schema() and table_name = any(%s) and column_name = any(%s)",
            ([t for t, _ in _MONEY_COLUMNS], [c for _, c in _MONEY_COLUMNS]),
        )
    }
    integer_columns = all(types.get(key) == "integer" for key in _MONEY_COLUMNS)
    ok = (
        stored == view.totals
        and order_sum == line_sum == result.total_minor == sum(view.totals.values())
        and view.all_decimal
        and integer_columns
    )
    gbp = view.gbp_total.quantize(Decimal("0.01"))
    proof.line(ok, f"money: total {usd(order_sum)} USD at 1.60 per GBP, no float used (GBP total {gbp:,})")


def check_dates(proof: Proof, conn: psycopg.Connection, result: ImportResult, view: SourceView) -> None:
    weeks = result.week_shift
    largest = SOURCE_LAST_DAY + timedelta(weeks=weeks) <= SHIFT_TARGET_DAY < SOURCE_LAST_DAY + timedelta(weeks=weeks + 1)
    # The local pgserver build has no zone files, so London time is worked out here.
    local = {ref: at.astimezone(LONDON).replace(tzinfo=None) for ref, at in conn.execute("select order_ref, ordered_at from shop_orders")}
    moved = sum(1 for ref, at in view.earliest.items() if local.get(ref) != at + timedelta(weeks=weeks))
    weekday_changed = sum(1 for ref, at in view.earliest.items() if ref not in local or local[ref].weekday() != at.weekday())
    first_day = min(local.values()).date() if local else None
    last_day = max(local.values()).date() if local else None
    ok = largest and moved == 0 and weekday_changed == 0 and len(local) == len(view.earliest) and last_day <= SHIFT_TARGET_DAY
    tail = "weekday of every order unchanged" if ok else f"{weekday_changed} weekdays and {moved} times changed"
    proof.line(ok, f"dates: shifted {weeks} weeks; first {first_day}, last {last_day}; {tail}")


def check_identities(proof: Proof, conn: psycopg.Connection) -> None:
    total, wrong_email, digit_in_name, id_in_name, odd_shape = conn.execute(
        "select count(*), "
        "count(*) filter (where email <> lower(customer_ref) || %s), "
        "count(*) filter (where display_name ~ '[0-9]'), "
        "count(*) filter (where strpos(display_name, substr(customer_ref, 2)) > 0), "
        "count(*) filter (where display_name !~ '^[A-Z][a-z]+ [A-Z][.]$') "
        "from shop_customers",
        ("@" + SYNTHETIC_DOMAIN,),
    ).fetchone()
    ok = total > 0 and wrong_email == digit_in_name == id_in_name == odd_shape == 0
    proof.line(ok, f"identities: every email ends with @{SYNTHETIC_DOMAIN}; no source id appears in any display name")


def run() -> bool:
    proof = Proof()
    try:
        path = ensure_source(CACHE_DIR)
    except Exception as exc:
        proof.line(False, f"source: {describe(exc)}")
        return False
    size = path.stat().st_size
    proof.line(size == UCI_SIZE, f"source: {path.name}, {size:,} bytes, CC BY 4.0 (Chen 2012)")

    report = cleaning_report(path)
    dropped = ", ".join(f"{rule.replace('_', ' ')} {count:,}" for rule, count in report["dropped"].items())
    balanced = report["read"] == report["kept"] + sum(report["dropped"].values())
    proof.line(
        report["kept"] == EXPECTED_KEPT and balanced,
        f"cleaning: {report['read']:,} lines read, {report['kept']:,} kept; dropped by rule: {dropped}",
    )

    try:
        config = load_config(str(ENV_PATH) if ENV_PATH.is_file() else None)
        conn = connect(config)
    except Exception as exc:
        proof.line(False, f"database: {describe(exc)}")
        return False
    with conn:
        try:
            started = time.monotonic()
            first = import_uci(conn, path)
            seconds = time.monotonic() - started
        except Exception as exc:
            proof.line(False, f"import: {describe(exc)}")
            return False
        view = read_source(path)
        check_counts(proof, conn, first, view)
        check_money(proof, conn, first, view)
        check_dates(proof, conn, first, view)

        before = fingerprint(conn)
        second = import_uci(conn, path)
        unchanged = fingerprint(conn) == before
        proof.line(
            second.inserted_orders == 0 and unchanged,
            f"idempotent: second import inserted {second.inserted_orders} orders"
            + ("" if unchanged else "; shop rows were rewritten"),
        )
        check_identities(proof, conn)
    proof.line(seconds <= IMPORT_BUDGET_SECONDS, f"timing: import took {seconds:.1f} seconds")
    return all(proof.results) and len(proof.results) == CHECKS


def main() -> int:
    try:
        passed = run()
    except Exception as exc:
        print(f"[FAIL] stopped: {describe(exc)}", flush=True)
        passed = False
    print(f"M2 RESULT: {'PASS' if passed else 'FAIL'}", flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
