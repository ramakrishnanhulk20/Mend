"""Settling campaigns whose batch outcome is unknown, without ever sending a second batch (C3).

A campaign left in submitting for more than 10 minutes was abandoned by its
sender (submit_batch gives up well inside a minute), so it is marked
submission_unknown. Each submission_unknown campaign is then claimed again with
one conditional update and sent through submission.send_claimed, the step
submit() itself uses: the same frozen snapshot, so the same sender_batch_id, and
the payout_batch_id the ledger already holds. PayPal refuses a repeated
sender_batch_id for 30 days, so this either creates the batch that never arrived
or finds the one that did. A new sender_batch_id is never made. exists_unresolved
campaigns wait for the PAYOUTSBATCH webhook, which carries the batch's id. One
lock keeps two runs from overlapping (C20), and every step is in the audit log (C23).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import timedelta

import psycopg
from psycopg.types.json import Jsonb

from mend_engine.campaigns.approval import frozen_snapshot
from mend_engine.campaigns.submission import send_claimed
from mend_engine.paypal.http import PayPalHttp
from mend_engine.paypal.payouts import SnapshotRefused, sender_batch_id_for, validate_snapshot

STUCK_AFTER = timedelta(minutes=10)
RECONCILE_LOCK = 7731300003
ACTOR = "reconcile"
_INSERT_AUDIT = "insert into audit_log (actor, action, detail) values (%s, %s, %s)"


@dataclass(frozen=True)
class ReconcileAction:
    """One campaign looked at. sent is True when a Payouts request went out; reason says why one was skipped."""

    campaign_id: uuid.UUID
    before: str
    after: str
    sent: bool
    payout_batch_id: str | None
    reason: str | None = None


@dataclass(frozen=True)
class ReconcileReport:
    """ran is False when another run held the lock and nothing was read.

    waiting lists the exists_unresolved campaigns left for the batch webhook.
    """

    ran: bool
    actions: tuple[ReconcileAction, ...] = ()
    waiting: tuple[uuid.UUID, ...] = ()


def reconcile(conn: psycopg.Connection, http: PayPalHttp) -> ReconcileReport:
    """Settle every campaign stuck in submitting or left in submission_unknown.

    First, in one transaction, moves each campaign whose last move to submitting is
    more than 10 minutes old to submission_unknown, with an audit row each. Then for
    each submission_unknown campaign: reads its frozen snapshot, checks it against
    the payout rules and checks that the ledger holds exactly its sender_batch_id
    (any failure leaves it submission_unknown, sends nothing, and writes a
    "reconcile_skipped" audit row); claims it with one conditional update to
    submitting and an audit row; then calls send_claimed with the ledger's
    payout_batch_id, which records PayPal's answer by submit()'s rules.

    Returns ran False, reading nothing, when another run holds the lock. Errors
    that send_claimed raises again are raised again here, after the lock is freed.
    """
    if not conn.execute("select pg_try_advisory_lock(%s)", (RECONCILE_LOCK,)).fetchone()[0]:
        return ReconcileReport(ran=False)
    try:
        _mark_stuck(conn)
        unknown = [
            row[0]
            for row in conn.execute(
                "select campaign_id from campaigns where status = 'submission_unknown' order by created_at, campaign_id"
            )
        ]
        actions = tuple(_resend(conn, http, campaign_id) for campaign_id in unknown)
        waiting = tuple(
            row[0]
            for row in conn.execute(
                "select campaign_id from campaigns where status = 'exists_unresolved' order by created_at, campaign_id"
            )
        )
        with conn.transaction():
            conn.execute(
                _INSERT_AUDIT,
                (ACTOR, "reconcile_run", Jsonb({"looked_at": len(actions), "sent": sum(a.sent for a in actions), "waiting": len(waiting)})),
            )
    finally:
        conn.execute("select pg_advisory_unlock(%s)", (RECONCILE_LOCK,))
    return ReconcileReport(ran=True, actions=actions, waiting=waiting)


def _mark_stuck(conn: psycopg.Connection) -> None:
    with conn.transaction():
        # A campaign in submitting with no recorded move predates the record, so it is older than any threshold.
        stuck = conn.execute(
            "update campaigns c set status = 'submission_unknown' where c.status = 'submitting' and coalesce("
            "(select max(m.moved_at) from campaign_status_moves m where m.campaign_id = c.campaign_id and m.to_status = 'submitting'),"
            " '-infinity') < now() - %s returning c.campaign_id",
            (STUCK_AFTER,),
        ).fetchall()
        for (campaign_id,) in stuck:
            conn.execute(
                _INSERT_AUDIT,
                (ACTOR, "reconcile_marked_unknown", Jsonb({"campaign_id": str(campaign_id), "reason": "submitting for more than 10 minutes"})),
            )


def _resend(conn: psycopg.Connection, http: PayPalHttp, campaign_id: uuid.UUID) -> ReconcileAction:
    try:
        snap = frozen_snapshot(conn, campaign_id)
        if snap is None:
            return _skip(conn, campaign_id, "the campaign has no approved snapshot")
        validate_snapshot(snap, http.config)
    except SnapshotRefused:
        # A batch may already exist at PayPal, so the campaign is never voided from here.
        return _skip(conn, campaign_id, "the frozen snapshot fails its hash or a payout rule")
    sender_batch_id = sender_batch_id_for(snap)
    ledger = conn.execute(
        "select sender_batch_id, payout_batch_id from payout_batches where campaign_id = %s", (str(campaign_id),)
    ).fetchall()
    if len(ledger) != 1 or ledger[0][0] != sender_batch_id:
        return _skip(conn, campaign_id, "the ledger does not hold exactly this campaign's sender_batch_id")
    known = ledger[0][1]
    with conn.transaction():
        claimed = conn.execute(
            "update campaigns set status = 'submitting' where campaign_id = %s and status = 'submission_unknown' returning 1",
            (campaign_id,),
        ).fetchone()
        if claimed is not None:
            conn.execute(
                _INSERT_AUDIT,
                (
                    ACTOR,
                    "reconcile_resubmitting",
                    Jsonb({"campaign_id": str(campaign_id), "sender_batch_id": sender_batch_id, "known_payout_batch_id": known}),
                ),
            )
    if claimed is None:
        return ReconcileAction(campaign_id, "submission_unknown", _status(conn, campaign_id), False, known, "claimed elsewhere")
    result = send_claimed(conn, http, campaign_id, snap, sender_batch_id, known)
    return ReconcileAction(campaign_id, "submission_unknown", result.status, result.sent, result.payout_batch_id)


def _skip(conn: psycopg.Connection, campaign_id: uuid.UUID, reason: str) -> ReconcileAction:
    with conn.transaction():
        conn.execute(_INSERT_AUDIT, (ACTOR, "reconcile_skipped", Jsonb({"campaign_id": str(campaign_id), "reason": reason})))
    return ReconcileAction(campaign_id, "submission_unknown", "submission_unknown", False, None, reason)


def _status(conn: psycopg.Connection, campaign_id: uuid.UUID) -> str:
    return conn.execute("select status from campaigns where campaign_id = %s", (campaign_id,)).fetchone()[0]
