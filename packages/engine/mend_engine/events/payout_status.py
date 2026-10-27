"""The payout item state machine: a stored status only ever moves forward (C10).

PayPal's item statuses and where each may go next, from RD-BRIEF section 4. A
stored status may move to any status those arrows reach in one step or more, so an
answer missed in between (PENDING, then RETURNED with the UNCLAIMED never seen)
cannot strand an item. The arrows hold no loop, so no move ever leads back.
FAILED, BLOCKED, RETURNED, REFUNDED and REVERSED are final. A status PayPal sends
that is not one of these is stored as seen but counts as PENDING for every
decision, so it can never stand in for SUCCESS, and a stale or reordered answer can
never undo a final one.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

import psycopg

PENDING = "PENDING"
# A status that is not a plain upper-case word is stored as this, never as PayPal's text.
UNREADABLE = "UNKNOWN"

_NEXT: dict[str, frozenset[str]] = {
    "PENDING": frozenset({"SUCCESS", "UNCLAIMED", "FAILED", "ONHOLD", "BLOCKED"}),
    "ONHOLD": frozenset({"SUCCESS", "UNCLAIMED", "FAILED", "BLOCKED"}),
    "UNCLAIMED": frozenset({"SUCCESS", "RETURNED"}),
    # REVERSED is in PayPal's item status list. The brief says PayPal documents it
    # only for web uploads, so it is taken as a final money-back state after SUCCESS.
    "SUCCESS": frozenset({"REFUNDED", "REVERSED"}),
    "FAILED": frozenset(),
    "BLOCKED": frozenset(),
    "RETURNED": frozenset(),
    "REFUNDED": frozenset(),
    "REVERSED": frozenset(),
}
KNOWN_STATUSES = frozenset(_NEXT)
FINAL_STATUSES = frozenset(status for status, onward in _NEXT.items() if not onward)


def _reachable(start: str) -> frozenset[str]:
    found: set[str] = set()
    todo = list(_NEXT[start])
    while todo:
        status = todo.pop()
        if status not in found:
            found.add(status)
            todo.extend(_NEXT[status])
    return frozenset(found)


_REACHABLE: dict[str, frozenset[str]] = {status: _reachable(status) for status in _NEXT}

_STATUS_SHAPE = re.compile(r"[A-Z][A-Z_]{0,35}", re.ASCII)

Decision = Literal["new", "moved", "unchanged", "refused"]


@dataclass(frozen=True)
class ItemChange:
    """What happened to one payout item's stored status.

    decision is "new" (first sighting), "moved" (forward along the machine),
    "unchanged" (the same state, perhaps a refreshed fee or the text of an unknown
    status) or "refused" (a move the machine does not allow: nothing was written).
    previous is the stored status before, stored the status after.
    """

    decision: Decision
    previous: str | None
    stored: str | None


class ItemConflict(ValueError):
    """The item id is already in the ledger under another batch. Nothing was written."""


def as_seen(raw: object) -> str:
    """PayPal's status text as it will be stored: the text itself if it is a plain upper-case word, else UNKNOWN."""
    if isinstance(raw, str) and _STATUS_SHAPE.fullmatch(raw):
        return raw
    return UNREADABLE


def effective(status: str | None) -> str:
    """The status every decision uses: a known status as is, anything else (unknown, unreadable, none) PENDING."""
    return status if status in KNOWN_STATUSES else PENDING


def decide(previous: str | None, seen: str) -> Decision:
    """Whether a stored status previous may become seen. previous None means the item is new.

    "moved" when the arrows reach seen from previous in one step or more; never
    backwards and never out of a final status.
    """
    if previous is None:
        return "new"
    before, after = effective(previous), effective(seen)
    if before == after:
        return "unchanged"
    if after in _REACHABLE[before]:
        return "moved"
    return "refused"


def record_item_status(
    conn: psycopg.Connection,
    *,
    payout_item_id: str,
    sender_batch_id: str,
    sender_item_id: str,
    seen: str,
    fee_minor: int | None,
) -> ItemChange:
    """Store PayPal's answer for one payout item, moving its status only forward.

    Locks the item's payout_items row, then: inserts it when new; updates status
    and fee when decide() says "moved" or "unchanged" (a missing fee keeps the one
    stored); writes nothing when it says "refused". Runs as one transaction, or a
    savepoint inside the caller's. seen must already be as_seen() text.

    Raises ItemConflict when the item id is stored under a different
    sender_batch_id, ValueError when seen is not as_seen() text or fee_minor is
    not None or whole cents from 0 up.
    """
    if as_seen(seen) != seen:
        raise ValueError("seen must be a status as_seen() returns")
    if fee_minor is not None and (type(fee_minor) is not int or fee_minor < 0):
        raise ValueError("fee_minor must be None or whole cents from 0 up")
    with conn.transaction():
        row = conn.execute(
            "select status, sender_batch_id from payout_items where payout_item_id = %s for update", (payout_item_id,)
        ).fetchone()
        if row is None:
            inserted = conn.execute(
                "insert into payout_items (payout_item_id, sender_batch_id, sender_item_id, status, fee_minor) "
                "values (%s, %s, %s, %s, %s) on conflict (payout_item_id) do nothing returning 1",
                (payout_item_id, sender_batch_id, sender_item_id, seen, fee_minor),
            ).fetchone()
            if inserted is not None:
                return ItemChange("new", None, seen)
            # Another writer inserted it a moment ago; decide against what it stored.
            row = conn.execute(
                "select status, sender_batch_id from payout_items where payout_item_id = %s for update", (payout_item_id,)
            ).fetchone()
        previous, stored_batch = row
        if stored_batch != sender_batch_id:
            raise ItemConflict("the payout item is stored under another batch")
        decision = decide(previous, seen)
        if decision == "refused":
            return ItemChange("refused", previous, previous)
        conn.execute(
            "update payout_items set status = %s, fee_minor = coalesce(%s, fee_minor), updated_at = now() "
            "where payout_item_id = %s",
            (seen, fee_minor, payout_item_id),
        )
        return ItemChange(decision, previous, seen)
