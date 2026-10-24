"""Linking a purchase to the campaign that rewarded or held back its buyer (C8).

One function, attribute_purchase, serves rewarded and held-back members alike, so
neither arm can be counted by different rules. A purchase counts only inside the
window: from the campaign's first move to submitted, as the status guard recorded
it, for 30 days. Times are compared in UTC after one parser. A simulated purchase
is matched only through the order id the simulate button stored when it made the
order (simulated_order_for), never through any field a buyer can set.

Not covered: real purchases. The demo shop has no live storefront, so nothing
calls attribute_purchase with simulated=False yet; a production shop would match
its own order record to the member first.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import psycopg
from psycopg.types.json import Jsonb

from mend_engine.money import MoneyError, to_decimal_string

WINDOW = timedelta(days=30)
ACTOR = "attribution"

_REF = re.compile(r"R[1-9][0-9]{0,3}", re.ASCII)
_SOURCE_ORDER = re.compile(r"[A-Za-z0-9_.:-]{1,64}", re.ASCII)
_MAX_TIME_CHARS = 40


@dataclass(frozen=True)
class SimulatedMatch:
    simulated_order_id: uuid.UUID
    campaign_id: uuid.UUID
    ref: str


@dataclass(frozen=True)
class AttributionResult:
    """recorded is False with a plain reason when the purchase was not attributed. role is the buyer's arm, if known."""

    recorded: bool
    reason: str | None
    role: str | None
    attribution_id: int | None


def utc_time(text: object) -> datetime:
    """The one timestamp parser: an ISO 8601 date and time with a zone, such as PayPal's "2026-10-20T07:03:44Z", in UTC.

    Raises ValueError for anything else, including a time with no zone.
    """
    if type(text) is not str or not 0 < len(text) <= _MAX_TIME_CHARS or "T" not in text:
        raise ValueError("not an ISO 8601 date and time")
    parsed = datetime.fromisoformat(text)
    if parsed.utcoffset() is None:
        raise ValueError("the time has no zone")
    return parsed.astimezone(timezone.utc)


def submitted_at(conn: psycopg.Connection, campaign_id: uuid.UUID) -> datetime | None:
    """When the campaign first reached submitted, from the status guard's record, or None if it never has."""
    _check_id(campaign_id)
    return conn.execute(
        "select min(moved_at) from campaign_status_moves where campaign_id = %s and to_status = 'submitted'",
        (campaign_id,),
    ).fetchone()[0]


def attribution_window(conn: psycopg.Connection, campaign_id: uuid.UUID) -> tuple[datetime, datetime] | None:
    """(start, end) in UTC: a purchase at start counts, one at end does not. None if the campaign was never sent."""
    start = submitted_at(conn, campaign_id)
    if start is None:
        return None
    start = start.astimezone(timezone.utc)
    return start, start + WINDOW


def simulated_order_for(conn: psycopg.Connection, paypal_order_id: str) -> SimulatedMatch | None:
    """The simulated order this server stored under PayPal's order id, or None for any other order."""
    if type(paypal_order_id) is not str or not paypal_order_id:
        return None
    row = conn.execute(
        "select simulated_order_id, campaign_id, ref from simulated_orders where paypal_order_id = %s", (paypal_order_id,)
    ).fetchone()
    return SimulatedMatch(*row) if row else None


def attribute_purchase(
    conn: psycopg.Connection,
    *,
    campaign_id: uuid.UUID,
    ref: str,
    purchased_at: datetime,
    amount_minor: int,
    simulated: bool,
    source_order: str,
) -> AttributionResult:
    """Record one purchase by the campaign member ref, once, if it falls in the campaign's window.

    In one transaction (a savepoint inside the caller's): the campaign must have
    reached submitted, ref must be one of its members (rewarded or held back), and
    purchased_at must be at or after the first move to submitted and before 30
    days later. Then one attributions row is written with the member's role, and
    an audit row. A source_order already attributed writes nothing.

    Returns recorded False with the reason for: a campaign never sent, a ref not
    in it, a time outside the window, a purchase already attributed. Raises
    ValueError for a campaign_id that is not a UUID, a malformed ref or
    source_order, a time with no zone, a non-bool simulated, or an amount that is
    not whole cents from 1 up within what money.to_decimal_string accepts.
    """
    _check_id(campaign_id)
    if type(ref) is not str or not _REF.fullmatch(ref):
        raise ValueError("ref must look like R1")
    if type(source_order) is not str or not _SOURCE_ORDER.fullmatch(source_order):
        raise ValueError("source_order is malformed")
    if not isinstance(purchased_at, datetime) or purchased_at.utcoffset() is None:
        raise ValueError("purchased_at must be a datetime with a zone")
    if type(simulated) is not bool:
        raise ValueError("simulated must be true or false")
    try:
        to_decimal_string(amount_minor)
    except MoneyError:
        raise ValueError("amount_minor must be whole cents from 1 up") from None
    when = purchased_at.astimezone(timezone.utc)

    with conn.transaction():
        window = attribution_window(conn, campaign_id)
        if window is None:
            return AttributionResult(False, "the campaign was never sent", None, None)
        member = conn.execute(
            "select role from campaign_members where campaign_id = %s and ref = %s", (campaign_id, ref)
        ).fetchone()
        if member is None:
            return AttributionResult(False, "the buyer is not a member of this campaign", None, None)
        role = member[0]
        start, end = window
        if not start <= when < end:
            return AttributionResult(False, "the purchase is outside the 30-day window", role, None)
        row = conn.execute(
            "insert into attributions (campaign_id, ref, role, purchased_at, amount_minor, simulated, source_order) "
            "values (%s, %s, %s, %s, %s, %s, %s) on conflict (source_order) do nothing returning attribution_id",
            (campaign_id, ref, role, when, amount_minor, simulated, source_order),
        ).fetchone()
        if row is None:
            return AttributionResult(False, "the purchase is already attributed", role, None)
        conn.execute(
            "insert into audit_log (actor, action, detail) values (%s, %s, %s)",
            (
                ACTOR,
                "purchase_attributed",
                Jsonb(
                    {
                        "campaign_id": str(campaign_id),
                        "ref": ref,
                        "role": role,
                        "simulated": simulated,
                        "amount_minor": amount_minor,
                        "source_order": source_order,
                        "attribution_id": row[0],
                    }
                ),
            ),
        )
    return AttributionResult(True, None, role, row[0])


def _check_id(campaign_id: object) -> None:
    if not isinstance(campaign_id, uuid.UUID):
        raise ValueError("campaign_id must be a UUID")
