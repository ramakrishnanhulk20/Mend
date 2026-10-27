"""Pulling a campaign's unclaimed cashback back to the shop now (PLAN.md 3c).

A payout to someone with no PayPal account waits as UNCLAIMED, and PayPal returns
it by itself after 30 days. This asks PayPal to return it sooner with the Payouts
cancel call, one item at a time. Only items the ledger holds as UNCLAIMED are asked
about, each under a lock on its ledger row, and PayPal's answer goes through the
same forward-only state machine the webhooks use (C10). PayPal cancels only while
an item is UNCLAIMED, so a claim that lands first is refused by PayPal, not undone;
after a refusal the item is read back from PayPal, so the ledger stops calling it
UNCLAIMED once PayPal does not. An item whose cancel failed rests for an hour on its
own, so one item PayPal keeps failing on never holds up the others.

read_back and read_batch_back are the scheduled reads keyed on the ledger's own
records: one item, or a whole batch whose item rows the ledger lacks (C10).
"""

from __future__ import annotations

import re
import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import timedelta

import psycopg
from psycopg.types.json import Jsonb

from mend_engine.campaigns.approval import frozen_snapshot
from mend_engine.events.payout_status import ItemChange, ItemConflict, as_seen, effective, record_item_status
from mend_engine.money import MoneyError, to_minor
from mend_engine.paypal.http import PayPalError, PayPalHttp
# _PAYOUT_ID is the id shape get_item and cancel_item accept, so an id recorded from
# a batch read can always be read and cancelled later.
from mend_engine.paypal.payouts import _PAYOUT_ID, cancel_item, get_batch, get_item

ACTOR = "cancel"
UNCLAIMED = "UNCLAIMED"
RETURNED = "RETURNED"
CANCEL_REST_AFTER = timedelta(hours=1)
# Two items in a row that PayPal cannot answer for point at PayPal, not at the items.
MAX_FAILURES_IN_A_ROW = 2
# True when payout_items row "i" has a "payout_item_cancel_failed" audit row from the
# last CANCEL_REST_AFTER, the named parameter rest. Shared so the cancel job picks
# campaigns by the same rule cancel_unclaimed picks items.
ITEM_RESTING_SQL = (
    "exists (select 1 from audit_log a where a.action = 'payout_item_cancel_failed' "
    "and a.at > now() - %(rest)s and a.detail ->> 'payout_item_id' = i.payout_item_id)"
)
_INSERT_AUDIT = "insert into audit_log (actor, action, detail) values (%s, %s, %s)"
_ERROR_NAME = re.compile(r"[A-Z0-9_]{1,64}", re.ASCII)
_DEBUG_ID = re.compile(r"[A-Za-z0-9]{1,64}", re.ASCII)


@dataclass(frozen=True)
class CancelReport:
    """What one run did. Money is in USD cents, at each item's approved amount.

    cancelled counts items PayPal accepted the cancel for, and returned_minor sums
    those it answered RETURNED. still_unclaimed counts the campaign's items the
    ledger holds as UNCLAIMED when the run ends, resting ones included.
    not_cancellable counts items PayPal refused with a 4xx answer, and failed the
    items PayPal gave a 5xx, no answer or an unreadable answer for.
    """

    cancelled: int
    returned_minor: int
    still_unclaimed: int
    not_cancellable: int
    failed: int = 0


class CancelIncomplete(PayPalError):
    """PayPal could not answer for at least one item. report is what the run did; status, name and debug_id are the last failure's."""

    def __init__(self, report: CancelReport, failure: PayPalError) -> None:
        super().__init__(failure.status, failure.name, failure.debug_id)
        self.report = report


class ReadBackRefused(ValueError):
    """PayPal's answer for an item does not match the ledger's record of it, so nothing was recorded."""


@dataclass(frozen=True)
class BatchReadBack:
    """What one read of a batch recorded.

    changes holds (payout_item_id, ItemChange) for each item recorded, in PayPal's
    order. skipped holds (payout_item_id, reason) for each item not recorded, with
    payout_item_id None when PayPal's id does not have a payout id's shape; every
    reason is a fixed text, never PayPal's.
    """

    changes: tuple[tuple[str, ItemChange], ...]
    skipped: tuple[tuple[str | None, str], ...]


def cancel_unclaimed(
    conn: psycopg.Connection, http: PayPalHttp, campaign_id: uuid.UUID, *, limit: int | None = None
) -> CancelReport:
    """Ask PayPal to cancel the campaign's UNCLAIMED payout items, in payout_item_id order.

    Leaves out each item with a "payout_item_cancel_failed" audit row from the last
    hour (ITEM_RESTING_SQL), so an item whose cancel failed rests on its own while
    the campaign's other items are still asked about. For each other item, in one
    transaction: locks its payout_items row, checks it is still UNCLAIMED (skipping
    it if not), calls cancel_item, records PayPal's answer with record_item_status
    and writes one "payout_item_cancelled" audit row holding the item id and that
    status. A 4xx answer counts the item as not cancellable, reads the item back
    from PayPal with read_back so the ledger holds PayPal's real status, writes a
    "payout_item_cancel_failed" audit row holding status_now (the status the ledger
    holds after the read, or None when PayPal could not be read or its answer did
    not match the ledger) and goes on. Any other PayPal failure (a 5xx, no answer,
    an unreadable 200) writes the same audit row without status_now, counts the item
    as failed and goes on to the next item; after 2 such failures in a row the run
    stops and later items are not asked about. Items already cancelled stay
    cancelled. At most one cancel call per item, and a campaign's one batch holds at
    most 200 items. With limit, stops once limit items have been asked about; items
    found no longer UNCLAIMED were not asked about and do not count.

    Returns the run's CancelReport when no item failed. Raises CancelIncomplete,
    carrying that report, when the run ends with any failed item, so a caller still
    learns PayPal could not answer; ValueError for a campaign_id that is not a UUID
    or a limit that is not a whole number from 1 up; SnapshotRefused if the frozen
    snapshot no longer matches its hash.
    """
    if not isinstance(campaign_id, uuid.UUID):
        raise ValueError("campaign_id must be a UUID")
    if limit is not None and (type(limit) is not int or limit < 1):
        raise ValueError("limit must be None or a whole number from 1 up")
    snap = frozen_snapshot(conn, campaign_id)
    price = {item.sender_item_id: item.amount_minor for item in snap.items} if snap else {}
    cancelled = returned_minor = not_cancellable = failed = asked = in_a_row = 0
    last_failure: PayPalError | None = None
    for payout_item_id in _unclaimed_items(conn, campaign_id, resting_too=False):
        if limit is not None and asked >= limit:
            break
        try:
            answer = _cancel_one(conn, http, payout_item_id)
        except PayPalError as exc:
            asked += 1
            detail = {"payout_item_id": payout_item_id, **_error_detail(exc)}
            if exc.status is not None and 400 <= exc.status < 500:
                not_cancellable += 1
                in_a_row = 0
                _audit(conn, "payout_item_cancel_failed", {**detail, "status_now": _status_after_read_back(conn, http, payout_item_id)})
                continue
            _audit(conn, "payout_item_cancel_failed", detail)
            failed += 1
            in_a_row += 1
            last_failure = exc
            if in_a_row >= MAX_FAILURES_IN_A_ROW:
                break
            continue
        if answer is None:
            continue
        asked += 1
        in_a_row = 0
        status, sender_item_id = answer
        cancelled += 1
        if status == RETURNED:
            returned_minor += price.get(sender_item_id, 0)
    report = CancelReport(
        cancelled, returned_minor, len(_unclaimed_items(conn, campaign_id, resting_too=True)), not_cancellable, failed
    )
    if last_failure is not None:
        raise CancelIncomplete(report, last_failure) from last_failure
    return report


def read_back(conn: psycopg.Connection, http: PayPalHttp, payout_item_id: str) -> ItemChange:
    """Read one payout item from PayPal and record its status and fee, moving the status only forward (C10).

    Acts only on an item the ledger holds under a batch whose payout_batch_id the
    ledger knows, and only when PayPal's answer names that same payout_item_id,
    sender_batch_id, payout_batch_id and sender_item_id. Records through
    record_item_status, so a stale or reordered answer can never undo a later one.

    Raises LookupError when the ledger holds no such item; ReadBackRefused, with
    nothing written, when the ledger has no payout_batch_id for the item's batch yet
    or PayPal's answer does not match the ledger; PayoutIdRefused for a malformed id;
    PayPalError when PayPal answers with an error or cannot be reached.
    """
    row = conn.execute(
        "select i.sender_batch_id, i.sender_item_id, b.payout_batch_id from payout_items i "
        "join payout_batches b on b.sender_batch_id = i.sender_batch_id where i.payout_item_id = %s",
        (payout_item_id,),
    ).fetchone()
    if row is None:
        raise LookupError("the ledger holds no such payout item")
    sender_batch_id, sender_item_id, payout_batch_id = row
    if payout_batch_id is None:
        raise ReadBackRefused("the ledger has no payout_batch_id for the item's batch yet")
    item = get_item(http, payout_item_id)
    payout_item = item.get("payout_item")
    # Compared with the ledger's own values, so PayPal's answer is trusted only for the item we hold.
    named = (
        item.get("payout_item_id"),
        item.get("sender_batch_id"),
        item.get("payout_batch_id"),
        payout_item.get("sender_item_id") if isinstance(payout_item, dict) else None,
    )
    if named != (payout_item_id, sender_batch_id, payout_batch_id, sender_item_id):
        raise ReadBackRefused("PayPal's answer is not for this item in our batch")
    return record_item_status(
        conn,
        payout_item_id=payout_item_id,
        sender_batch_id=sender_batch_id,
        sender_item_id=sender_item_id,
        seen=as_seen(item.get("transaction_status")),
        fee_minor=_fee_minor(item.get("payout_item_fee")),
    )


def read_batch_back(conn: psycopg.Connection, http: PayPalHttp, sender_batch_id: str) -> BatchReadBack:
    """Read one batch from PayPal and record its items, inserting the rows the ledger lacks (C10).

    Acts only on a batch the ledger holds with a payout_batch_id, for a campaign
    with a frozen snapshot, and only when PayPal's answer names that same
    payout_batch_id and sender_batch_id. Each item PayPal lists is recorded through
    record_item_status only when: its payout_item_id has a payout id's shape; any
    payout_batch_id or sender_batch_id it names is the ledger's (PayPal's own sample
    leaves them off some items); its sender_item_id is in the frozen snapshot and
    appears once in PayPal's answer; and the ledger holds neither that sender_item_id
    under another payout_item_id nor that payout_item_id under another
    sender_item_id or batch. Every other item is skipped. Runs inside the caller's
    transaction when there is one, each item in its own savepoint.

    Covers only what one GET returns: PayPal's default page is 1000 items and a
    batch holds at most 200.

    Raises LookupError when the ledger holds no such batch; ReadBackRefused, with
    nothing written, when the ledger has no payout_batch_id for it yet, it belongs
    to no campaign with a frozen snapshot, or PayPal's answer is not for this batch
    or lists no items; SnapshotRefused if the frozen snapshot no longer matches its
    hash; PayPalError when PayPal answers with an error or cannot be reached.
    """
    row = conn.execute(
        "select payout_batch_id, campaign_id from payout_batches where sender_batch_id = %s", (sender_batch_id,)
    ).fetchone()
    if row is None:
        raise LookupError("the ledger holds no such payout batch")
    payout_batch_id, campaign_text = row
    if payout_batch_id is None:
        raise ReadBackRefused("the ledger has no payout_batch_id for this batch yet")
    try:
        campaign_id = uuid.UUID(campaign_text)
    except ValueError:
        raise ReadBackRefused("the batch belongs to no campaign") from None
    snap = frozen_snapshot(conn, campaign_id)
    if snap is None:
        raise ReadBackRefused("the batch's campaign has no frozen snapshot")
    batch = get_batch(http, payout_batch_id)
    header = batch.get("batch_header")
    sender_header = header.get("sender_batch_header") if isinstance(header, dict) else None
    named = (
        header.get("payout_batch_id") if isinstance(header, dict) else None,
        sender_header.get("sender_batch_id") if isinstance(sender_header, dict) else None,
    )
    if named != (payout_batch_id, sender_batch_id):
        raise ReadBackRefused("PayPal's answer is not for this batch")
    entries = batch.get("items")
    if not isinstance(entries, list):
        raise ReadBackRefused("PayPal's answer lists no items")

    in_snapshot = {item.sender_item_id for item in snap.items}
    listed = Counter(_sender_item_id(entry) for entry in entries)
    held = dict(
        conn.execute("select payout_item_id, sender_item_id from payout_items where sender_batch_id = %s", (sender_batch_id,))
    )
    holder = {sender_item_id: payout_item_id for payout_item_id, sender_item_id in held.items()}
    changes: list[tuple[str, ItemChange]] = []
    skipped: list[tuple[str | None, str]] = []
    for entry in entries:
        payout_item_id = entry.get("payout_item_id") if isinstance(entry, dict) else None
        if not isinstance(payout_item_id, str) or not _PAYOUT_ID.fullmatch(payout_item_id):
            skipped.append((None, "the payout_item_id is malformed"))
            continue
        sender_item_id = _sender_item_id(entry)
        reason = None
        if entry.get("payout_batch_id") not in (None, payout_batch_id) or entry.get("sender_batch_id") not in (None, sender_batch_id):
            reason = "the item names another batch"
        elif sender_item_id not in in_snapshot:
            reason = "the sender_item_id is not in the frozen snapshot"
        elif listed[sender_item_id] > 1:
            reason = "the sender_item_id appears more than once in PayPal's answer"
        elif holder.get(sender_item_id, payout_item_id) != payout_item_id or held.get(payout_item_id, sender_item_id) != sender_item_id:
            reason = "the ledger holds this item under another id"
        if reason is not None:
            skipped.append((payout_item_id, reason))
            continue
        try:
            change = record_item_status(
                conn,
                payout_item_id=payout_item_id,
                sender_batch_id=sender_batch_id,
                sender_item_id=sender_item_id,
                seen=as_seen(entry.get("transaction_status")),
                fee_minor=_fee_minor(entry.get("payout_item_fee")),
            )
        except ItemConflict:
            skipped.append((payout_item_id, "the item is stored under another batch"))
            continue
        changes.append((payout_item_id, change))
    return BatchReadBack(tuple(changes), tuple(skipped))


def _sender_item_id(entry: object) -> str | None:
    payout_item = entry.get("payout_item") if isinstance(entry, dict) else None
    value = payout_item.get("sender_item_id") if isinstance(payout_item, dict) else None
    return value if isinstance(value, str) else None


def _status_after_read_back(conn: psycopg.Connection, http: PayPalHttp, payout_item_id: str) -> str | None:
    """The status the ledger holds once the item is read back, or None when the read failed or was refused."""
    try:
        return read_back(conn, http, payout_item_id).stored
    except (PayPalError, ReadBackRefused, LookupError):
        return None


def _fee_minor(fee: object) -> int | None:
    if not isinstance(fee, dict):
        return None
    try:
        return to_minor(fee.get("value"), fee.get("currency"))
    except MoneyError:
        return None


def _unclaimed_items(conn: psycopg.Connection, campaign_id: uuid.UUID, *, resting_too: bool) -> list[str]:
    """Ids of the campaign's items whose status, read the way every decision reads it, is UNCLAIMED.

    Items resting after a failed cancel (ITEM_RESTING_SQL) are left out unless resting_too.
    """
    rows = conn.execute(
        "select i.payout_item_id, i.status, " + ITEM_RESTING_SQL + " from payout_items i "
        "join payout_batches b on b.sender_batch_id = i.sender_batch_id "
        "where b.campaign_id = %(campaign)s order by i.payout_item_id",
        {"campaign": str(campaign_id), "rest": CANCEL_REST_AFTER},
    ).fetchall()
    return [
        payout_item_id
        for payout_item_id, status, resting in rows
        if effective(status) == UNCLAIMED and (resting_too or not resting)
    ]


def _cancel_one(conn: psycopg.Connection, http: PayPalHttp, payout_item_id: str) -> tuple[str, str] | None:
    """(PayPal's status, sender_item_id) for one cancelled item, or None when it is no longer UNCLAIMED."""
    with conn.transaction():
        # Held until PayPal answers, so a webhook run recording this item waits and
        # then meets the cancel's result in the state machine, never the other way round.
        row = conn.execute(
            "select status, sender_batch_id, sender_item_id from payout_items where payout_item_id = %s for update",
            (payout_item_id,),
        ).fetchone()
        if row is None or effective(row[0]) != UNCLAIMED:
            return None
        _, sender_batch_id, sender_item_id = row
        seen = as_seen(cancel_item(http, payout_item_id))
        record_item_status(
            conn,
            payout_item_id=payout_item_id,
            sender_batch_id=sender_batch_id,
            sender_item_id=sender_item_id,
            seen=seen,
            fee_minor=None,
        )
        conn.execute(_INSERT_AUDIT, (ACTOR, "payout_item_cancelled", Jsonb({"payout_item_id": payout_item_id, "status": seen})))
    return seen, sender_item_id


def _error_detail(exc: PayPalError) -> dict:
    # PayPal's own strings, kept only when they have the shape PayPal uses, so nothing else reaches the audit log.
    return {
        "http_status": exc.status,
        "name": exc.name if isinstance(exc.name, str) and _ERROR_NAME.fullmatch(exc.name) else None,
        "debug_id": exc.debug_id if isinstance(exc.debug_id, str) and _DEBUG_ID.fullmatch(exc.debug_id) else None,
    }


def _audit(conn: psycopg.Connection, action: str, detail: dict) -> None:
    with conn.transaction():
        conn.execute(_INSERT_AUDIT, (ACTOR, action, Jsonb(detail)))
