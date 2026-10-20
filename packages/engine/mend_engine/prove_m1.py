"""Proves the M1 slice against the live PayPal sandbox: python -m mend_engine.prove_m1

Reads the shop's balance and history, sends one guarded 1.00 USD cashback to the
sandbox test receiver, tries to send the same snapshot again, tries to reach live
PayPal, then checks the ledger and greps its own output and the audit table for
secrets. Prints PASS or FAIL per line and a final M1 RESULT line.

The campaign id carries the UTC date, so one proof payout is made per day. A
second run on the same day finds the batch in the ledger and does not send it again.
"""

from __future__ import annotations

import io
import re
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TextIO

import psycopg
from psycopg.types.json import Jsonb

from mend_engine.config import SANDBOX_API_HOST, Config, ConfigError, load_config
from mend_engine.db.connect import connect
from mend_engine.money import MoneyError, to_decimal_string, to_minor
from mend_engine.paypal.http import HostRefused, PayPalError, PayPalHttp
from mend_engine.paypal.payouts import (
    BatchExistsUnresolved,
    BatchSnapshot,
    PayoutItemSpec,
    SnapshotRefused,
    SubmissionUnknown,
    get_batch,
    get_item,
    sender_batch_id_for,
    snapshot_hash,
    submit_batch,
)
from mend_engine.paypal.transactions import sdk_client_for, search_transactions

ENV_PATH = Path(__file__).resolve().parents[3] / ".env"
ACTOR = "prove_m1"
NOTE = "Thank you for being a regular. Mend M1 proof."
SUBJECT = "A thank-you from the shop"
SENDER_ITEM_ID = "m1-proof-1"
AMOUNT_MINOR = 100
POLL_EVERY_SECONDS = 10
POLL_FOR_SECONDS = 180
HISTORY_DAYS = 30
MAX_HISTORY_PAGES = 20
GOOD_ITEM_STATUSES = {"SUCCESS", "UNCLAIMED"}
FINAL_BAD_ITEM_STATUSES = {"FAILED", "BLOCKED", "RETURNED", "REFUNDED", "REVERSED"}

_T_CODE = re.compile(r"T[0-9]{4}", re.ASCII)
_STATUS = re.compile(r"[A-Z_]{1,36}", re.ASCII)
_PAYOUT_ID = re.compile(r"[A-Z0-9]{1,32}", re.ASCII)
_DECIMAL = re.compile(r"-?[0-9]{1,12}(\.[0-9]{1,2})?", re.ASCII)


class Tee:
    """Writes to the real stream and keeps a copy, so the secrets check can read it."""

    def __init__(self, stream: TextIO, copy: io.StringIO) -> None:
        self._stream = stream
        self._copy = copy

    def write(self, text: str) -> int:
        self._copy.write(text)
        return self._stream.write(text)

    def flush(self) -> None:
        self._stream.flush()

    def __getattr__(self, name: str) -> object:
        return getattr(self._stream, name)


def safe(value: object, limit: int = 80) -> str:
    """Printable ASCII only, so a value from PayPal cannot forge lines in this output."""
    text = "".join(ch if 0x20 <= ord(ch) < 0x7F else "?" for ch in str(value))
    return text[:limit]


class Proof:
    def __init__(self) -> None:
        self.results: list[bool] = []
        self.run_id = uuid.uuid4().hex
        self.conn: psycopg.Connection | None = None

    def line(self, ok: bool, text: str) -> None:
        self.results.append(ok)
        print(f"[{'PASS' if ok else 'FAIL'}] {text}", flush=True)

    def audit(self, action: str, detail: dict) -> None:
        if self.conn is None:
            return
        with self.conn.transaction():
            self.conn.execute(
                "insert into audit_log (actor, action, detail) values (%s, %s, %s)",
                (ACTOR, action, Jsonb({"run_id": self.run_id, **detail})),
            )


def describe(exc: BaseException) -> str:
    if isinstance(exc, SubmissionUnknown):
        return safe(f"SubmissionUnknown: {exc.reason} (status={exc.status} name={exc.name} debug_id={exc.debug_id})", 200)
    if isinstance(exc, PayPalError):
        return safe(f"{type(exc).__name__} status={exc.status} name={exc.name} debug_id={exc.debug_id}", 200)
    if isinstance(exc, (ConfigError, SnapshotRefused, HostRefused, MoneyError)):
        return safe(f"{type(exc).__name__}: {exc}", 200)
    return type(exc).__name__


def check_config(proof: Proof) -> tuple[Config, PayPalHttp] | None:
    try:
        config = load_config(str(ENV_PATH) if ENV_PATH.is_file() else None)
        http = PayPalHttp(config)
        sdk_base = sdk_client_for(http).config.get_base_uri()
    except Exception as exc:
        proof.line(False, f"config: refused to start ({describe(exc)})")
        return None
    ok = config.paypal_api_host == SANDBOX_API_HOST and sdk_base == "https://" + SANDBOX_API_HOST
    proof.line(ok, f"config: sandbox only, host {config.paypal_api_host} (Server SDK base {sdk_base})")
    return config, http


def check_balance(proof: Proof, http: PayPalHttp) -> None:
    try:
        response = http.request("GET", "/v1/reporting/balances?currency_code=USD")
    except Exception as exc:
        proof.line(False, f"balance: {describe(exc)}")
        return
    value = None
    for entry in response.body.get("balances") or []:
        if isinstance(entry, dict) and entry.get("currency") == "USD":
            available = entry.get("available_balance") or {}
            value = available.get("value") if isinstance(available, dict) else None
    if response.status != 200 or not isinstance(value, str) or not _DECIMAL.fullmatch(value):
        proof.line(False, f"balance: no USD balance (status {response.status}, debug_id {safe(response.debug_id)})")
        return
    proof.line(True, f"balance: {value} USD available")
    proof.audit("balance_read", {"available_usd": value})


def check_history(proof: Proof, http: PayPalHttp) -> None:
    end = datetime.now(timezone.utc).replace(microsecond=0)
    start = end - timedelta(days=HISTORY_DAYS)
    rows: list[dict] = []
    total_items = 0
    try:
        page_number = 1
        while True:
            page = search_transactions(http, start, end, page=page_number, page_size=100)
            total_items = page.total_items
            rows.extend(page.rows)
            if page_number >= page.total_pages or page_number >= MAX_HISTORY_PAGES:
                break
            page_number += 1
    except Exception as exc:
        proof.line(False, f"history: {describe(exc)}")
        return
    with_email = sum(1 for row in rows if row["payer_info"].get("email_address"))
    codes = sorted(
        {
            code if isinstance(code, str) and _T_CODE.fullmatch(code) else "other"
            for code in (row["transaction_info"].get("transaction_event_code") for row in rows)
        }
    )
    proof.line(
        True,
        f"history: {total_items} rows in the last {HISTORY_DAYS} days; {with_email} with payer email; "
        f"T-codes seen: {', '.join(codes) if codes else 'none'}",
    )
    if total_items == 0:
        print(
            "       NOTE: PayPal says new transactions can take up to 3 hours to appear in "
            "Transaction Search, so zero rows may be that lag.",
            flush=True,
        )
    proof.audit("history_read", {"total_items": total_items, "with_payer_email": with_email, "t_codes": codes})


def build_snapshot(config: Config) -> BatchSnapshot:
    if not config.test_receiver:
        raise ConfigError("MEND_TEST_RECEIVER is not set")
    return BatchSnapshot(
        campaign_id="m1-proof-" + datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        currency="USD",
        email_subject=SUBJECT,
        items=(
            PayoutItemSpec(
                receiver_email=config.test_receiver,
                amount_minor=AMOUNT_MINOR,
                note=NOTE,
                sender_item_id=SENDER_ITEM_ID,
            ),
        ),
    )


def send_payout(proof: Proof, http: PayPalHttp, snapshot: BatchSnapshot) -> str | None:
    conn = proof.conn
    assert conn is not None
    sender_batch_id = sender_batch_id_for(snapshot)
    digest = snapshot_hash(snapshot)
    amount = to_decimal_string(AMOUNT_MINOR)
    # The ledger row is claimed before PayPal is called. Only the run that inserts
    # it may send; any later run finds the row and sends nothing.
    with conn.transaction():
        claimed = conn.execute(
            "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, status) "
            "values (%s, %s, %s, 'submitting') on conflict (sender_batch_id) do nothing "
            "returning sender_batch_id",
            (sender_batch_id, snapshot.campaign_id, digest),
        ).fetchone()
    if claimed is None:
        row = conn.execute(
            "select payout_batch_id, status from payout_batches where sender_batch_id = %s",
            (sender_batch_id,),
        ).fetchone()
        payout_batch_id, status = row if row else (None, None)
        proof.audit("payout_skipped_already_in_ledger", {"sender_batch_id": sender_batch_id, "status": status})
        if payout_batch_id:
            proof.line(
                True,
                f"payout: created {payout_batch_id} for {amount} USD to the test receiver "
                "(by an earlier run today; this run did not send it again)",
            )
            return payout_batch_id
        proof.line(False, f"payout: an earlier run left {sender_batch_id} as '{safe(status)}'; reconcile before paying")
        return None

    try:
        result = submit_batch(http, snapshot)
    except Exception as exc:
        status = "submission_unknown" if isinstance(exc, SubmissionUnknown) else "refused"
        with conn.transaction():
            conn.execute(
                "update payout_batches set status = %s where sender_batch_id = %s", (status, sender_batch_id)
            )
        proof.audit("payout_submit", {"sender_batch_id": sender_batch_id, "snapshot_hash": digest, "outcome": status, "error": describe(exc)})
        proof.line(False, f"payout: {describe(exc)}")
        return None

    with conn.transaction():
        conn.execute(
            "update payout_batches set payout_batch_id = %s, status = %s where sender_batch_id = %s",
            (result.payout_batch_id, result.outcome, sender_batch_id),
        )
    proof.audit(
        "payout_submit",
        {
            "sender_batch_id": sender_batch_id,
            "snapshot_hash": digest,
            "outcome": result.outcome,
            "payout_batch_id": result.payout_batch_id,
            "amount": amount,
            "currency": "USD",
        },
    )
    proof.line(
        result.outcome == "created",
        f"payout: {result.outcome} {result.payout_batch_id} for {amount} USD to the test receiver",
    )
    return result.payout_batch_id


def find_item_id(http: PayPalHttp, payout_batch_id: str) -> tuple[str | None, str | None]:
    batch = get_batch(http, payout_batch_id)
    header = batch.get("batch_header") or {}
    batch_status = header.get("batch_status") if isinstance(header, dict) else None
    for entry in batch.get("items") or []:
        if not isinstance(entry, dict):
            continue
        payout_item = entry.get("payout_item") or {}
        item_id = entry.get("payout_item_id")
        if (
            isinstance(payout_item, dict)
            and payout_item.get("sender_item_id") == SENDER_ITEM_ID
            and isinstance(item_id, str)
            and _PAYOUT_ID.fullmatch(item_id)
        ):
            return item_id, batch_status
    return None, batch_status


def watch_status(proof: Proof, http: PayPalHttp, payout_batch_id: str, sender_batch_id: str) -> None:
    conn = proof.conn
    assert conn is not None
    deadline = time.monotonic() + POLL_FOR_SECONDS
    item_id: str | None = None
    status = "UNKNOWN"
    fee_text = "unknown"
    try:
        while True:
            # The batch is re-read on every poll, just before the item, so both
            # ledger rows end on the last status PayPal reported for each.
            found_id, batch_status = find_item_id(http, payout_batch_id)
            if item_id is None:
                item_id = found_id
            if isinstance(batch_status, str) and _STATUS.fullmatch(batch_status):
                with conn.transaction():
                    conn.execute(
                        "update payout_batches set status = %s where sender_batch_id = %s",
                        (batch_status, sender_batch_id),
                    )
            if item_id is not None:
                item = get_item(http, item_id)
                raw_status = item.get("transaction_status")
                status = raw_status if isinstance(raw_status, str) and _STATUS.fullmatch(raw_status) else "UNKNOWN"
                fee = item.get("payout_item_fee") or {}
                fee_value = fee.get("value") if isinstance(fee, dict) else None
                fee_minor = None
                if isinstance(fee_value, str) and _DECIMAL.fullmatch(fee_value):
                    fee_text = f"{fee_value} USD"
                    try:
                        fee_minor = to_minor(fee_value)
                    except MoneyError:
                        fee_minor = None
                with conn.transaction():
                    conn.execute(
                        "insert into payout_items (payout_item_id, sender_batch_id, sender_item_id, status, fee_minor) "
                        "values (%s, %s, %s, %s, %s) on conflict (payout_item_id) do update set "
                        "status = excluded.status, fee_minor = excluded.fee_minor, updated_at = now()",
                        (item_id, sender_batch_id, SENDER_ITEM_ID, status, fee_minor),
                    )
                if status in GOOD_ITEM_STATUSES or status in FINAL_BAD_ITEM_STATUSES:
                    break
            if time.monotonic() + POLL_EVERY_SECONDS > deadline:
                break
            time.sleep(POLL_EVERY_SECONDS)
    except Exception as exc:
        proof.line(False, f"payout status: {describe(exc)}")
        return
    proof.audit("payout_status", {"payout_item_id": item_id, "status": status, "fee": fee_text})
    if item_id is None:
        proof.line(False, "payout status: PayPal listed no item for this batch within 3 minutes")
        return
    proof.line(status in GOOD_ITEM_STATUSES, f"payout status: {status} fee {fee_text}")


def check_duplicate(proof: Proof, http: PayPalHttp, snapshot: BatchSnapshot, first_id: str) -> None:
    conn = proof.conn
    assert conn is not None
    row = conn.execute(
        "select payout_batch_id from payout_batches where sender_batch_id = %s",
        (sender_batch_id_for(snapshot),),
    ).fetchone()
    ledger_id = row[0] if row else None
    try:
        result = submit_batch(http, snapshot, known_payout_batch_id=ledger_id)
    except Exception as exc:
        proof.audit("payout_duplicate", {"sender_batch_id": sender_batch_id_for(snapshot), "error": describe(exc)})
        proof.line(False, f"duplicate: same snapshot again did not return already_existed: {describe(exc)}")
        return
    proof.audit(
        "payout_duplicate",
        {"sender_batch_id": result.sender_batch_id, "outcome": result.outcome, "payout_batch_id": result.payout_batch_id},
    )
    if result.outcome == "already_existed" and result.payout_batch_id == first_id == ledger_id:
        proof.line(True, "duplicate: same snapshot again returned already_existed with the same payout_batch_id")
    else:
        proof.line(False, f"duplicate: same snapshot again returned {result.outcome} {result.payout_batch_id}")


def check_duplicate_without_ledger_id(proof: Proof, http: PayPalHttp, snapshot: BatchSnapshot) -> None:
    sender_batch_id = sender_batch_id_for(snapshot)
    try:
        result = submit_batch(http, snapshot)
    except BatchExistsUnresolved as exc:
        proof.audit(
            "payout_duplicate_unresolved",
            {"sender_batch_id": exc.sender_batch_id, "status": exc.status, "name": exc.name, "debug_id": exc.debug_id},
        )
        proof.line(
            exc.sender_batch_id == sender_batch_id,
            "duplicate without ledger id: PayPal confirms the batch exists, marked unresolved, nothing sent",
        )
        return
    except Exception as exc:
        proof.audit("payout_duplicate_unresolved", {"sender_batch_id": sender_batch_id, "error": describe(exc)})
        proof.line(False, f"duplicate without ledger id: expected BatchExistsUnresolved, got {describe(exc)}")
        return
    proof.audit(
        "payout_duplicate_unresolved",
        {"sender_batch_id": sender_batch_id, "outcome": result.outcome, "payout_batch_id": result.payout_batch_id},
    )
    proof.line(False, f"duplicate without ledger id: returned {result.outcome} {result.payout_batch_id}")


def check_host_guard(proof: Proof, http: PayPalHttp) -> None:
    before = http.requests_sent
    refused = []
    try:
        http.request("GET", "https://api-m.paypal.com/v1/reporting/balances")
    except HostRefused:
        refused.append("PayPalHttp")
    try:
        sdk_client_for(http).config.http_client.session.get(
            "https://api-m.paypal.com/v1/reporting/transactions", timeout=5
        )
    except HostRefused:
        refused.append("Server SDK session")
    ok = refused == ["PayPalHttp", "Server SDK session"] and http.requests_sent == before
    proof.audit("host_guard", {"target": "api-m.paypal.com", "refused_by": refused})
    proof.line(ok, f"host guard: request to api-m.paypal.com refused before sending ({' and '.join(refused) or 'not refused'})")


def check_ledger(proof: Proof, config: Config, sender_batch_id: str) -> None:
    # A second, fresh connection sees only committed rows, so this line cannot
    # pass on writes that are still waiting inside an open transaction.
    try:
        with connect(config) as conn:
            _count_ledger(proof, conn, sender_batch_id)
    except Exception as exc:
        proof.line(False, f"ledger: {describe(exc)}")


def _count_ledger(proof: Proof, conn: psycopg.Connection, sender_batch_id: str) -> None:
    batches = conn.execute("select count(*) from payout_batches where sender_batch_id = %s", (sender_batch_id,)).fetchone()[0]
    items = conn.execute("select count(*) from payout_items where sender_batch_id = %s", (sender_batch_id,)).fetchone()[0]
    audits = conn.execute(
        "select count(*) from audit_log where actor = %s and detail->>'run_id' = %s", (ACTOR, proof.run_id)
    ).fetchone()[0]
    ok = batches == 1 and items == 1 and audits > 0
    proof.line(ok, f"ledger: {batches} batch row, {items} item row, {audits} audit rows written")


def check_secrets(proof: Proof, http: PayPalHttp, captured: io.StringIO) -> None:
    conn = proof.conn
    audit_text = ""
    if conn is not None:
        audit_text = conn.execute("select coalesce(string_agg(detail::text, ' '), '') from audit_log").fetchone()[0]
    found = sorted(set(http.secrets_found_in(captured.getvalue())) | set(http.secrets_found_in(audit_text)))
    if found:
        proof.line(False, f"secrets: found {', '.join(found)} in this output or the audit table")
    else:
        proof.line(True, "secrets: none of the three secret values appear in this output or the audit table")


def run(captured: io.StringIO) -> bool:
    proof = Proof()
    started = check_config(proof)
    if started is None:
        return False
    config, http = started
    try:
        proof.conn = connect(config)
    except Exception as exc:
        print(f"       NOTE: ledger database unavailable ({describe(exc)}); no payout will be sent.", flush=True)
    proof.audit("config_loaded", {"host": config.paypal_api_host})
    check_balance(proof, http)
    check_history(proof, http)

    snapshot = build_snapshot(config)
    sender_batch_id = sender_batch_id_for(snapshot)
    payout_batch_id = None
    if proof.conn is None:
        proof.line(False, "payout: refused to pay without a ledger")
    else:
        payout_batch_id = send_payout(proof, http, snapshot)
    if payout_batch_id is not None:
        watch_status(proof, http, payout_batch_id, sender_batch_id)
        check_duplicate(proof, http, snapshot, payout_batch_id)
        check_duplicate_without_ledger_id(proof, http, snapshot)
    else:
        proof.line(False, "payout status: skipped, no batch")
        proof.line(False, "duplicate: skipped, no batch")
        proof.line(False, "duplicate without ledger id: skipped, no batch")
    check_host_guard(proof, http)
    if proof.conn is not None:
        check_ledger(proof, config, sender_batch_id)
    else:
        proof.line(False, "ledger: no database")
    check_secrets(proof, http, captured)
    http.close()
    if proof.conn is not None:
        proof.conn.close()
    return all(proof.results) and len(proof.results) == 10


def main() -> int:
    captured = io.StringIO()
    real_out, real_err = sys.stdout, sys.stderr
    sys.stdout = Tee(real_out, captured)
    sys.stderr = Tee(real_err, captured)
    passed = False
    try:
        passed = run(captured)
        print(f"M1 RESULT: {'PASS' if passed else 'FAIL'}", flush=True)
    finally:
        sys.stdout, sys.stderr = real_out, real_err
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
