"""Sending an approved campaign as exactly one Payouts batch (C3).

submit() claims the campaign with one conditional update, approved to submitting,
so of any number of concurrent or repeated calls exactly one goes on to call
PayPal. The batch is built from the frozen approved snapshot alone. Its
sender_batch_id is derived from that snapshot, so a campaign has only ever one,
and PayPal refuses a repeat of it for 30 days. The ledger row is written before
PayPal is called, so a crash part way leaves a record to reconcile, never a gap.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

import psycopg
from psycopg.types.json import Jsonb

from mend_engine.campaigns.approval import frozen_snapshot
from mend_engine.campaigns.spend import CapExceeded, check_daily_cap, database_now, lock_daily_cap
from mend_engine.config import Config
from mend_engine.paypal.http import PayPalError, PayPalHttp
from mend_engine.paypal.payouts import (
    BatchExistsUnresolved,
    BatchSnapshot,
    SnapshotRefused,
    SubmissionUnknown,
    sender_batch_id_for,
    snapshot_hash,
    submit_batch,
    validate_snapshot,
)

ACTOR = "engine"
REFUSED_REASON = "PayPal refused the batch"
_INSERT_AUDIT = "insert into audit_log (actor, action, detail) values (%s, %s, %s)"


@dataclass(frozen=True)
class SubmissionResult:
    """sent is True only for the one call that sent the batch to PayPal.

    sender_batch_id is empty when the campaign was never approved, so it has none.
    """

    campaign_id: uuid.UUID
    status: str
    payout_batch_id: str | None
    sender_batch_id: str
    sent: bool


def submit(conn: psycopg.Connection, http: PayPalHttp, campaign_id: uuid.UUID, config: Config) -> SubmissionResult:
    """Send an approved campaign as one Payouts batch, at most once however often it is called.

    Reads the frozen snapshot and checks it against its hash and the payout rules.
    Then, in one transaction under the daily-cap lock: moves the campaign from
    approved to submitting with one conditional update, re-checks the rolling daily
    cap, writes the payout_batches ledger row (status submitting) and an audit row.
    Only then calls payouts.submit_batch, passing the payout_batch_id the ledger
    already holds for this sender_batch_id, if any. Records the answer: created or
    already existed moves the campaign to submitted with PayPal's payout_batch_id;
    BatchExistsUnresolved to exists_unresolved; SubmissionUnknown, or a PayPal error
    with no status or a 5xx, to submission_unknown; a 4xx refusal from PayPal to
    voided ("PayPal refused the batch"), since nothing was created. A new
    sender_batch_id is never made.

    When the conditional update changes nothing (the campaign was never approved,
    is already claimed or sent, or was voided) nothing is sent and the current
    state comes back with sent False.

    Raises CapExceeded, with nothing changed but an audit row, when the batch would
    pass the daily cap; SnapshotRefused, with nothing changed, when the frozen
    snapshot fails its hash or a payout rule; LookupError for no such campaign;
    ValueError for a campaign_id that is not a UUID. Any other error after the
    claim marks the campaign submission_unknown and is raised again.
    """
    if not isinstance(campaign_id, uuid.UUID):
        raise ValueError("campaign_id must be a UUID")
    snap = frozen_snapshot(conn, campaign_id)
    if snap is None:
        return _current(conn, campaign_id, "")
    validate_snapshot(snap, config)
    sender_batch_id = sender_batch_id_for(snap)
    total = sum(item.amount_minor for item in snap.items)

    try:
        with conn.transaction():
            lock_daily_cap(conn)
            claimed = conn.execute(
                "update campaigns set status = 'submitting' where campaign_id = %s and status = 'approved' returning 1",
                (campaign_id,),
            ).fetchone()
            if claimed is None:
                known = None
            else:
                in_ledger = conn.execute(
                    "select 1 from payout_batches where sender_batch_id = %s", (sender_batch_id,)
                ).fetchone()
                # A batch already in the ledger was counted when it was first claimed.
                check_daily_cap(conn, config, 0 if in_ledger else total, database_now(conn))
                conn.execute(
                    "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, status) "
                    "values (%s, %s, %s, 'submitting') on conflict (sender_batch_id) do nothing",
                    (sender_batch_id, str(campaign_id), snapshot_hash(snap)),
                )
                known = conn.execute(
                    "select payout_batch_id from payout_batches where sender_batch_id = %s", (sender_batch_id,)
                ).fetchone()[0]
                _audit(conn, "payout_submitting", campaign_id, sender_batch_id, items=len(snap.items), total_minor=total)
    except CapExceeded:
        with conn.transaction():
            _audit(conn, "payout_refused_daily_cap", campaign_id, sender_batch_id, total_minor=total)
        raise
    if claimed is None:
        return _current(conn, campaign_id, sender_batch_id)
    return send_claimed(conn, http, campaign_id, snap, sender_batch_id, known)


def send_claimed(
    conn: psycopg.Connection,
    http: PayPalHttp,
    campaign_id: uuid.UUID,
    snap: BatchSnapshot,
    sender_batch_id: str,
    known_payout_batch_id: str | None,
) -> SubmissionResult:
    """Send a campaign the caller has just claimed (moved to submitting), and record PayPal's answer.

    The one send-and-settle step submit() and reconcile share, so both read
    PayPal's answer by the same rules. snap must be the campaign's frozen snapshot,
    sender_batch_id its sender_batch_id_for(), and known_payout_batch_id what the
    ledger holds for it. Calls payouts.submit_batch, then in one transaction updates
    the ledger, moves the campaign out of submitting and writes an audit row:
    created or already existed to submitted; BatchExistsUnresolved to
    exists_unresolved; SubmissionUnknown, or a PayPal error with no status or a 5xx,
    to submission_unknown; a 4xx refusal or a snapshot the payout rules refuse to
    voided (ledger status refused). Any other error marks the campaign
    submission_unknown and is raised again.
    """
    try:
        result = submit_batch(http, snap, known_payout_batch_id=known_payout_batch_id)
    except BatchExistsUnresolved as exc:
        return _settle(conn, campaign_id, sender_batch_id, "exists_unresolved", None, _error_detail(exc))
    except SubmissionUnknown as exc:
        return _settle(conn, campaign_id, sender_batch_id, "submission_unknown", None, _error_detail(exc))
    except PayPalError as exc:
        detail = {"status": exc.status, "name": exc.name, "debug_id": exc.debug_id}
        if exc.status is None or exc.status >= 500:
            return _settle(conn, campaign_id, sender_batch_id, "submission_unknown", None, detail)
        return _settle(conn, campaign_id, sender_batch_id, "voided", None, detail, ledger_status="refused")
    except SnapshotRefused as exc:
        return _settle(
            conn, campaign_id, sender_batch_id, "voided", None, {"rule": str(exc)}, ledger_status="refused", sent=False
        )
    except Exception:
        _settle(conn, campaign_id, sender_batch_id, "submission_unknown", None, {"reason": "unexpected error"})
        raise
    return _settle(
        conn, campaign_id, sender_batch_id, "submitted", result.payout_batch_id, {"outcome": result.outcome},
        ledger_status=result.outcome,
    )


def _settle(
    conn: psycopg.Connection,
    campaign_id: uuid.UUID,
    sender_batch_id: str,
    status: str,
    payout_batch_id: str | None,
    detail: dict,
    *,
    ledger_status: str | None = None,
    sent: bool = True,
) -> SubmissionResult:
    with conn.transaction():
        conn.execute(
            "update payout_batches set status = %s, payout_batch_id = coalesce(%s, payout_batch_id) where sender_batch_id = %s",
            (ledger_status or status, payout_batch_id, sender_batch_id),
        )
        conn.execute(
            "update campaigns set status = %s, void_reason = %s where campaign_id = %s and status = 'submitting'",
            (status, REFUSED_REASON if status == "voided" else None, campaign_id),
        )
        _audit(conn, f"payout_{status}", campaign_id, sender_batch_id, payout_batch_id=payout_batch_id, **detail)
    return SubmissionResult(campaign_id, status, payout_batch_id, sender_batch_id, sent)


def _current(conn: psycopg.Connection, campaign_id: uuid.UUID, sender_batch_id: str) -> SubmissionResult:
    row = conn.execute("select status from campaigns where campaign_id = %s", (campaign_id,)).fetchone()
    if row is None:
        raise LookupError("no such campaign")
    ledger = conn.execute(
        "select payout_batch_id from payout_batches where sender_batch_id = %s", (sender_batch_id,)
    ).fetchone()
    return SubmissionResult(campaign_id, row[0], ledger[0] if ledger else None, sender_batch_id, False)


def _error_detail(exc: SubmissionUnknown) -> dict:
    return {"reason": exc.reason, "status": exc.status, "name": exc.name, "debug_id": exc.debug_id}


def _audit(conn: psycopg.Connection, action: str, campaign_id: uuid.UUID, sender_batch_id: str, **detail: object) -> None:
    conn.execute(
        _INSERT_AUDIT,
        (ACTOR, action, Jsonb({"campaign_id": str(campaign_id), "sender_batch_id": sender_batch_id, **detail})),
    )
