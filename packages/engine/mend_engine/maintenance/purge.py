"""The 48-hour purge of raw PayPal data (C27, PayPal Developer Agreement 10.1.3a).

paypal_events is the only table that holds raw PayPal payloads: the web app's
webhook receiver stores each verified delivery there with purge_after set to 48
hours after receipt. Mend's own ledger of what it sent (payout_batches,
payout_items) is not PayPal transaction history and stays.

The same run also clears run_owners rows older than 24 hours (C20): each is one
answered engine run a console session may still poll, so without this the table
would grow with every visitor for as long as the demo runs.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import psycopg
from psycopg.types.json import Jsonb

ACTOR = "purge"
RUN_OWNERS_KEPT = timedelta(hours=24)
_INSERT_AUDIT = "insert into audit_log (actor, action, detail) values (%s, %s, %s)"


def purge_paypal_events(conn: psycopg.Connection, now: datetime | None = None) -> int:
    """Delete every paypal_events row whose purge_after is before now and return how many went.

    In the same transaction, deletes every run_owners row created more than 24
    hours before now. now defaults to the database's clock, the clock that set
    purge_after and created_at. Writes one "paypal_events_purged" and one
    "run_owners_purged" audit_log row with each count, even when it is 0, so every
    run is on record. Raises ValueError for a now without a time zone.
    """
    if now is not None and (not isinstance(now, datetime) or now.utcoffset() is None):
        raise ValueError("now must be a datetime with a time zone")
    with conn.transaction():
        if now is None:
            now = conn.execute("select now()").fetchone()[0]
        deleted = conn.execute("delete from paypal_events where purge_after < %s", (now,)).rowcount
        conn.execute(_INSERT_AUDIT, (ACTOR, "paypal_events_purged", Jsonb({"deleted": deleted})))
        runs = conn.execute("delete from run_owners where created_at < %s", (now - RUN_OWNERS_KEPT,)).rowcount
        conn.execute(_INSERT_AUDIT, (ACTOR, "run_owners_purged", Jsonb({"deleted": runs})))
    return deleted
