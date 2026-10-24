"""Reads the UCI Online Retail II file and applies the demo shop's cleaning rules.

Source: Chen, D. (2012). Online Retail II [Dataset]. UCI Machine Learning Repository.
https://doi.org/10.24432/C5CG6D. Licence CC BY 4.0, so the citation must travel with
anything built from it.

Every cell is untrusted. The reader refuses any file whose shape differs from the
real one (members, sheet names, header, cell types), and its errors name the sheet,
row and column, never the cell text.
"""

from __future__ import annotations

import hashlib
import io
import os
import re
import sys
import time
import zipfile
from collections.abc import Iterator
from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import httpx
from openpyxl import load_workbook

UCI_URL = "https://archive.ics.uci.edu/static/public/502/online+retail+ii.zip"
UCI_SIZE = 45622418
# Size alone would accept a same-length file with different contents.
UCI_SHA256 = "572e36277c2390fbfde10664750731e0a86f55e33470d91919085f0408e67bfb"
ZIP_NAME = "online_retail_ii.zip"
XLSX_NAME = "online_retail_II.xlsx"
SHEETS = ("Year 2009-2010", "Year 2010-2011")
COLUMNS = ("Invoice", "StockCode", "Description", "Quantity", "InvoiceDate", "Price", "Customer ID", "Country")
CACHE_DIR = Path(__file__).resolve().parents[2] / ".data"

# The real workbook is 45.6 MB with 541,910 rows on its larger sheet. Far beyond
# either means this is not the file, so reading stops instead of running on.
MAX_XLSX_BYTES = 64 * 1024 * 1024
MAX_ROWS_PER_SHEET = 1_000_000
MAX_TEXT = 200
MAX_PRICE_PLACES = 4
DOWNLOAD_TIMEOUT = httpx.Timeout(15.0, read=60.0)
DOWNLOAD_DEADLINE_SECONDS = 600

# Decided for M2: postage, fees, manual entries, adjustments and test codes. This
# is a list, so a code nobody thought of would pass as a product. In the real
# file every kept code starts with five digits except SP1002, a real product.
NON_PRODUCT_CODES = frozenset(
    {
        "POST", "DOT", "M", "m", "D", "C2", "S", "B", "CRUK", "BANK CHARGES",
        "ADJUST", "ADJUST2", "AMAZONFEE", "PADS", "TEST001", "TEST002",
    }
)

# A row breaking several rules is counted under the first one in this order.
RULES = (
    "cancelled_invoice",
    "adjustment_invoice",
    "quantity_not_positive",
    "price_not_positive",
    "no_customer_id",
    "non_product_code",
)

# The same, for reading cancellation invoices as refunds. Every stock code counts
# on a cancellation, postage and manual credits included: orders count products
# only, so a paid amount net of these can only come out lower than the truth, never
# higher (C4 fails closed). In the real file every cancellation line has a negative
# quantity and a positive price, so the last two rules never fire there.
REFUND_RULES = (
    "not_cancelled",
    "no_customer_id",
    "quantity_not_negative",
    "price_not_positive",
)

_INVOICE = re.compile(r"[0-9]{6}", re.ASCII)
_CANCELLATION = re.compile(r"C[0-9]{6}", re.ASCII)


class SourceError(ValueError):
    """The file is not the UCI file this reader knows. Messages never quote cell text."""


@dataclass(frozen=True)
class SaleLine:
    invoice: str
    stock_code: str
    description: str
    quantity: int
    price_gbp: Decimal
    invoiced_at_local: datetime
    customer_id: int
    country: str


@dataclass(frozen=True)
class RefundLine:
    """One line of a cancellation invoice. quantity is the number of units given back, above 0."""

    invoice: str
    stock_code: str
    quantity: int
    price_gbp: Decimal
    invoiced_at_local: datetime
    customer_id: int


@dataclass
class CleaningTally:
    """Counts filled in while a scan runs: rows read, rows kept, rows dropped per rule."""

    read: int = 0
    kept: int = 0
    dropped: dict[str, int] = field(default_factory=lambda: dict.fromkeys(RULES, 0))

    def as_report(self) -> dict:
        return {"read": self.read, "kept": self.kept, "dropped": dict(self.dropped)}


@dataclass
class RefundTally:
    """CleaningTally's counterpart for a refunds scan, with REFUND_RULES."""

    read: int = 0
    kept: int = 0
    dropped: dict[str, int] = field(default_factory=lambda: dict.fromkeys(REFUND_RULES, 0))


def ensure_source(cache_dir: Path) -> Path:
    """Return the path of the UCI zip in cache_dir, downloading it only when missing.

    Raises SourceError if the cached or downloaded file is not exactly UCI_SIZE
    bytes with the known SHA-256. A bad download is deleted; a bad cached file is left in place for a
    person to look at, and the error says to delete it.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / ZIP_NAME
    if not path.exists():
        _download(UCI_URL, path)
    if not path.is_file():
        raise SourceError(f"{ZIP_NAME} in the cache is not a file")
    size = path.stat().st_size
    if size != UCI_SIZE:
        raise SourceError(f"cached {ZIP_NAME} is {size} bytes, expected {UCI_SIZE}; delete it to download again")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    if digest.hexdigest() != UCI_SHA256:
        raise SourceError(f"cached {ZIP_NAME} does not match the known UCI checksum; delete it to download again")
    return path


def _download(url: str, dest: Path) -> None:
    partial = dest.with_name(dest.name + ".part")
    deadline = time.monotonic() + DOWNLOAD_DEADLINE_SECONDS
    received = 0
    try:
        # No redirects: the one address we trust is UCI_URL itself.
        with httpx.stream("GET", url, timeout=DOWNLOAD_TIMEOUT, follow_redirects=False) as response:
            if response.status_code != 200:
                raise SourceError(f"download refused: HTTP {response.status_code}")
            with partial.open("wb") as out:
                for chunk in response.iter_bytes(1 << 20):
                    received += len(chunk)
                    if received > UCI_SIZE:
                        raise SourceError(f"download refused: more than {UCI_SIZE} bytes")
                    if time.monotonic() > deadline:
                        raise SourceError(f"download refused: took over {DOWNLOAD_DEADLINE_SECONDS} seconds")
                    out.write(chunk)
        if received != UCI_SIZE:
            raise SourceError(f"download refused: {received} bytes, expected {UCI_SIZE}")
        os.replace(partial, dest)
    except httpx.HTTPError as exc:
        raise SourceError(f"download failed: {type(exc).__name__}") from None
    finally:
        partial.unlink(missing_ok=True)


def iter_clean_lines(zip_path: Path) -> Iterator[SaleLine]:
    """Yield every sale line that passes the cleaning rules, in file order.

    Keeps a line only if Invoice does not start with C or A, Quantity and Price are
    above 0, Customer ID is present and StockCode is not a non-product code.
    Streams the workbook with openpyxl in read-only mode. Raises SourceError on any
    file whose shape or cell types differ from the real UCI file.
    """
    for _sheet, line in iter_clean_lines_by_sheet(zip_path):
        yield line


def cleaning_report(zip_path: Path) -> dict:
    """Read the whole file and return {"read", "kept", "dropped": {rule: rows}}."""
    tally = CleaningTally()
    for _ in iter_clean_lines_by_sheet(zip_path, tally):
        pass
    return tally.as_report()


def iter_clean_lines_by_sheet(zip_path: Path, tally: CleaningTally | None = None) -> Iterator[tuple[str, SaleLine]]:
    """Yield (sheet name, line) for every clean line, filling tally as it goes.

    The two sheets overlap: both carry the invoices of 1 to 9 Dec 2010. The sheet
    name lets a caller that needs each invoice once take it from one sheet only.
    """
    tally = tally if tally is not None else CleaningTally()
    with closing(_source_rows(zip_path)) as rows:
        for sheet, where, row in rows:
            tally.read += 1
            line, reason = _clean(row, where)
            if line is None:
                tally.dropped[reason] += 1
                continue
            tally.kept += 1
            yield sheet, line


def iter_refund_lines_by_sheet(zip_path: Path, tally: RefundTally | None = None) -> Iterator[tuple[str, RefundLine]]:
    """Yield (sheet name, line) for every cancellation line that names a customer, filling tally.

    A cancellation is an invoice starting with C. Keeps a line only if it has a
    Customer ID, a negative Quantity and a Price above 0, whatever its StockCode.
    Applies the same cell checks as iter_clean_lines_by_sheet to every row. The two
    sheets overlap as they do for sales, so a caller must take each invoice once.
    Raises SourceError on any file whose shape or cell types differ from the real one.
    """
    tally = tally if tally is not None else RefundTally()
    with closing(_source_rows(zip_path)) as rows:
        for sheet, where, row in rows:
            tally.read += 1
            line, reason = _refund(row, where)
            if line is None:
                tally.dropped[reason] += 1
                continue
            tally.kept += 1
            yield sheet, line


def _source_rows(zip_path: Path) -> Iterator[tuple[str, str, tuple]]:
    """Yield (sheet, "<sheet> row <n>", row) for every data row, after the workbook shape checks."""
    workbook = _open_workbook(zip_path)
    try:
        if tuple(workbook.sheetnames) != SHEETS:
            raise SourceError("workbook sheets are not the two UCI sheets")
        for sheet in SHEETS:
            rows = workbook[sheet].iter_rows(values_only=True)
            if tuple(next(rows, ())) != COLUMNS:
                raise SourceError(f"{sheet}: header is not the UCI header")
            for row_number, row in enumerate(rows, start=2):
                if row_number > MAX_ROWS_PER_SHEET + 1:
                    raise SourceError(f"{sheet}: more than {MAX_ROWS_PER_SHEET} rows")
                yield sheet, f"{sheet} row {row_number}", row
    finally:
        workbook.close()


def _open_workbook(zip_path: Path):
    try:
        with zipfile.ZipFile(zip_path) as archive:
            members = archive.infolist()
            if [m.filename for m in members] != [XLSX_NAME]:
                raise SourceError(f"zip must hold exactly one member, {XLSX_NAME}")
            if members[0].file_size > MAX_XLSX_BYTES:
                raise SourceError("workbook is larger than the cap")
            with archive.open(members[0]) as member:
                data = member.read(MAX_XLSX_BYTES + 1)
    except zipfile.BadZipFile:
        raise SourceError("not a zip file") from None
    if len(data) > MAX_XLSX_BYTES:
        raise SourceError("workbook is larger than the cap")
    return load_workbook(io.BytesIO(data), read_only=True, data_only=True)


def _cells(row: tuple, where: str) -> tuple:
    """The row's cells after the type checks every row must pass, kept or not."""
    if len(row) != len(COLUMNS):
        raise SourceError(f"{where}: expected {len(COLUMNS)} cells")
    invoice_cell, code_cell, description_cell, quantity, invoiced_at, price_cell, customer, country = row
    invoice = _code_text(invoice_cell, where, "Invoice")
    stock_code = _code_text(code_cell, where, "StockCode")
    if quantity is not None and type(quantity) is not int:
        raise SourceError(f"{where}: Quantity is not a whole number")
    price = _exact_price(price_cell, where)
    if customer is not None and (type(customer) is not int or customer < 1):
        raise SourceError(f"{where}: Customer ID is not a positive whole number")
    return invoice, stock_code, description_cell, quantity, invoiced_at, price, customer, country


def _check_kept(price: Decimal, invoiced_at: object, where: str) -> None:
    if price.as_tuple().exponent < -MAX_PRICE_PLACES:
        raise SourceError(f"{where}: Price has more than {MAX_PRICE_PLACES} decimal places")
    if type(invoiced_at) is not datetime or invoiced_at.tzinfo is not None:
        raise SourceError(f"{where}: InvoiceDate is not a plain local date and time")


def _refund(row: tuple, where: str) -> tuple[RefundLine | None, str]:
    invoice, stock_code, _description, quantity, invoiced_at, price, customer, _country = _cells(row, where)
    if not invoice.startswith("C"):
        return None, "not_cancelled"
    if customer is None:
        return None, "no_customer_id"
    if quantity is None or quantity >= 0:
        return None, "quantity_not_negative"
    if price is None or price <= 0:
        return None, "price_not_positive"
    if not _CANCELLATION.fullmatch(invoice):
        raise SourceError(f"{where}: Invoice is not C and six digits")
    _check_kept(price, invoiced_at, where)
    line = RefundLine(
        invoice=sys.intern(invoice),
        stock_code=sys.intern(stock_code),
        quantity=-quantity,
        price_gbp=price,
        invoiced_at_local=invoiced_at,
        customer_id=customer,
    )
    return line, ""


def _clean(row: tuple, where: str) -> tuple[SaleLine | None, str]:
    invoice, stock_code, description_cell, quantity, invoiced_at, price, customer, country = _cells(row, where)

    if invoice.startswith("C"):
        return None, "cancelled_invoice"
    if invoice.startswith("A"):
        return None, "adjustment_invoice"
    if quantity is None or quantity <= 0:
        return None, "quantity_not_positive"
    if price is None or price <= 0:
        return None, "price_not_positive"
    if customer is None:
        return None, "no_customer_id"
    if stock_code in NON_PRODUCT_CODES:
        return None, "non_product_code"

    if not _INVOICE.fullmatch(invoice):
        raise SourceError(f"{where}: Invoice is not six digits")
    _check_kept(price, invoiced_at, where)
    # Interned because hundreds of thousands of lines share a few thousand values.
    line = SaleLine(
        invoice=sys.intern(invoice),
        stock_code=sys.intern(stock_code),
        description=_text(description_cell, where, "Description"),
        quantity=quantity,
        price_gbp=price,
        invoiced_at_local=invoiced_at,
        customer_id=customer,
        country=sys.intern(_text(country, where, "Country")),
    )
    return line, ""


def _code_text(value: object, where: str, column: str) -> str:
    if type(value) is int and value >= 0:
        return str(value)
    if type(value) is str and value and len(value) <= MAX_TEXT and value.isprintable():
        return value
    raise SourceError(f"{where}: {column} is not a code")


def _exact_price(value: object, where: str) -> Decimal | None:
    if value is None:
        return None
    if type(value) is int:
        return Decimal(value)
    if type(value) is float:
        # openpyxl hands every decimal cell over as a binary float. repr is the
        # shortest text that reads back as that same float, so a price written as
        # 2.55 comes back as exactly Decimal("2.55"). No arithmetic happens on the float.
        price = Decimal(repr(value))
        if price.is_finite():
            return price
    raise SourceError(f"{where}: Price is not a number")


def _text(value: object, where: str, column: str) -> str:
    # str.isprintable is false for control, format (bidi), surrogate, private-use and
    # unassigned characters, and for every separator except the plain space.
    text = str(value) if type(value) is int else value
    if type(text) is str and text.strip() and len(text) <= MAX_TEXT and text.isprintable():
        return text
    raise SourceError(f"{where}: {column} is not plain printable text")
