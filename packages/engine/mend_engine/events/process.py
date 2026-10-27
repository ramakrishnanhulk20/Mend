"""Acting on verified PayPal webhook deliveries (C10, C23, C27).

The web app stores a delivery in paypal_events only after PayPal's verify call
says SUCCESS (C9). Even so, an event is only a prompt. This module takes nothing
from it but the id of the resource it names, reads that resource back from
PayPal, and acts on PayPal's answer alone: payout items and batches only when
PayPal places them in a batch our ledger holds, purchases only for orders our
simulate button created. Every delivery gets exactly one outcome row. Outcome
rows hold ids, statuses and fixed reasons only, so they can outlive the 48-hour
purge of the raw body.
"""

from __future__ import annotations

import json
import re
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import psycopg
from psycopg.types.json import Jsonb

from mend_engine.campaigns.approval import frozen_snapshot
from mend_engine.campaigns.attribution import SimulatedMatch, attribute_purchase, simulated_order_for, utc_time
from mend_engine.campaigns.simulate import read_order
from mend_engine.events.payout_status import ItemConflict, as_seen, record_item_status
from mend_engine.money import MoneyError, to_minor
from mend_engine.paypal.http import PayPalError, PayPalHttp
from mend_engine.paypal.payouts import SnapshotRefused, get_batch, get_item, sender_batch_id_for

ACTOR = "events"
MAX_ATTEMPTS = 5
# A delivery whose re-read failed is tried again only this long after, however often
# runs are nudged, so MAX_ATTEMPTS spans at least 20 minutes of PayPal being down.
RETRY_AFTER = timedelta(minutes=5)
MAX_LIMIT = 500
# A delivery stored while a run holds the lock is picked up by that run's next pass;
# the cap stops a steady stream of deliveries from keeping one call going for ever.
MAX_PASSES = 3
# Held for a whole run, so two runs never act on the same event at once (C20).
EVENT_LOCK = 7731300004
ITEM_PREFIX = "PAYMENT.PAYOUTS-ITEM."
BATCH_PREFIX = "PAYMENT.PAYOUTSBATCH."
CAPTURE_COMPLETED = "PAYMENT.CAPTURE.COMPLETED"
# A campaign in one of these may have a batch at PayPal whose id the ledger lacks.
RESOLVABLE = ("submitting", "submission_unknown", "exists_unresolved")
# A campaign in one of these waits on PayPal's batch event to settle it, so that event is never given up.
UNSETTLED = ("submission_unknown", "exists_unresolved")
RESOLVED_LEDGER_STATUS = "resolved_by_event"
# PayPal's batch status for a batch it did not process: no item in it paid anyone.
DENIED = "DENIED"
# An item PayPal never named gets a ledger row under this id. ":" and lower case keep it
# out of the payout id shape, so get_item and cancel_item refuse it before any request.
DENIED_ITEM_ID = "denied:{sender_batch_id}:{sender_item_id}"
# True when delivery "e" had a failed re-read within the named parameter rest.
_RESTING_SQL = (
    "exists (select 1 from audit_log a where a.action = 'event_attempt_failed' "
    "and a.detail ->> 'transmission_id' = e.transmission_id and a.at > now() - %(rest)s)"
)

_PAYOUT_ID = re.compile(r"[A-Z0-9]{1,32}", re.ASCII)
_SENDER_BATCH_ID = re.compile(r"[A-Za-z0-9_.:-]{1,256}", re.ASCII)
_SENDER_ITEM_ID = re.compile(r"[A-Za-z0-9_-]{1,63}", re.ASCII)
_ORDER_ID = re.compile(r"[A-Z0-9]{1,36}", re.ASCII)
_ERROR_NAME = re.compile(r"[A-Z0-9_]{1,64}", re.ASCII)
_DEBUG_ID = re.compile(r"[A-Za-z0-9]{1,64}", re.ASCII)


@dataclass(frozen=True)
class ProcessReport:
    """ran is False when another run held the lock and nothing was read.

    outcomes counts the outcome rows this run wrote, by outcome. retrying counts
    events left without an outcome for the next run, because PayPal could not be
    read or the ledger is still waiting on the batch's id. passes counts the times
    this call held the lock and read deliveries: 0 when ran is False, at most 3.
    """

    ran: bool
    outcomes: dict[str, int] = field(default_factory=dict)
    retrying: int = 0
    passes: int = 0

    @property
    def processed(self) -> int:
        return sum(self.outcomes.values())


@dataclass(frozen=True)
class _Retry:
    """No outcome yet. keep is True when the delivery may be what an unsettled campaign is waiting on, so it is never given up."""

    detail: dict
    keep: bool = False


class _AlreadyDecided(Exception):
    """Another writer gave this delivery its outcome first; this run's effects are rolled back."""


def process_events(conn: psycopg.Connection, http: PayPalHttp, *, limit: int = 100) -> ProcessReport:
    """Give up to limit stored deliveries with no outcome yet their one outcome, oldest first.

    For each, by its stored event_type:
    - PAYMENT.PAYOUTS-ITEM.*: reads the item named by resource.payout_item_id from
      PayPal; only if PayPal puts it in a batch whose sender_batch_id is in
      payout_batches, under the payout_batch_id the ledger holds, records its status
      through the state machine ("status recorded", or "status refused" for a move
      the machine does not allow). When the ledger has no payout_batch_id for that
      batch yet, reads the batch PayPal names and, only if PayPal's batch carries
      the ledger's sender_batch_id, fills it in as a batch event would (and treats a
      DENIED batch as below) before recording the item; a batch that does not is
      "not ours".
    - PAYMENT.PAYOUTSBATCH.*: reads the batch named by its payout_batch_id; if its
      sender_batch_id is in the ledger and the campaign is submitting,
      submission_unknown or exists_unresolved, records the payout_batch_id and
      moves the campaign to submitted ("batch resolved"), else "batch unchanged".
      When PayPal says the batch is DENIED, every item of the campaign's frozen
      snapshot is recorded FAILED (record_denied_batch) and the outcome is "batch
      denied", holding items_failed.
    - PAYMENT.CAPTURE.COMPLETED: if the order named in
      supplementary_data.related_ids.order_id is in simulated_orders, reads it from
      PayPal and attributes it as simulated when PayPal says COMPLETED ("purchase
      recorded" or "purchase refused"). Any other order is "not ours", is never
      read, and its order id is not kept (C27).
    - Anything else: "ignored". A body that cannot be read: "malformed".
    A PayPal error during a re-read writes an "event_attempt_failed" audit row and
    no outcome; the delivery is tried again only once 5 minutes have passed since
    its last failed attempt, however many runs start meanwhile. The fifth failed
    attempt writes "gave up", except for a batch event while the campaign it may
    settle is submission_unknown or exists_unresolved (_may_settle_a_campaign),
    which is tried every 5 minutes until PayPal answers or its body is purged.

    Each outcome is written in one transaction with its effects and an audit row.
    Returns ran False, reading nothing, when another run holds the lock.

    After a pass releases the lock, if a delivery this call has not tried is still
    without an outcome and not resting (one stored while the lock was held, whose
    own nudge found the lock taken and returned ran False), the call takes the lock
    again and runs another pass: at most 3 passes and limit deliveries in all. A
    delivery this call already tried is left for a later call. Raises ValueError
    for a limit that is not a whole number from 1 to 500.
    """
    if type(limit) is not int or not 1 <= limit <= MAX_LIMIT:
        raise ValueError(f"limit must be a whole number from 1 to {MAX_LIMIT}")
    outcomes: Counter[str] = Counter()
    retrying = 0
    passes = 0
    tried: list[str] = []
    while passes < MAX_PASSES and len(tried) < limit:
        if not conn.execute("select pg_try_advisory_lock(%s)", (EVENT_LOCK,)).fetchone()[0]:
            break
        passes += 1
        try:
            rows = conn.execute(
                "select e.transmission_id, e.event_type, e.raw from paypal_events e "
                "where not exists (select 1 from event_outcomes o where o.transmission_id = e.transmission_id) "
                "and e.transmission_id <> all(%(tried)s::text[]) and not " + _RESTING_SQL + " "
                "order by e.received_at, e.transmission_id limit %(most)s",
                {"tried": tried, "rest": RETRY_AFTER, "most": limit - len(tried)},
            ).fetchall()
            for transmission_id, event_type, raw in rows:
                tried.append(transmission_id)
                try:
                    result = _handle(conn, http, transmission_id, event_type, raw)
                except _AlreadyDecided:
                    continue
                if isinstance(result, _Retry):
                    if _note_failed_attempt(conn, transmission_id, event_type, result.detail, keep=result.keep):
                        outcomes["gave up"] += 1
                    else:
                        retrying += 1
                else:
                    outcomes[result] += 1
        finally:
            conn.execute("select pg_advisory_unlock(%s)", (EVENT_LOCK,))
        # Asked only once the lock is free, so a delivery whose nudge was turned away
        # while this pass held it is already stored and visible here.
        if not _untried_waiting(conn, tried):
            break
    if passes == 0:
        return ProcessReport(ran=False)
    return ProcessReport(ran=True, outcomes=dict(outcomes), retrying=retrying, passes=passes)


def _untried_waiting(conn: psycopg.Connection, tried: list[str]) -> bool:
    """Whether any stored delivery not in tried and not resting after a failed attempt has no outcome yet."""
    return conn.execute(
        "select exists (select 1 from paypal_events e "
        "where not exists (select 1 from event_outcomes o where o.transmission_id = e.transmission_id) "
        "and e.transmission_id <> all(%(tried)s::text[]) and not " + _RESTING_SQL + ")",
        {"tried": tried, "rest": RETRY_AFTER},
    ).fetchone()[0]


def _handle(conn: psycopg.Connection, http: PayPalHttp, transmission_id: str, event_type: str, raw: str) -> str | _Retry:
    if event_type.startswith(ITEM_PREFIX):
        handler = _item_event
    elif event_type.startswith(BATCH_PREFIX):
        handler = _batch_event
    elif event_type == CAPTURE_COMPLETED:
        handler = _capture_event
    else:
        return _decide(conn, transmission_id, event_type, "ignored", {})
    event = _parse(raw)
    # The stored type was copied from this same body; if they disagree, neither is trusted.
    if event is None or event.get("event_type") != event_type:
        return _decide(conn, transmission_id, event_type, "malformed", {"reason": "the stored body is not this event"})
    return handler(conn, http, transmission_id, event_type, event)


def _item_event(conn: psycopg.Connection, http: PayPalHttp, transmission_id: str, event_type: str, event: dict) -> str | _Retry:
    item_id = _dig(event, "resource", "payout_item_id")
    if not _matches(_PAYOUT_ID, item_id):
        return _decide(conn, transmission_id, event_type, "malformed", {"reason": "the event names no payout item"})
    try:
        item = get_item(http, item_id)
    except PayPalError as exc:
        return _Retry({"payout_item_id": item_id, **_error_detail(exc)})
    detail: dict = {"payout_item_id": item_id}
    payout_batch_id = item.get("payout_batch_id")
    sender_batch_id = item.get("sender_batch_id")
    if item.get("payout_item_id") != item_id:
        return _decide(conn, transmission_id, event_type, "not ours", {**detail, "reason": "PayPal's answer is for another item"})
    if not _matches(_PAYOUT_ID, payout_batch_id) or not _matches(_SENDER_BATCH_ID, sender_batch_id):
        return _decide(conn, transmission_id, event_type, "not ours", {**detail, "reason": "PayPal's answer names no batch"})
    detail.update(payout_batch_id=payout_batch_id, sender_batch_id=sender_batch_id)
    ledger = conn.execute(
        "select payout_batch_id from payout_batches where sender_batch_id = %s", (sender_batch_id,)
    ).fetchone()
    if ledger is None:
        return _decide(conn, transmission_id, event_type, "not ours", {**detail, "reason": "the batch is not in our ledger"})
    batch_status = None
    if ledger[0] is None:
        # The item names a batch id the ledger lacks. PayPal's own batch answer, not the
        # item's, decides whether that batch is the one we sent.
        try:
            batch = get_batch(http, payout_batch_id)
        except PayPalError as exc:
            return _Retry({**detail, **_error_detail(exc)})
        named, batch_status = batch_header(batch)
        if named != (payout_batch_id, sender_batch_id):
            return _decide(
                conn, transmission_id, event_type, "not ours", {**detail, "reason": "PayPal's batch does not carry this item's sender_batch_id"}
            )
    elif ledger[0] != payout_batch_id:
        return _decide(
            conn, transmission_id, event_type, "not ours", {**detail, "reason": "PayPal's batch is not the one in our ledger"}
        )
    sender_item_id = _dig(item, "payout_item", "sender_item_id")
    if not _matches(_SENDER_ITEM_ID, sender_item_id):
        return _decide(conn, transmission_id, event_type, "malformed", {**detail, "reason": "PayPal's answer has no sender_item_id"})
    seen = as_seen(item.get("transaction_status"))
    detail.update(sender_item_id=sender_item_id, seen=seen)

    def apply() -> tuple[str, dict]:
        extra: dict = {}
        if batch_status is not None:
            known = conn.execute(
                "select payout_batch_id from payout_batches where sender_batch_id = %s for update", (sender_batch_id,)
            ).fetchone()[0]
            if known is not None and known != payout_batch_id:
                return "not ours", {"reason": "PayPal's batch is not the one in our ledger"}
            if known is None:
                resolution, found = _resolve_batch(conn, sender_batch_id, payout_batch_id)
                if resolution != "batch resolved":
                    return "status refused", {**found, "reason": "the ledger has no payout_batch_id and the campaign is not waiting on one"}
                extra["resolved_from"] = found["from"]
        try:
            change = record_item_status(
                conn,
                payout_item_id=item_id,
                sender_batch_id=sender_batch_id,
                sender_item_id=sender_item_id,
                seen=seen,
                fee_minor=_fee_minor(item.get("payout_item_fee")),
            )
        except ItemConflict:
            return "status refused", {**extra, "reason": "the item is stored under another batch"}
        extra.update({"decision": change.decision, "from": change.previous, "to": change.stored})
        if batch_status == DENIED:
            extra["items_failed"] = record_denied_batch(conn, sender_batch_id)
        if change.decision == "refused":
            return "status refused", {**extra, "reason": "the state machine does not allow this move"}
        return "status recorded", extra

    return _decide_with(conn, transmission_id, event_type, detail, apply)


def _batch_event(conn: psycopg.Connection, http: PayPalHttp, transmission_id: str, event_type: str, event: dict) -> str | _Retry:
    payout_batch_id = _dig(event, "resource", "batch_header", "payout_batch_id")
    if not _matches(_PAYOUT_ID, payout_batch_id):
        return _decide(conn, transmission_id, event_type, "malformed", {"reason": "the event names no payout batch"})
    try:
        batch = get_batch(http, payout_batch_id)
    except PayPalError as exc:
        named_sender = _dig(event, "resource", "batch_header", "sender_batch_header", "sender_batch_id")
        keep = _may_settle_a_campaign(conn, payout_batch_id, named_sender)
        return _Retry({"payout_batch_id": payout_batch_id, **_error_detail(exc)}, keep=keep)
    detail: dict = {"payout_batch_id": payout_batch_id}
    if _dig(batch, "batch_header", "payout_batch_id") != payout_batch_id:
        return _decide(conn, transmission_id, event_type, "not ours", {**detail, "reason": "PayPal's answer is for another batch"})
    (_, sender_batch_id), batch_status = batch_header(batch)
    if not _matches(_SENDER_BATCH_ID, sender_batch_id):
        return _decide(conn, transmission_id, event_type, "not ours", {**detail, "reason": "PayPal's answer names no sender_batch_id"})
    detail.update(sender_batch_id=sender_batch_id, batch_status=batch_status)
    if conn.execute("select 1 from payout_batches where sender_batch_id = %s", (sender_batch_id,)).fetchone() is None:
        return _decide(conn, transmission_id, event_type, "not ours", {**detail, "reason": "the batch is not in our ledger"})

    def apply() -> tuple[str, dict]:
        known = conn.execute(
            "select payout_batch_id from payout_batches where sender_batch_id = %s for update", (sender_batch_id,)
        ).fetchone()[0]
        if known is not None and known != payout_batch_id:
            return "batch unchanged", {"reason": "the ledger holds a different payout_batch_id"}
        outcome, extra = _resolve_batch(conn, sender_batch_id, payout_batch_id)
        if batch_status == DENIED:
            return "batch denied", {**extra, "items_failed": record_denied_batch(conn, sender_batch_id)}
        return outcome, extra

    return _decide_with(conn, transmission_id, event_type, detail, apply)


def batch_header(batch: object) -> tuple[tuple[object, object], str]:
    """((payout_batch_id, sender_batch_id), batch_status as as_seen() stores it) from PayPal's answer for a batch."""
    header = _dig(batch, "batch_header")
    named = (_dig(header, "payout_batch_id"), _dig(header, "sender_batch_header", "sender_batch_id"))
    return named, as_seen(_dig(header, "batch_status"))


def _resolve_batch(conn: psycopg.Connection, sender_batch_id: str, payout_batch_id: str) -> tuple[str, dict]:
    """Record PayPal's payout_batch_id for our sender_batch_id and settle a campaign waiting on it.

    The caller holds the ledger row locked and has checked that it holds no other
    payout_batch_id. Only a campaign in RESOLVABLE is touched: its ledger row takes
    the id (status resolved_by_event), it moves to submitted and one
    "batch_resolved_by_event" audit row is written ("batch resolved"). Any other
    campaign is left as it is ("batch unchanged"). Runs inside the caller's transaction.
    """
    campaign_text = conn.execute("select campaign_id from payout_batches where sender_batch_id = %s", (sender_batch_id,)).fetchone()[0]
    campaign_id = _uuid_or_none(campaign_text)
    status = None
    if campaign_id is not None:
        row = conn.execute("select status from campaigns where campaign_id = %s for update", (campaign_id,)).fetchone()
        status = row[0] if row else None
    if status not in RESOLVABLE:
        return "batch unchanged", {"campaign_id": campaign_text, "campaign_status": status, "reason": "nothing to resolve"}
    conn.execute(
        "update payout_batches set payout_batch_id = %s, status = %s where sender_batch_id = %s",
        (payout_batch_id, RESOLVED_LEDGER_STATUS, sender_batch_id),
    )
    conn.execute("update campaigns set status = 'submitted' where campaign_id = %s", (campaign_id,))
    _audit(
        conn,
        "batch_resolved_by_event",
        {"campaign_id": str(campaign_id), "sender_batch_id": sender_batch_id, "payout_batch_id": payout_batch_id, "from": status},
    )
    return "batch resolved", {"campaign_id": str(campaign_id), "from": status}


def record_denied_batch(conn: psycopg.Connection, sender_batch_id: str) -> int:
    """Record every item of a batch PayPal answered DENIED as FAILED, so no cap or result counts money that never left (C4, C10).

    The caller has read the batch from PayPal under the payout_batch_id the ledger
    holds or has just confirmed. Acts only on a batch the ledger holds for a
    campaign whose frozen snapshot passes its checks and gives this same
    sender_batch_id. Each snapshot item with a payout_items row of this batch is
    moved to FAILED through record_item_status, so an item already in a final
    status keeps it; an item with no row gets one, under DENIED_ITEM_ID, which no
    PayPal call accepts, so it is never read back or cancelled. Runs inside the
    caller's transaction. Returns how many snapshot items hold FAILED afterwards,
    0 when it acted on nothing.
    """
    row = conn.execute("select campaign_id from payout_batches where sender_batch_id = %s", (sender_batch_id,)).fetchone()
    campaign_id = _uuid_or_none(row[0]) if row else None
    if campaign_id is None:
        return 0
    try:
        snap = frozen_snapshot(conn, campaign_id)
    except SnapshotRefused:
        return 0
    if snap is None or sender_batch_id_for(snap) != sender_batch_id:
        return 0
    held: dict[str, list[str]] = {}
    for payout_item_id, sender_item_id in conn.execute(
        "select payout_item_id, sender_item_id from payout_items where sender_batch_id = %s order by payout_item_id", (sender_batch_id,)
    ):
        held.setdefault(sender_item_id, []).append(payout_item_id)
    failed = 0
    for item in snap.items:
        ids = held.get(item.sender_item_id) or [DENIED_ITEM_ID.format(sender_batch_id=sender_batch_id, sender_item_id=item.sender_item_id)]
        stored = [
            record_item_status(
                conn, payout_item_id=payout_item_id, sender_batch_id=sender_batch_id,
                sender_item_id=item.sender_item_id, seen="FAILED", fee_minor=None,
            ).stored
            for payout_item_id in ids
        ]
        failed += all(status == "FAILED" for status in stored)
    return failed


def _may_settle_a_campaign(conn: psycopg.Connection, payout_batch_id: str, named_sender: object) -> bool:
    """Whether a batch event PayPal could not be asked about may be what an unsettled campaign is waiting on.

    Judged from the event body alone, which only ever keeps a delivery retrying and
    never changes state. The campaign is the ledger's row for the sender_batch_id
    the body names, or else for its payout_batch_id; it may settle when that
    campaign is submission_unknown or exists_unresolved. When the body names
    neither, it may be the batch of any such campaign whose ledger row still lacks a
    payout_batch_id, so it is kept while one exists.
    """
    row = None
    if _matches(_SENDER_BATCH_ID, named_sender):
        row = conn.execute("select campaign_id from payout_batches where sender_batch_id = %s", (named_sender,)).fetchone()
    if row is None:
        row = conn.execute("select campaign_id from payout_batches where payout_batch_id = %s", (payout_batch_id,)).fetchone()
    if row is not None:
        return conn.execute(
            "select exists (select 1 from campaigns where campaign_id::text = %s and status = any(%s))", (row[0], list(UNSETTLED))
        ).fetchone()[0]
    return conn.execute(
        "select exists (select 1 from payout_batches b join campaigns c on c.campaign_id::text = b.campaign_id "
        "where b.payout_batch_id is null and c.status = any(%s))",
        (list(UNSETTLED),),
    ).fetchone()[0]


def _capture_event(conn: psycopg.Connection, http: PayPalHttp, transmission_id: str, event_type: str, event: dict) -> str | _Retry:
    order_id = _dig(event, "resource", "supplementary_data", "related_ids", "order_id")
    if not _matches(_ORDER_ID, order_id):
        return _decide(conn, transmission_id, event_type, "malformed", {"reason": "the event names no order"})
    # Matched only through the order id this server stored when it made the order (C8).
    # Anyone else's order is never read, so no stranger's payer data is fetched, and its
    # id is not written down either: outcome rows outlive the 48-hour purge (C27).
    match = simulated_order_for(conn, order_id)
    if match is None:
        return _decide(conn, transmission_id, event_type, "not ours", {"reason": "not an order the simulate button created"})
    detail: dict = {"paypal_order_id": order_id, "campaign_id": str(match.campaign_id), "ref": match.ref}
    try:
        order = read_order(http, order_id)
    except PayPalError as exc:
        return _Retry({**detail, **_error_detail(exc)})
    return _decide_with(conn, transmission_id, event_type, detail, lambda: record_simulated_purchase(conn, match, order_id, order))


def record_simulated_purchase(conn: psycopg.Connection, match: SimulatedMatch, order_id: str, order: dict) -> tuple[str, dict]:
    """Attribute PayPal's answer for one simulated order: the one path the capture webhook and the refresh job both use (C8, C10).

    match is simulated_order_for's row for order_id, and order is read_order's
    answer for order_id. Attributes the purchase as simulated, through
    attribute_purchase, only when PayPal says the order and its one capture are
    COMPLETED for the custom_id this server set. Returns ("purchase recorded",
    {amount_minor, role, simulated, attribution_id}) or ("purchase refused", {reason,
    and amount_minor, role and simulated when PayPal confirmed a completed
    purchase}); every reason is a fixed text, never PayPal's. Writes the
    attributions row and its audit row inside the caller's transaction, when there is one.
    """
    reading = _completed_purchase(order, order_id, match.simulated_order_id)
    if isinstance(reading, str):
        return "purchase refused", {"reason": reading}
    purchased_at, amount_minor = reading
    result = attribute_purchase(
        conn,
        campaign_id=match.campaign_id,
        ref=match.ref,
        purchased_at=purchased_at,
        amount_minor=amount_minor,
        simulated=True,
        source_order=order_id,
    )
    extra = {"amount_minor": amount_minor, "role": result.role, "simulated": True}
    if not result.recorded:
        return "purchase refused", {**extra, "reason": result.reason}
    return "purchase recorded", {**extra, "attribution_id": result.attribution_id}


def _completed_purchase(order: dict, order_id: str, simulated_order_id: uuid.UUID) -> tuple[datetime, int] | str:
    """(purchased_at, amount_minor) from PayPal's order, or the reason it is not a completed purchase of ours."""
    if order.get("id") != order_id:
        return "PayPal's answer is for another order"
    if order.get("status") != "COMPLETED":
        return "PayPal does not say the order is COMPLETED"
    units = order.get("purchase_units")
    if not isinstance(units, list) or len(units) != 1 or not isinstance(units[0], dict):
        return "the order does not have exactly one purchase unit"
    if units[0].get("custom_id") != str(simulated_order_id):
        return "the order's custom_id is not the one this server set"
    captures = _dig(units[0], "payments", "captures")
    if not isinstance(captures, list) or len(captures) != 1 or not isinstance(captures[0], dict):
        return "the order does not have exactly one capture"
    capture = captures[0]
    if capture.get("status") != "COMPLETED":
        return "PayPal does not say the capture is COMPLETED"
    try:
        amount_minor = to_minor(_dig(capture, "amount", "value"), _dig(capture, "amount", "currency_code"))
        purchased_at = utc_time(capture.get("create_time"))
    except (MoneyError, ValueError):
        return "the capture's amount or time cannot be read"
    return purchased_at, amount_minor


def _decide(conn: psycopg.Connection, transmission_id: str, event_type: str, outcome: str, detail: dict) -> str:
    return _decide_with(conn, transmission_id, event_type, detail, lambda: (outcome, {}))


def _decide_with(conn: psycopg.Connection, transmission_id: str, event_type: str, detail: dict, apply) -> str:
    """Run apply's effects and write the one outcome row and its audit row, all in one transaction."""
    with conn.transaction():
        outcome, extra = apply()
        written = conn.execute(
            "insert into event_outcomes (transmission_id, outcome, detail) values (%s, %s, %s) "
            "on conflict (transmission_id) do nothing returning 1",
            (transmission_id, outcome, Jsonb({"event_type": event_type, **detail, **extra})),
        ).fetchone()
        if written is None:
            raise _AlreadyDecided()
        _audit(conn, "event_processed", {"transmission_id": transmission_id, "event_type": event_type, "outcome": outcome})
    return outcome


def _note_failed_attempt(conn: psycopg.Connection, transmission_id: str, event_type: str, detail: dict, *, keep: bool) -> bool:
    """Record one failed attempt; from the fifth on write "gave up" unless keep. Returns True when it gave up."""
    with conn.transaction():
        _audit(conn, "event_attempt_failed", {"transmission_id": transmission_id, "event_type": event_type, **detail})
        attempts = conn.execute(
            "select count(*) from audit_log where action = 'event_attempt_failed' and detail ->> 'transmission_id' = %s",
            (transmission_id,),
        ).fetchone()[0]
        if attempts < MAX_ATTEMPTS or keep:
            return False
        written = conn.execute(
            "insert into event_outcomes (transmission_id, outcome, detail) values (%s, 'gave up', %s) "
            "on conflict (transmission_id) do nothing returning 1",
            (transmission_id, Jsonb({"event_type": event_type, "attempts": attempts, **detail})),
        ).fetchone()
        if written is not None:
            _audit(conn, "event_processed", {"transmission_id": transmission_id, "event_type": event_type, "outcome": "gave up"})
        return written is not None


def _parse(raw: str) -> dict | None:
    def no_repeats(pairs: list) -> dict:
        keys = [key for key, _ in pairs]
        if len(keys) != len(set(keys)):
            raise ValueError("repeated key")
        return dict(pairs)

    try:
        data = json.loads(raw, object_pairs_hook=no_repeats)
    except (TypeError, ValueError, RecursionError):
        return None
    return data if isinstance(data, dict) else None


def _dig(value: object, *path: str) -> object:
    for key in path:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def _matches(pattern: re.Pattern, value: object) -> bool:
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _fee_minor(fee: object) -> int | None:
    try:
        return to_minor(_dig(fee, "value"), _dig(fee, "currency"))
    except MoneyError:
        return None


def _error_detail(exc: PayPalError) -> dict:
    # PayPal's own strings, kept only when they have the shape PayPal uses, so nothing else reaches the log.
    return {
        "status": exc.status,
        "name": exc.name if _matches(_ERROR_NAME, exc.name) else None,
        "debug_id": exc.debug_id if _matches(_DEBUG_ID, exc.debug_id) else None,
    }


def _uuid_or_none(text: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(text)
    except (TypeError, ValueError):
        return None


def _audit(conn: psycopg.Connection, action: str, detail: dict) -> None:
    conn.execute("insert into audit_log (actor, action, detail) values (%s, %s, %s)", (ACTOR, action, Jsonb(detail)))
