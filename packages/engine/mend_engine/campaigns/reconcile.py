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

Three campaigns are never resent: one whose sender_batch_id was first claimed 29 or
more days ago, since PayPal stops refusing a repeat of it after 30; one whose
receiver left after a send that may have reached PayPal (C28); and one whose
snapshot fails its checks. Money can leave on a resend, so each resend is held to
exactly what a first send is, under the same locks (C4, C20): it waits for a later
run while the shop's balance, less Mend's own recent batches, cannot cover the
batch, its fees and the floor, or while the resend would pass the rolling daily cap
or, for a demo campaign, the demo pool. A campaign unsettled for more than an hour
is flagged for a person once.
"""

from __future__ import annotations

import traceback
import uuid
from dataclasses import dataclass
from datetime import timedelta

import psycopg
from psycopg.types.json import Jsonb

from mend_engine.campaigns.approval import frozen_snapshot
from mend_engine.campaigns.spend import (
    DEMO_SPEND_LOCK,
    CapExceeded,
    DemoPoolExceeded,
    check_daily_cap,
    check_demo_pool,
    database_now,
    lock_daily_cap,
)
from mend_engine.campaigns.submission import BLOCKED_ACTION, send_claimed
from mend_engine.paypal.balances import BalanceTooLow, check_room, lock_balance
from mend_engine.paypal.http import PayPalHttp
from mend_engine.paypal.payouts import BatchSnapshot, SnapshotRefused, sender_batch_id_for, validate_snapshot

SKIPPED_ACTION = "reconcile_skipped"
WAITING_ACTION = "resend_waiting_on_balance"
CAP_WAITING_ACTION = "resend_waiting_on_cap"
STUCK_AFTER = timedelta(minutes=10)
# PayPal refuses a repeated sender_batch_id for 30 days only. A day short of that
# leaves room for clocks that disagree and a run that starts late.
TOO_OLD_AFTER = timedelta(days=29)
ATTENTION_AFTER = timedelta(hours=1)
UNSETTLED_STATUSES = ("submission_unknown", "exists_unresolved")
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
    each submission_unknown campaign: skips it, with no audit row, if it has a
    "send_blocked_member_left" row; reads its frozen snapshot, checks it against
    the payout rules and checks that the ledger holds exactly its sender_batch_id
    (any failure leaves it submission_unknown, sends nothing, and writes one
    "reconcile_skipped" audit row the first time); leaves it as it is if its
    sender_batch_id was first claimed 29 or more days ago, writing one
    "reconcile_too_old" row the first time; for a campaign a demo session created,
    tries once for the demo spend lock (spend.DEMO_SPEND_LOCK) and leaves it for a
    later run when a demo send holds it. Then, in one transaction (_claim), under
    the balance lock: reads the shop's balance once (balances.check_room), takes
    the daily-cap lock, claims the campaign with one conditional update to
    submitting, which counts it from now, re-checks the rolling daily cap and, for
    a demo campaign, the demo pool, and writes an audit row. A balance too low or
    unreadable leaves it as it is, writing one "resend_waiting_on_balance" row the
    first time; a cap the resend would pass leaves it as it is, writing one
    "resend_waiting_on_cap" row (reason "daily_cap" or "demo_pool") the first
    time. Only after that commit, and the demo lock's release, calls send_claimed
    with the ledger's payout_batch_id, as a send after ambiguity, so only a created
    batch or PayPal's duplicate refusal settles it. An unexpected error on one
    campaign is logged with secrets removed under its own ref, and the run goes on
    to the next campaign. Last, writes one "needs_attention" row (campaign id and
    status) for each campaign that has been submission_unknown or
    exists_unresolved for more than an hour and has none yet.

    Returns ran False, reading nothing, when another run holds the lock.
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
        actions = tuple(_resend_or_log(conn, http, campaign_id) for campaign_id in unknown)
        waiting = tuple(
            row[0]
            for row in conn.execute(
                "select campaign_id from campaigns where status = 'exists_unresolved' order by created_at, campaign_id"
            )
        )
        _flag_needs_attention(conn)
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


def _flag_needs_attention(conn: psycopg.Connection) -> None:
    with conn.transaction():
        # Measured from the first move into either status, since each resend moves the
        # campaign through submitting and back. No recorded move means it predates the record.
        stale = conn.execute(
            "select c.campaign_id, c.status from campaigns c where c.status = any(%s) and coalesce("
            "(select min(m.moved_at) from campaign_status_moves m where m.campaign_id = c.campaign_id and m.to_status = any(%s)),"
            " '-infinity') < now() - %s and not exists (select 1 from audit_log a where a.action = 'needs_attention' "
            "and a.detail ->> 'campaign_id' = c.campaign_id::text) order by c.created_at, c.campaign_id",
            (list(UNSETTLED_STATUSES), list(UNSETTLED_STATUSES), ATTENTION_AFTER),
        ).fetchall()
        for campaign_id, status in stale:
            conn.execute(_INSERT_AUDIT, (ACTOR, "needs_attention", Jsonb({"campaign_id": str(campaign_id), "status": status})))


def _recorded(conn: psycopg.Connection, action: str, campaign_id: uuid.UUID) -> bool:
    return conn.execute(
        "select 1 from audit_log where action = %s and detail ->> 'campaign_id' = %s limit 1", (action, str(campaign_id))
    ).fetchone() is not None


def _first_claim_too_old(conn: psycopg.Connection, campaign_id: uuid.UUID, sender_batch_id: str) -> bool:
    # The older of the ledger row and the first recorded claim, so a lost record errs towards too old.
    return conn.execute(
        "select least(b.created_at, (select min(m.moved_at) from campaign_status_moves m "
        "where m.campaign_id = %s and m.to_status = 'submitting')) <= now() - %s "
        "from payout_batches b where b.sender_batch_id = %s",
        (campaign_id, TOO_OLD_AFTER, sender_batch_id),
    ).fetchone()[0]


def _resend_or_log(conn: psycopg.Connection, http: PayPalHttp, campaign_id: uuid.UUID) -> ReconcileAction:
    """_resend, with an unexpected error on this one campaign logged with secrets removed, so the others are still looked at."""
    try:
        return _resend(conn, http, campaign_id)
    except Exception as exc:
        # Imported here because tasks imports this module; by the time a run fails it is loaded.
        from mend_engine import tasks

        ref = str(uuid.uuid4())
        tasks._log(
            {
                "task": "reconcile",
                "ref": ref,
                "outcome": "failed",
                "error": "internal",
                "exception": type(exc).__name__,
                "campaign_id": str(campaign_id),
                "detail": tasks._scrub(str(exc), http.config),
                "trace": tasks._scrub(traceback.format_exc(), http.config),
            }
        )
        reason = f"an unexpected error, logged under ref {ref}; tried again on a later run"
        return ReconcileAction(campaign_id, "submission_unknown", _status(conn, campaign_id), False, None, reason)


def _resend(conn: psycopg.Connection, http: PayPalHttp, campaign_id: uuid.UUID) -> ReconcileAction:
    if _recorded(conn, BLOCKED_ACTION, campaign_id):
        reason = "a member left after a send that may have reached PayPal; the batch event settles it"
        return ReconcileAction(campaign_id, "submission_unknown", "submission_unknown", False, None, reason)
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
    if _first_claim_too_old(conn, campaign_id, sender_batch_id):
        if not _recorded(conn, "reconcile_too_old", campaign_id):
            with conn.transaction():
                conn.execute(
                    _INSERT_AUDIT,
                    (ACTOR, "reconcile_too_old", Jsonb({"campaign_id": str(campaign_id), "sender_batch_id": sender_batch_id})),
                )
        reason = "first claimed 29 or more days ago, so PayPal may no longer refuse a repeat"
        return ReconcileAction(campaign_id, "submission_unknown", "submission_unknown", False, known, reason)
    demo = conn.execute(
        "select 1 from campaign_owners where campaign_id = %s and role = 'demo'", (campaign_id,)
    ).fetchone() is not None
    # The lock a first demo send holds while it checks the demo pool and claims, so a
    # resend and a first send never both fit in the same headroom. Tried once, never
    # waited on, so the job cannot stall behind a slow send; the next run tries again.
    if demo and not conn.execute("select pg_try_advisory_lock(%s)", (DEMO_SPEND_LOCK,)).fetchone()[0]:
        reason = "a demo send holds the demo spend lock; tried again on a later run"
        return ReconcileAction(campaign_id, "submission_unknown", "submission_unknown", False, known, reason)
    try:
        try:
            claimed = _claim(conn, http, campaign_id, snap, sender_batch_id, known, demo=demo)
        except BalanceTooLow as short:
            reason = f"the shop's balance cannot cover the batch, its fees and the floor ({short.code}); tried again on a later run"
            return _wait(conn, campaign_id, sender_batch_id, known, WAITING_ACTION, short.code, reason)
        except CapExceeded as over:
            cap = "demo_pool" if isinstance(over, DemoPoolExceeded) else "daily_cap"
            reason = f"resending now would pass the {cap.replace('_', ' ')}; tried again on a later run"
            return _wait(conn, campaign_id, sender_batch_id, known, CAP_WAITING_ACTION, cap, reason)
    finally:
        if demo:
            conn.execute("select pg_advisory_unlock(%s)", (DEMO_SPEND_LOCK,))
    if not claimed:
        return ReconcileAction(campaign_id, "submission_unknown", _status(conn, campaign_id), False, known, "claimed elsewhere")
    result = send_claimed(conn, http, campaign_id, snap, sender_batch_id, known, after_ambiguity=True)
    return ReconcileAction(campaign_id, "submission_unknown", result.status, result.sent, result.payout_batch_id)


def _claim(
    conn: psycopg.Connection,
    http: PayPalHttp,
    campaign_id: uuid.UUID,
    snap: BatchSnapshot,
    sender_batch_id: str,
    known: str | None,
    *,
    demo: bool,
) -> bool:
    """Move the campaign back to submitting if the balance and the caps still have room for it.

    The same steps and locks as a first send, in one transaction: the balance lock,
    the balance read and room check (balances.check_room), the daily-cap lock, the
    claim, then the caps, which count the claim itself. Returns False, with no
    balance read, when the campaign is no longer submission_unknown. Raises
    BalanceTooLow, or CapExceeded (DemoPoolExceeded for the demo pool), with the
    claim rolled back.
    """
    with conn.transaction():
        lock_balance(conn)
        if _status(conn, campaign_id) != "submission_unknown":
            return False
        check_room(conn, http, snap, http.config.balance_floor_minor)
        lock_daily_cap(conn)
        claimed = conn.execute(
            "update campaigns set status = 'submitting' where campaign_id = %s and status = 'submission_unknown' returning 1",
            (campaign_id,),
        ).fetchone()
        if claimed is None:
            return False
        # The claim is the campaign's latest move into submitting, so the spend counted
        # below already holds this resend in full: nothing is added on top.
        check_daily_cap(conn, http.config, 0, database_now(conn))
        if demo:
            check_demo_pool(conn, 0)
        conn.execute(
            _INSERT_AUDIT,
            (
                ACTOR,
                "reconcile_resubmitting",
                Jsonb({"campaign_id": str(campaign_id), "sender_batch_id": sender_batch_id, "known_payout_batch_id": known}),
            ),
        )
    return True


def _wait(
    conn: psycopg.Connection,
    campaign_id: uuid.UUID,
    sender_batch_id: str,
    known: str | None,
    action: str,
    code: str,
    reason: str,
) -> ReconcileAction:
    # Once per campaign and kind of wait, as for _skip.
    if not _recorded(conn, action, campaign_id):
        with conn.transaction():
            conn.execute(
                _INSERT_AUDIT,
                (ACTOR, action, Jsonb({"campaign_id": str(campaign_id), "sender_batch_id": sender_batch_id, "reason": code})),
            )
    return ReconcileAction(campaign_id, "submission_unknown", "submission_unknown", False, known, reason)


def _skip(conn: psycopg.Connection, campaign_id: uuid.UUID, reason: str) -> ReconcileAction:
    # Once per campaign: the run every 5 minutes would otherwise add the same row each time.
    if not _recorded(conn, SKIPPED_ACTION, campaign_id):
        with conn.transaction():
            conn.execute(_INSERT_AUDIT, (ACTOR, SKIPPED_ACTION, Jsonb({"campaign_id": str(campaign_id), "reason": reason})))
    return ReconcileAction(campaign_id, "submission_unknown", "submission_unknown", False, None, reason)


def _status(conn: psycopg.Connection, campaign_id: uuid.UUID) -> str:
    return conn.execute("select status from campaigns where campaign_id = %s", (campaign_id,)).fetchone()[0]
