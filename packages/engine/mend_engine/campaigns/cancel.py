"""Pulling a campaign's unclaimed cashback back to the shop now (PLAN.md 3c).

A payout to someone with no PayPal account waits as UNCLAIMED, and PayPal returns
it by itself after 30 days. This asks PayPal to return it sooner with the Payouts
cancel call, one item at a time. Only items the ledger holds as UNCLAIMED are asked
about, each under a lock on its ledger row, and PayPal's answer goes through the
same forward-only state machine the webhooks use (C10). PayPal cancels only while
an item is UNCLAIMED, so a claim that lands first is refused by PayPal, not undone.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass

import psycopg
from psycopg.types.json import Jsonb

from mend_engine.campaigns.approval import frozen_snapshot
from mend_engine.events.payout_status import as_seen, effective, record_item_status
from mend_engine.paypal.http import PayPalError, PayPalHttp
from mend_engine.paypal.payouts import cancel_item

ACTOR = "cancel"
UNCLAIMED = "UNCLAIMED"
RETURNED = "RETURNED"
_INSERT_AUDIT = "insert into audit_log (actor, action, detail) values (%s, %s, %s)"
_ERROR_NAME = re.compile(r"[A-Z0-9_]{1,64}", re.ASCII)
_DEBUG_ID = re.compile(r"[A-Za-z0-9]{1,64}", re.ASCII)


@dataclass(frozen=True)
class CancelReport:
    """What one run did. Money is in USD cents, at each item's approved amount.

    cancelled counts items PayPal accepted the cancel for, and returned_minor sums
    those it answered RETURNED. still_unclaimed counts the campaign's items the
    ledger holds as UNCLAIMED when the run ends. not_cancellable counts items
    PayPal refused with a 4xx answer.
    """

    cancelled: int
    returned_minor: int
    still_unclaimed: int
    not_cancellable: int


def cancel_unclaimed(conn: psycopg.Connection, http: PayPalHttp, campaign_id: uuid.UUID) -> CancelReport:
    """Ask PayPal to cancel each of the campaign's UNCLAIMED payout items, in payout_item_id order.

    For each item, in one transaction: locks its payout_items row, checks it is
    still UNCLAIMED (skipping it if not), calls cancel_item, records PayPal's answer
    with record_item_status and writes one "payout_item_cancelled" audit row holding
    the item id and that status. A 4xx answer counts the item as not cancellable,
    writes a "payout_item_cancel_failed" audit row and goes on. Any other PayPal
    failure (a 5xx, no answer, an unreadable 200) writes the same audit row and is
    raised at once, so later items are not asked about; items already cancelled stay
    cancelled. At most one call per item, and a campaign's one batch holds at most
    200 items.

    Raises ValueError for a campaign_id that is not a UUID, SnapshotRefused if the
    frozen snapshot no longer matches its hash, and PayPalError as above.
    """
    if not isinstance(campaign_id, uuid.UUID):
        raise ValueError("campaign_id must be a UUID")
    snap = frozen_snapshot(conn, campaign_id)
    price = {item.sender_item_id: item.amount_minor for item in snap.items} if snap else {}
    cancelled = returned_minor = not_cancellable = 0
    for payout_item_id in _unclaimed_items(conn, campaign_id):
        try:
            answer = _cancel_one(conn, http, payout_item_id)
        except PayPalError as exc:
            _audit(conn, "payout_item_cancel_failed", {"payout_item_id": payout_item_id, **_error_detail(exc)})
            if exc.status is not None and 400 <= exc.status < 500:
                not_cancellable += 1
                continue
            raise
        if answer is None:
            continue
        status, sender_item_id = answer
        cancelled += 1
        if status == RETURNED:
            returned_minor += price.get(sender_item_id, 0)
    return CancelReport(cancelled, returned_minor, len(_unclaimed_items(conn, campaign_id)), not_cancellable)


def _unclaimed_items(conn: psycopg.Connection, campaign_id: uuid.UUID) -> list[str]:
    """Ids of the campaign's items whose status, read the way every decision reads it, is UNCLAIMED."""
    rows = conn.execute(
        "select i.payout_item_id, i.status from payout_items i "
        "join payout_batches b on b.sender_batch_id = i.sender_batch_id "
        "where b.campaign_id = %s order by i.payout_item_id",
        (str(campaign_id),),
    ).fetchall()
    return [payout_item_id for payout_item_id, status in rows if effective(status) == UNCLAIMED]


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
