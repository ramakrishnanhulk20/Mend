"""The 48-hour purge of raw PayPal data (C27, PayPal Developer Agreement 10.1.3a).

paypal_events is the only table that holds raw PayPal payloads: the web app's
webhook receiver stores each verified delivery there with purge_after set to 48
hours after receipt. Mend's own ledger of what it sent (payout_batches,
payout_items) is not PayPal transaction history and stays.
"""

from __future__ import annotations

from datetime import datetime

import psycopg
from psycopg.types.json import Jsonb

ACTOR = "purge"


def purge_paypal_events(conn: psycopg.Connection, now: datetime | None = None) -> int:
    """Delete every paypal_events row whose purge_after is before now and return how many went.

    now defaults to the database's clock, the clock that set purge_after. Writes one
    audit_log row with the count in the same transaction, even when it is 0, so
    every run is on record. Raises ValueError for a now without a time zone.
    """
    if now is not None and (not isinstance(now, datetime) or now.utcoffset() is None):
        raise ValueError("now must be a datetime with a time zone")
    with conn.transaction():
        if now is None:
            cursor = conn.execute("delete from paypal_events where purge_after < now()")
        else:
            cursor = conn.execute("delete from paypal_events where purge_after < %s", (now,))
        deleted = cursor.rowcount
        conn.execute(
            "insert into audit_log (actor, action, detail) values (%s, %s, %s)",
            (ACTOR, "paypal_events_purged", Jsonb({"deleted": deleted})),
        )
    return deleted
