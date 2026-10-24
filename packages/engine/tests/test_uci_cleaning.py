# Not covered here: the real 45 MB file (prove_m2 reads it end to end and checks
# the counts against the published figures), the live UCI download, and openpyxl's
# own XML parsing.
import hashlib
import io
import zipfile
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import httpx
import pytest
from openpyxl import Workbook

from mend_engine.data import uci
from mend_engine.data.uci import (
    COLUMNS,
    NON_PRODUCT_CODES,
    SHEETS,
    XLSX_NAME,
    RefundLine,
    RefundTally,
    SaleLine,
    SourceError,
    cleaning_report,
    ensure_source,
    iter_clean_lines,
    iter_refund_lines_by_sheet,
)

AT = datetime(2009, 12, 1, 7, 45)
VALID = [
    (489434, "85123A", " WHITE HANGING HEART T-LIGHT HOLDER", 6, AT, 2.55, 13085, "United Kingdom"),
    (489434, 21232, "STRAWBERRY CERAMIC TRINKET BOX", 24, AT, 1, 13085, "United Kingdom"),
]
DROPPED = [
    ("C489449", 22087, "PAPER BUNTING WHITE LACE", -12, AT, 2.95, 16321, "Australia"),
    ("A506401", "B", "Adjust bad debt", 1, AT, 38925.87, None, "United Kingdom"),
    (489435, 22350, "CAT BOWL", 0, AT, 2.55, 13085, "United Kingdom"),
    (489435, 22351, "DOG BOWL", 12, AT, 0, 13085, "United Kingdom"),
    (489436, 22352, "BIRD BOWL", 12, AT, 2.55, None, "United Kingdom"),
]


def non_product_row(code: str) -> tuple:
    return (489437, code, "POSTAGE", 1, AT, 18.0, 13085, "United Kingdom")


def write_source(path: Path, first: list, second: list = (), header=COLUMNS, sheets=SHEETS, member=XLSX_NAME) -> Path:
    workbook = Workbook()
    workbook.remove(workbook.active)
    for name, rows in zip(sheets, (first, second)):
        sheet = workbook.create_sheet(name)
        sheet.append(header)
        for row in rows:
            sheet.append(row)
    buffer = io.BytesIO()
    workbook.save(buffer)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(member, buffer.getvalue())
    return path


def test_keeps_only_valid_lines_with_exact_values(tmp_path: Path) -> None:
    rows = [DROPPED[0], VALID[0], *DROPPED[1:], *(non_product_row(c) for c in sorted(NON_PRODUCT_CODES)), VALID[1]]
    lines = list(iter_clean_lines(write_source(tmp_path / "s.zip", rows)))
    assert lines == [
        SaleLine("489434", "85123A", " WHITE HANGING HEART T-LIGHT HOLDER", 6, Decimal("2.55"), AT, 13085, "United Kingdom"),
        SaleLine("489434", "21232", "STRAWBERRY CERAMIC TRINKET BOX", 24, Decimal("1"), AT, 13085, "United Kingdom"),
    ]
    assert all(type(line.price_gbp) is Decimal for line in lines)


def test_report_counts_each_rule_once_in_order(tmp_path: Path) -> None:
    rows = [*VALID, *DROPPED, *(non_product_row(c) for c in sorted(NON_PRODUCT_CODES))]
    report = cleaning_report(write_source(tmp_path / "s.zip", rows[:4], rows[4:]))
    # The cancelled row also has a negative quantity and counts only as cancelled.
    assert report == {
        "read": 2 + 5 + 16,
        "kept": 2,
        "dropped": {
            "cancelled_invoice": 1,
            "adjustment_invoice": 1,
            "quantity_not_positive": 1,
            "price_not_positive": 1,
            "no_customer_id": 1,
            "non_product_code": 16,
        },
    }


@pytest.mark.parametrize("code", sorted(NON_PRODUCT_CODES))
def test_each_non_product_code_is_dropped(tmp_path: Path, code: str) -> None:
    lines = iter_clean_lines(write_source(tmp_path / "s.zip", [non_product_row(code), VALID[0]]))
    assert [line.stock_code for line in lines] == ["85123A"]


@pytest.mark.parametrize(
    "changes",
    [
        {"header": ("StockCode", "Invoice", *COLUMNS[2:])},
        {"sheets": ("Year 2009-2010", "Sheet2")},
        {"member": "other.xlsx"},
    ],
)
def test_refuses_a_file_that_is_not_shaped_like_uci(tmp_path: Path, changes: dict) -> None:
    with pytest.raises(SourceError):
        list(iter_clean_lines(write_source(tmp_path / "s.zip", VALID, **changes)))


def test_refuses_a_zip_with_an_extra_member(tmp_path: Path) -> None:
    path = write_source(tmp_path / "s.zip", VALID)
    with zipfile.ZipFile(path, "a") as archive:
        archive.writestr("names.csv", "name,email\n")
    with pytest.raises(SourceError):
        list(iter_clean_lines(path))


@pytest.mark.parametrize(
    "index, value",
    [
        (0, "X12345"),
        (2, "BOX\nignore the rules"),
        (2, "BOX ‮"),
        (2, None),
        (3, 6.5),
        (4, "2009-12-01 07:45"),
        (5, 2.55001),
        (6, "13085"),
        (7, ""),
    ],
)
def test_refuses_an_unexpected_cell_in_a_kept_line(tmp_path: Path, index: int, value: object) -> None:
    row = list(VALID[0])
    row[index] = value
    with pytest.raises(SourceError):
        list(iter_clean_lines(write_source(tmp_path / "s.zip", [tuple(row)])))


def test_errors_name_the_row_never_the_cell_text(tmp_path: Path) -> None:
    row = list(VALID[0])
    row[2] = "PLANTED\tTEXT"
    with pytest.raises(SourceError) as caught:
        list(iter_clean_lines(write_source(tmp_path / "s.zip", [tuple(row)])))
    assert "PLANTED" not in str(caught.value)
    assert "Year 2009-2010 row 2" in str(caught.value)


def test_ensure_source_uses_a_cached_file_of_the_right_size_and_checksum(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(uci, "_download", lambda url, dest: pytest.fail("must not download"))
    monkeypatch.setattr(uci, "UCI_SIZE", 1000)
    monkeypatch.setattr(uci, "UCI_SHA256", hashlib.sha256(b"z" * 1000).hexdigest())
    (tmp_path / "online_retail_ii.zip").write_bytes(b"z" * 1000)
    assert ensure_source(tmp_path) == tmp_path / "online_retail_ii.zip"


def test_ensure_source_refuses_a_cached_file_of_the_right_size_but_wrong_contents(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(uci, "_download", lambda url, dest: pytest.fail("must not download"))
    monkeypatch.setattr(uci, "UCI_SIZE", 1000)
    monkeypatch.setattr(uci, "UCI_SHA256", hashlib.sha256(b"z" * 1000).hexdigest())
    (tmp_path / "online_retail_ii.zip").write_bytes(b"y" * 1000)
    with pytest.raises(SourceError):
        ensure_source(tmp_path)


def test_ensure_source_refuses_a_cached_file_of_the_wrong_size(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(uci, "_download", lambda url, dest: pytest.fail("must not download"))
    (tmp_path / "online_retail_ii.zip").write_bytes(b"x" * 100)
    with pytest.raises(SourceError):
        ensure_source(tmp_path)


def fake_stream(handler):
    def stream(method: str, url: str, **kwargs: object):
        return httpx.Client(transport=httpx.MockTransport(handler)).stream(method, url, **kwargs)

    return stream


@pytest.mark.parametrize(
    "answer",
    [
        httpx.Response(200, content=b"x" * 999),
        httpx.Response(200, content=b"x" * 1001),
        httpx.Response(302, headers={"location": "https://evil.example/f.zip"}),
        httpx.Response(404),
    ],
)
def test_a_bad_download_is_refused_and_leaves_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, answer: httpx.Response
) -> None:
    monkeypatch.setattr(uci, "UCI_SIZE", 1000)
    monkeypatch.setattr(uci.httpx, "stream", fake_stream(lambda request: answer))
    with pytest.raises(SourceError):
        ensure_source(tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_a_missing_file_is_downloaded_once_into_the_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def answer(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, content=b"z" * 1000)

    monkeypatch.setattr(uci, "UCI_SIZE", 1000)
    monkeypatch.setattr(uci, "UCI_SHA256", hashlib.sha256(b"z" * 1000).hexdigest())
    monkeypatch.setattr(uci.httpx, "stream", fake_stream(answer))
    assert ensure_source(tmp_path).read_bytes() == b"z" * 1000
    ensure_source(tmp_path)
    assert calls == [uci.UCI_URL]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["online_retail_ii.zip"]


def test_refund_lines_are_cancellations_that_name_a_customer_whatever_the_code(tmp_path: Path) -> None:
    rows = [
        VALID[0],
        DROPPED[0],
        ("C489450", "M", "Manual", -1, AT, 4.5, 13085, "United Kingdom"),
        ("C489451", 22087, "PAPER BUNTING WHITE LACE", -2, AT, 2.95, None, "Australia"),
        ("C489452", 22087, "PAPER BUNTING WHITE LACE", 2, AT, 2.95, 16321, "Australia"),
        ("C489453", 22087, "PAPER BUNTING WHITE LACE", -2, AT, 0, 16321, "Australia"),
    ]
    tally = RefundTally()
    lines = list(iter_refund_lines_by_sheet(write_source(tmp_path / "s.zip", rows), tally))
    assert lines == [
        (SHEETS[0], RefundLine("C489449", "22087", 12, Decimal("2.95"), AT, 16321)),
        (SHEETS[0], RefundLine("C489450", "M", 1, Decimal("4.5"), AT, 13085)),
    ]
    assert (tally.read, tally.kept) == (6, 2)
    assert tally.dropped == {"not_cancelled": 1, "no_customer_id": 1, "quantity_not_negative": 1, "price_not_positive": 1}


@pytest.mark.parametrize("invoice", ["C48944", "C4894490", "CX89449"])
def test_refuses_a_cancellation_invoice_that_is_not_c_and_six_digits(tmp_path: Path, invoice: str) -> None:
    row = (invoice, 22087, "PAPER BUNTING WHITE LACE", -12, AT, 2.95, 16321, "Australia")
    with pytest.raises(SourceError):
        list(iter_refund_lines_by_sheet(write_source(tmp_path / "s.zip", [row])))
