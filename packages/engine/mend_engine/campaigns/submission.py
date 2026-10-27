"""Sending an approved campaign as exactly one Payouts batch (C3).

submit() claims the campaign with one conditional update, approved to submitting,
so of any number of concurrent or repeated calls exactly one goes on to call
PayPal. The batch is built from the frozen approved snapshot alone. Its
sender_batch_id is derived from that snapshot, so a campaign has only ever one,
and PayPal refuses a repeat of it for 30 days. The ledger row is written before
PayPal is called, so a crash part way leaves a record to reconcile, never a gap.

Once any attempt for a sender_batch_id may have reached PayPal, no answer but a
created batch or PayPal's duplicate refusal settles the campaign, so a batch that
exists is never written off as refused. Immediately before every POST, every
receiver must still be a member (C28). In the claim's own transaction, under one
lock, the shop's balance less Mend's own recent batches must cover the batch, its
fees and the floor (C20); when it does not, nothing is claimed.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass

import psycopg
from psycopg.types.json import Jsonb

from mend_engine.campaigns.approval import frozen_snapshot
from mend_engine.campaigns.spend import CapExceeded, check_daily_cap, database_now, lock_daily_cap
from mend_engine.config import Config
from mend_engine.members.membership import LEFT_REASON
from mend_engine.paypal.balances import check_room, lock_balance
from mend_engine.paypal.http import PayPalError, PayPalHttp
from mend_engine.paypal.payouts import (
    REFUSAL_STATUSES,
    BatchExistsUnresolved,
    BatchSnapshot,
    SendBlocked,
    SnapshotRefused,
    SubmissionUnknown,
    normalise_email,
    sender_batch_id_for,
    snapshot_hash,
    submit_batch,
    validate_snapshot,
)

ACTOR = "engine"
REFUSED_REASON = "PayPal refused the batch"
# Written when a member left after a send that may have reached PayPal. Reconcile
# never resends a campaign that has one; PayPal's batch event settles it.
BLOCKED_ACTION = "send_blocked_member_left"
_INSERT_AUDIT = "insert into audit_log (actor, action, detail) values (%s, %s, %s)"
_ERROR_NAME = re.compile(r"[A-Z0-9_]{1,64}", re.ASCII)
_DEBUG_ID = re.compile(r"[A-Za-z0-9]{1,64}", re.ASCII)


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
    Then, if the campaign is approved, in one transaction under the balance lock and
    then the daily-cap lock: asks again that it is approved, reads the shop's PayPal
    balance once and checks the room left after Mend's own batches of the last 6
    hours (balances.check_room), moves the campaign from approved to submitting with
    one conditional update, re-checks the rolling daily cap, writes the
    payout_batches ledger row (status submitting) and an audit row. The balance lock
    is held until that commit, so a second sender's check sees this claim. Only
    then calls send_claimed, passing the payout_batch_id the
    ledger already holds for this sender_batch_id, if any; a ledger row that was
    already there means an earlier submission may have reached PayPal, so the
    outcome counts as ambiguous. send_claimed records the answer by its rules. A
    new sender_batch_id is never made.

    When the campaign is not approved, or the conditional update changes nothing
    (it was never approved, is already claimed or sent, or was voided), nothing is
    read or sent and the current state comes back with sent False.

    Raises BalanceTooLow, with nothing changed (the campaign stays approved and is
    not claimed), when the balance less Mend's batches of the last 6 hours, the
    batch total and 25 cents an item is below config.balance_floor_minor ("low_balance") or cannot be read
    ("balance_unavailable"); CapExceeded, with nothing changed but an audit row,
    when the batch would pass the daily cap; SnapshotRefused, with nothing changed,
    when the frozen snapshot fails its hash or a payout rule; LookupError for no
    such campaign; ValueError for a campaign_id that is not a UUID. Any other error
    after the claim marks the campaign submission_unknown and is raised again.
    """
    if not isinstance(campaign_id, uuid.UUID):
        raise ValueError("campaign_id must be a UUID")
    snap = frozen_snapshot(conn, campaign_id)
    if snap is None:
        return _current(conn, campaign_id, "")
    validate_snapshot(snap, config)
    sender_batch_id = sender_batch_id_for(snap)
    total = sum(item.amount_minor for item in snap.items)
    # Only an approved campaign can be claimed below, so only it is worth a balance read.
    # The status guard never moves a campaign back to approved once it has left.
    if _status(conn, campaign_id) != "approved":
        return _current(conn, campaign_id, sender_batch_id)

    try:
        with conn.transaction():
            lock_balance(conn)
            # Asked again under the lock every claim takes, so of many callers only the
            # one that will claim spends a balance read.
            claimed = None
            if _status(conn, campaign_id) == "approved":
                check_room(conn, http, snap, config.balance_floor_minor)
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
    return send_claimed(conn, http, campaign_id, snap, sender_batch_id, known, after_ambiguity=in_ledger is not None)


def send_claimed(
    conn: psycopg.Connection,
    http: PayPalHttp,
    campaign_id: uuid.UUID,
    snap: BatchSnapshot,
    sender_batch_id: str,
    known_payout_batch_id: str | None,
    *,
    after_ambiguity: bool,
) -> SubmissionResult:
    """Send a campaign the caller has just claimed (moved to submitting), and record PayPal's answer.

    The one send-and-settle step submit() and reconcile share, so both read
    PayPal's answer by the same rules. snap must be the campaign's frozen snapshot,
    sender_batch_id its sender_batch_id_for(), and known_payout_batch_id what the
    ledger holds for it. after_ambiguity must be True when an earlier submission of
    this sender_batch_id may have reached PayPal. Calls payouts.submit_batch, which
    checks immediately before every POST that every receiver is still a verified
    member, then in one transaction updates the ledger, moves the campaign out of
    submitting and writes an audit row:
    created or already existed to submitted; BatchExistsUnresolved to
    exists_unresolved; a 400 or 422 refusal with nothing ambiguous, or a snapshot
    the payout rules refuse before any send could have reached PayPal, to voided
    (ledger status refused); every other answer to submission_unknown. When a
    receiver is no longer a member: with nothing ambiguous, voided ("a member
    left") and nothing sent; otherwise submission_unknown with one
    "send_blocked_member_left" audit row holding only the campaign id. Any other
    error marks the campaign submission_unknown and is raised again.
    """
    try:
        result = submit_batch(
            http,
            snap,
            known_payout_batch_id=known_payout_batch_id,
            after_ambiguity=after_ambiguity,
            may_send=lambda: _receivers_still_members(conn, snap),
        )
    except SendBlocked as exc:
        return _blocked(conn, campaign_id, sender_batch_id, exc)
    except BatchExistsUnresolved as exc:
        return _settle(conn, campaign_id, sender_batch_id, "exists_unresolved", None, _error_detail(exc))
    except SubmissionUnknown as exc:
        return _settle(conn, campaign_id, sender_batch_id, "submission_unknown", None, _error_detail(exc))
    except PayPalError as exc:
        detail = {"status": exc.status, **_paypal_strings(exc.name, exc.debug_id)}
        # submit_batch raises this only for a refusal that proves nothing was created; checked again here.
        if after_ambiguity or exc.status not in REFUSAL_STATUSES:
            return _settle(conn, campaign_id, sender_batch_id, "submission_unknown", None, detail)
        return _settle(conn, campaign_id, sender_batch_id, "voided", None, detail, ledger_status="refused")
    except SnapshotRefused as exc:
        status = "submission_unknown" if after_ambiguity else "voided"
        return _settle(
            conn, campaign_id, sender_batch_id, status, None, {"rule": str(exc)},
            ledger_status=None if after_ambiguity else "refused", sent=False,
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
    void_reason: str = REFUSED_REASON,
) -> SubmissionResult:
    with conn.transaction():
        conn.execute(
            "update payout_batches set status = %s, payout_batch_id = coalesce(%s, payout_batch_id) where sender_batch_id = %s",
            (ledger_status or status, payout_batch_id, sender_batch_id),
        )
        conn.execute(
            "update campaigns set status = %s, void_reason = %s where campaign_id = %s and status = 'submitting'",
            (status, void_reason if status == "voided" else None, campaign_id),
        )
        _audit(conn, f"payout_{status}", campaign_id, sender_batch_id, payout_batch_id=payout_batch_id, **detail)
    return SubmissionResult(campaign_id, status, payout_batch_id, sender_batch_id, sent)


def _blocked(conn: psycopg.Connection, campaign_id: uuid.UUID, sender_batch_id: str, exc: SendBlocked) -> SubmissionResult:
    if not exc.ambiguous:
        return _settle(
            conn, campaign_id, sender_batch_id, "voided", None, {"reason": LEFT_REASON},
            ledger_status="refused", sent=False, void_reason=LEFT_REASON,
        )
    with conn.transaction():
        conn.execute("update payout_batches set status = 'submission_unknown' where sender_batch_id = %s", (sender_batch_id,))
        conn.execute(
            "update campaigns set status = 'submission_unknown' where campaign_id = %s and status = 'submitting'", (campaign_id,)
        )
        conn.execute(_INSERT_AUDIT, (ACTOR, BLOCKED_ACTION, Jsonb({"campaign_id": str(campaign_id)})))
    return SubmissionResult(campaign_id, "submission_unknown", None, sender_batch_id, exc.attempts > 0)


def _receivers_still_members(conn: psycopg.Connection, snap: BatchSnapshot) -> bool:
    """True when every receiver in the frozen snapshot still has a verified member row (C28).

    join_member stores paypal_email only through normalise_email, and the snapshot
    took its receivers from those stored values, so plain equality against the
    normalised receivers is the snapshot's own match. A row stored any other way
    fails to match, which blocks the send rather than allowing it.
    """
    receivers = sorted({normalise_email(item.receiver_email) for item in snap.items})
    found = conn.execute(
        "select count(*) from members where email_verified and paypal_email = any(%s)", (receivers,)
    ).fetchone()[0]
    return found == len(receivers)


def _status(conn: psycopg.Connection, campaign_id: uuid.UUID) -> str | None:
    row = conn.execute("select status from campaigns where campaign_id = %s", (campaign_id,)).fetchone()
    return row[0] if row else None


def _current(conn: psycopg.Connection, campaign_id: uuid.UUID, sender_batch_id: str) -> SubmissionResult:
    row = conn.execute("select status from campaigns where campaign_id = %s", (campaign_id,)).fetchone()
    if row is None:
        raise LookupError("no such campaign")
    ledger = conn.execute(
        "select payout_batch_id from payout_batches where sender_batch_id = %s", (sender_batch_id,)
    ).fetchone()
    return SubmissionResult(campaign_id, row[0], ledger[0] if ledger else None, sender_batch_id, False)


def _error_detail(exc: SubmissionUnknown) -> dict:
    return {"reason": exc.reason, "status": exc.status, **_paypal_strings(exc.name, exc.debug_id)}


def _paypal_strings(name: object, debug_id: object) -> dict:
    # PayPal's own strings, kept only when they have the shape PayPal uses (as in
    # campaigns/cancel.py), so nothing else reaches the audit log.
    return {
        "name": name if isinstance(name, str) and _ERROR_NAME.fullmatch(name) else None,
        "debug_id": debug_id if isinstance(debug_id, str) and _DEBUG_ID.fullmatch(debug_id) else None,
    }


def _audit(conn: psycopg.Connection, action: str, campaign_id: uuid.UUID, sender_batch_id: str, **detail: object) -> None:
    conn.execute(
        _INSERT_AUDIT,
        (ACTOR, action, Jsonb({"campaign_id": str(campaign_id), "sender_batch_id": sender_batch_id, **detail})),
    )
