"""Approving one exact campaign, and the only ways a campaign may be edited (C2, C4, C28).

The owner is shown the hash of the campaign's canonical snapshot: every recipient,
receiver, amount, currency and note. approve() rebuilds that snapshot from the rows
as they stand and approves only if its hash equals the one the owner was shown, so
what is approved is exactly what was seen. The snapshot is then frozen in
approved_snapshots and the batch is built from that frozen copy alone. Every edit
function here voids an approved campaign, and triggers in the database refuse any
other change to an approved campaign's rows.
"""

from __future__ import annotations

import hmac
import json
import re
import uuid
from dataclasses import dataclass
from datetime import date, datetime

import psycopg
from psycopg.types.json import Jsonb

# end_of_day_utc is the boundary paid_net_of_refunds counts refunds up to, so the
# refunds after it are exactly the ones that function left out.
from mend_engine.campaigns.eligibility import sent_by_receiver
from mend_engine.campaigns.scoring import end_of_day_utc, paid_net_of_refunds
from mend_engine.campaigns.spend import CapExceeded, check_daily_cap, database_now
from mend_engine.config import Config
from mend_engine.members.membership import customer_refs_by_email
from mend_engine.money import MoneyError, to_decimal_string
from mend_engine.paypal.payouts import (
    MAX_NOTE_CHARS,
    SUPPORTED_CURRENCY,
    BatchSnapshot,
    PayoutItemSpec,
    SnapshotRefused,
    canonical_json,
    normalise_email,
    note_problem,
    snapshot_hash,
    validate_snapshot,
)

SUBJECT_TEMPLATE = "A thank-you from {shop_name}"
CHANGED_REASON = "changed after approval"
ACTOR = "engine"
OPEN_STATUSES = ("draft", "awaiting_approval")

_HASH = re.compile(r"[0-9a-f]{64}", re.ASCII)
# A principal id such as "owner" or "demo:4f2a", never an email address, so no
# personal data reaches the audit log through it.
_PRINCIPAL = re.compile(r"[A-Za-z0-9_.:-]{1,64}", re.ASCII)
_REF = re.compile(r"R[1-9][0-9]{0,3}", re.ASCII)
_SNAPSHOT_KEYS = {"campaign_id", "currency", "email_subject", "items"}
_ITEM_KEYS = {"receiver_email", "amount_minor", "note", "sender_item_id"}
_INSERT_AUDIT = "insert into audit_log (actor, action, detail) values (%s, %s, %s)"


class ApprovalRefused(ValueError):
    """The campaign was not approved. reason is a short fixed code; the message never names a member."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


class EditRefused(ValueError):
    """The edit was not made. reason is a short fixed code; the message never names a member."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


@dataclass(frozen=True)
class Approval:
    campaign_id: uuid.UUID
    snapshot_hash: str
    approved_at: datetime


@dataclass(frozen=True)
class EditResult:
    """applied is False when the campaign was approved: the edit voided it instead."""

    campaign_id: uuid.UUID
    status: str
    applied: bool


@dataclass(frozen=True)
class _Recipient:
    ref: str
    member_id: uuid.UUID | None
    email: str | None
    verified: bool
    amount_minor: int | None
    note: str | None


def current_snapshot(conn: psycopg.Connection, campaign_id: uuid.UUID) -> BatchSnapshot:
    """The campaign's batch as its rows stand now: what the owner reviews and approve() hashes.

    One item per rewarded row in rank order, its receiver the member's PayPal email
    as stored now, its sender_item_id the row's ref. Holdout rows are never items.
    Raises ValueError for a campaign_id that is not a UUID, LookupError for no such
    campaign, and ApprovalRefused when a rewarded row has no live member with a
    verified email, or no amount or note.
    """
    _check_id(campaign_id)
    row = conn.execute("select shop_name from campaigns where campaign_id = %s", (campaign_id,)).fetchone()
    if row is None:
        raise LookupError("no such campaign")
    return _snapshot(campaign_id, row[0], _recipients(conn, campaign_id))


def review_hash(conn: psycopg.Connection, campaign_id: uuid.UUID) -> str:
    """The hash to show the owner next to the campaign; approve() needs it back unchanged."""
    return snapshot_hash(current_snapshot(conn, campaign_id))


def approve(
    conn: psycopg.Connection, campaign_id: uuid.UUID, *, approver: str, presented_hash: str, config: Config
) -> Approval:
    """Approve the campaign exactly as it stands, if that is what the owner was shown.

    In one transaction, with the campaign row locked: the campaign must be a draft
    or awaiting approval; the snapshot rebuilt from its rows now must hash to
    presented_hash; and, against current data, every recipient must still be a
    member with a verified email, every amount at most the item cap, the campaign's
    per-recipient amount and what that member paid the shop by the campaign's
    as_of less every refund recorded up to now, less too, for a campaign no demo
    session created, every reward that left the shop for that member in the last
    365 days (eligibility.sent_by_receiver), the total at most the budget, the budget at most the
    campaign cap, the batch must pass validate_snapshot, and the total must fit
    under the rolling daily cap. Then the campaign moves to approved, the snapshot
    is frozen in approved_snapshots with approved_at and approved_by, and an audit
    row records the hash.

    Raises ApprovalRefused with nothing changed but one audit row naming the reason,
    or, for an approver that is not a plain principal id or a presented_hash that is
    not 64 lowercase hex characters, with nothing written at all. Raises ValueError
    for a campaign_id that is not a UUID.
    """
    _check_id(campaign_id)
    if type(approver) is not str or not _PRINCIPAL.fullmatch(approver):
        raise ApprovalRefused("invalid_input", "the approver must be a principal id, not an email or free text")
    if type(presented_hash) is not str or not _HASH.fullmatch(presented_hash):
        raise ApprovalRefused("invalid_input", "the presented hash must be 64 lowercase hex characters")
    try:
        with conn.transaction():
            approval = _approve(conn, campaign_id, approver, presented_hash, config)
    except ApprovalRefused as refused:
        with conn.transaction():
            conn.execute(
                _INSERT_AUDIT,
                (approver, "approval_refused", Jsonb({"campaign_id": str(campaign_id), "reason": refused.reason})),
            )
        raise
    return approval


def frozen_snapshot(conn: psycopg.Connection, campaign_id: uuid.UUID) -> BatchSnapshot | None:
    """The snapshot exactly as approved, or None if the campaign was never approved.

    Parses the stored canonical text strictly and refuses it unless it serialises
    back to the identical text, hashes to the stored snapshot_hash and names this
    campaign, so a batch can only be built from the bytes a person approved.
    Raises SnapshotRefused when it does not, ValueError for a campaign_id that is
    not a UUID.
    """
    _check_id(campaign_id)
    row = conn.execute(
        "select snapshot_hash, canonical_json from approved_snapshots where campaign_id = %s", (campaign_id,)
    ).fetchone()
    if row is None:
        return None
    stored_hash, text = row
    snap = _parse_canonical(text)
    if canonical_json(snap) != text or not hmac.compare_digest(snapshot_hash(snap), stored_hash):
        raise SnapshotRefused("the frozen snapshot does not match its hash")
    if snap.campaign_id != str(campaign_id):
        raise SnapshotRefused("the frozen snapshot belongs to another campaign")
    return snap


def set_amount(
    conn: psycopg.Connection, campaign_id: uuid.UUID, ref: str, amount_minor: int, config: Config
) -> EditResult:
    """Change one rewarded member's amount in a campaign that is not approved yet.

    On a draft or awaiting_approval campaign the amount must be whole cents from 1
    up and at most the item cap, the campaign's per-recipient amount and the same
    line approve() holds it to: what the member paid by the campaign's as_of less
    every refund recorded up to now, less, for a campaign no demo session created,
    every reward that left the shop for them in the last 365 days. The new total is at
    most the budget. On an approved campaign nothing changes but the approval,
    which is voided (void_reason "changed after approval"); a voided campaign is
    never sent. Writes one audit row either way.

    Raises EditRefused, with nothing changed, for: an amount that is not whole
    cents or breaks a cap; no such campaign; a campaign already sent or voided; a
    ref that is unknown or held back.
    """
    if type(amount_minor) is not int or amount_minor < 1:
        raise EditRefused("invalid_input", "the amount must be whole cents from 1 up")
    try:
        to_decimal_string(amount_minor)
    except MoneyError:
        raise EditRefused("invalid_input", "the amount is outside what PayPal can be sent") from None

    def apply(campaign: tuple, target: tuple) -> dict:
        _status, as_of, budget, per_recipient = campaign
        _role, member_id, current = target
        if amount_minor > config.item_cap_minor:
            raise EditRefused("amount_over_item_cap", "the amount is above the item cap")
        if amount_minor > per_recipient:
            raise EditRefused("amount_over_per_recipient", "the amount is above this campaign's amount per person")
        paid = _paid_by_member(conn, as_of, [member_id], every_refund=True).get(member_id, 0)
        email = conn.execute("select paypal_email from members where member_id = %s", (member_id,)).fetchone()
        sent = _owner_sent(conn, campaign_id).get(normalise_email(email[0]), 0) if email else 0
        if amount_minor + sent > paid:
            raise EditRefused(
                "amount_over_paid", "the amount, with rewards sent in 365 days, is above what this member has paid net of refunds"
            )
        others = conn.execute(
            "select coalesce(sum(amount_minor), 0) from campaign_members where campaign_id = %s and role = 'reward' and ref <> %s",
            (campaign_id, ref),
        ).fetchone()[0]
        if others + amount_minor > budget:
            raise EditRefused("over_budget", "the new total is above the budget")
        conn.execute(
            "update campaign_members set amount_minor = %s where campaign_id = %s and ref = %s",
            (amount_minor, campaign_id, ref),
        )
        return {"field": "amount_minor", "from": current, "to": amount_minor}

    return _edit(conn, campaign_id, ref, "set_amount", apply)


def set_note(conn: psycopg.Connection, campaign_id: uuid.UUID, ref: str, note: str) -> EditResult:
    """Change one rewarded member's note in a campaign that is not approved yet.

    The note must pass the same rule every payout note passes (note_problem). On an
    approved campaign nothing changes but the approval, which is voided as for
    set_amount. The audit row records that the note changed, never its text.

    Raises EditRefused as set_amount does, and for a note the rule refuses.
    """
    problem = note_problem(note, MAX_NOTE_CHARS)
    if problem:
        raise EditRefused("note_rejected", f"the note {problem}")

    def apply(_campaign: tuple, _target: tuple) -> dict:
        conn.execute("update campaign_members set note = %s where campaign_id = %s and ref = %s", (note, campaign_id, ref))
        return {"field": "note"}

    return _edit(conn, campaign_id, ref, "set_note", apply)


def remove_recipient(conn: psycopg.Connection, campaign_id: uuid.UUID, ref: str) -> EditResult:
    """Take one rewarded member out of a campaign that is not approved yet.

    Holdout rows can never be removed, so the experiment stays as drawn (C6). On an
    approved campaign nothing changes but the approval, which is voided as for
    set_amount.

    Raises EditRefused as set_amount does.
    """

    def apply(_campaign: tuple, _target: tuple) -> dict:
        conn.execute("delete from campaign_members where campaign_id = %s and ref = %s", (campaign_id, ref))
        return {"field": "removed"}

    return _edit(conn, campaign_id, ref, "remove_recipient", apply)


def _approve(conn: psycopg.Connection, campaign_id: uuid.UUID, approver: str, presented: str, config: Config) -> Approval:
    campaign = conn.execute(
        "select shop_name, as_of, budget_minor, per_recipient_minor, status from campaigns where campaign_id = %s for update",
        (campaign_id,),
    ).fetchone()
    if campaign is None:
        raise ApprovalRefused("not_found", "no such campaign")
    shop_name, as_of, budget, per_recipient, status = campaign
    if status == "voided":
        raise ApprovalRefused("voided", "the campaign was voided and can never be approved")
    if status not in OPEN_STATUSES:
        raise ApprovalRefused("not_open", f"the campaign is {status}, not a draft awaiting approval")

    recipients = _recipients(conn, campaign_id)
    snap = _snapshot(campaign_id, shop_name, recipients)
    digest = snapshot_hash(snap)
    if not hmac.compare_digest(digest, presented):
        raise ApprovalRefused("hash_mismatch", "the campaign is not the one that was shown; review it again")

    paid = _paid_by_member(conn, as_of, [r.member_id for r in recipients], every_refund=True)
    sent = _owner_sent(conn, campaign_id)
    for number, recipient in enumerate(recipients, start=1):
        amount = recipient.amount_minor
        if amount > config.item_cap_minor:
            raise ApprovalRefused("amount_over_item_cap", f"item {number}: the amount is above the item cap")
        if amount > per_recipient:
            raise ApprovalRefused("amount_over_per_recipient", f"item {number}: the amount is above the amount per person")
        if amount + sent.get(normalise_email(recipient.email), 0) > paid.get(recipient.member_id, 0):
            raise ApprovalRefused(
                "amount_over_paid", f"item {number}: the amount, with rewards sent in 365 days, is above what the member paid net of refunds"
            )
    total = sum(r.amount_minor for r in recipients)
    if total > budget:
        raise ApprovalRefused("over_budget", "the amounts add up to more than the budget")
    if budget > config.campaign_cap_minor:
        raise ApprovalRefused("budget_over_cap", "the budget is above the campaign cap")
    try:
        validate_snapshot(snap, config)
    except SnapshotRefused as exc:
        raise ApprovalRefused("snapshot_refused", str(exc)) from None
    try:
        check_daily_cap(conn, config, total, database_now(conn))
    except CapExceeded as exc:
        raise ApprovalRefused("over_daily_cap", str(exc)) from None

    approved_at = conn.execute(
        "update campaigns set status = 'approved' where campaign_id = %s returning now()", (campaign_id,)
    ).fetchone()[0]
    stored = conn.execute(
        "insert into approved_snapshots (campaign_id, snapshot_hash, canonical_json, approved_at, approved_by) "
        "values (%s, %s, %s, %s, %s) on conflict (campaign_id) do nothing returning campaign_id",
        (campaign_id, digest, canonical_json(snap), approved_at, approver),
    ).fetchone()
    if stored is None:
        raise ApprovalRefused("approved_before", "this campaign was approved once already")
    conn.execute(
        _INSERT_AUDIT,
        (
            approver,
            "campaign_approved",
            Jsonb({"campaign_id": str(campaign_id), "snapshot_hash": digest, "recipients": len(recipients), "total_minor": total}),
        ),
    )
    return Approval(campaign_id, digest, approved_at)


def _recipients(conn: psycopg.Connection, campaign_id: uuid.UUID) -> list[_Recipient]:
    rows = conn.execute(
        "select cm.ref, cm.member_id, m.paypal_email, coalesce(m.email_verified, false), cm.amount_minor, cm.note "
        "from campaign_members cm left join members m on m.member_id = cm.member_id "
        "where cm.campaign_id = %s and cm.role = 'reward' order by cm.rank",
        (campaign_id,),
    ).fetchall()
    recipients = [_Recipient(*row) for row in rows]
    for number, recipient in enumerate(recipients, start=1):
        if recipient.member_id is None or recipient.email is None:
            raise ApprovalRefused("recipient_not_member", f"item {number}: the recipient is no longer a member")
        if not recipient.verified:
            raise ApprovalRefused("recipient_unverified", f"item {number}: PayPal has not verified the recipient's email")
        if type(recipient.amount_minor) is not int or recipient.amount_minor < 1 or recipient.note is None:
            raise ApprovalRefused("incomplete_item", f"item {number}: the amount or note is missing")
    return recipients


def _snapshot(campaign_id: uuid.UUID, shop_name: str, recipients: list[_Recipient]) -> BatchSnapshot:
    return BatchSnapshot(
        campaign_id=str(campaign_id),
        currency=SUPPORTED_CURRENCY,
        email_subject=SUBJECT_TEMPLATE.format(shop_name=shop_name),
        items=tuple(PayoutItemSpec(r.email, r.amount_minor, r.note, r.ref) for r in recipients),
    )


def _owner_sent(conn: psycopg.Connection, campaign_id: uuid.UUID) -> dict[str, int]:
    """Cents sent to each receiver in the last 365 days if no demo session created the campaign; nothing for one that did (C4).

    An owner campaign is any campaign no demo session created, the rule eligibility drafts by.
    """
    owner_role = conn.execute("select role from campaign_owners where campaign_id = %s", (campaign_id,)).fetchone()
    return sent_by_receiver(conn) if owner_role is None or owner_role[0] != "demo" else {}


def _paid_by_member(
    conn: psycopg.Connection, as_of: date, member_ids: list, *, every_refund: bool = False
) -> dict[uuid.UUID, int]:
    """What each member's shop customer paid by as_of net of refunds, through the same match and sum the draft used.

    With every_refund, refunds recorded after as_of are taken off too: money the
    shop has given back since the draft's day has still left it. Never below 0.
    """
    emails = dict(
        conn.execute(
            "select member_id, paypal_email from members where member_id = any(%s) and email_verified", (member_ids,)
        ).fetchall()
    )
    by_email = customer_refs_by_email(conn)
    customer_of = {m: by_email.get(normalise_email(e)) for m, e in emails.items()}
    refs = [ref for ref in customer_of.values() if ref is not None]
    paid = paid_net_of_refunds(conn, as_of, refs)
    if every_refund:
        # paid_net_of_refunds already took off every refund before this same boundary, and a
        # figure it floored at 0 stays at 0, so taking off the later ones gives paid less every refund.
        later = dict(
            conn.execute(
                "select customer_ref, sum(amount_minor) from shop_refunds where refunded_at >= %s and customer_ref = any(%s) "
                "group by customer_ref",
                (end_of_day_utc(as_of), refs),
            ).fetchall()
        )
        paid = {ref: max(total - int(later.get(ref, 0)), 0) for ref, total in paid.items()}
    return {m: paid.get(ref, 0) for m, ref in customer_of.items() if ref is not None}


def _edit(conn: psycopg.Connection, campaign_id: uuid.UUID, ref: str, action: str, apply) -> EditResult:
    _check_id(campaign_id)
    if type(ref) is not str or not _REF.fullmatch(ref):
        raise EditRefused("unknown_ref", "no such ref in this campaign")
    with conn.transaction():
        campaign = conn.execute(
            "select status, as_of, budget_minor, per_recipient_minor from campaigns where campaign_id = %s for update",
            (campaign_id,),
        ).fetchone()
        if campaign is None:
            raise EditRefused("not_found", "no such campaign")
        status = campaign[0]
        if status == "approved":
            conn.execute(
                "update campaigns set status = 'voided', void_reason = %s where campaign_id = %s", (CHANGED_REASON, campaign_id)
            )
            conn.execute(
                _INSERT_AUDIT,
                (ACTOR, "campaign_voided", Jsonb({"campaign_id": str(campaign_id), "reason": CHANGED_REASON, "edit": action})),
            )
            return EditResult(campaign_id, "voided", False)
        if status not in OPEN_STATUSES:
            raise EditRefused("not_editable", f"the campaign is {status} and can no longer change")
        target = conn.execute(
            "select role, member_id, amount_minor from campaign_members where campaign_id = %s and ref = %s for update",
            (campaign_id, ref),
        ).fetchone()
        if target is None:
            raise EditRefused("unknown_ref", "no such ref in this campaign")
        if target[0] != "reward":
            raise EditRefused("holdout_ref", "held-back members are never paid or changed")
        change = apply(campaign, target)
        conn.execute(
            _INSERT_AUDIT,
            (ACTOR, "campaign_edited", Jsonb({"campaign_id": str(campaign_id), "ref": ref, "edit": action, **change})),
        )
    return EditResult(campaign_id, status, True)


def _parse_canonical(text: str) -> BatchSnapshot:
    def no_repeats(pairs: list) -> dict:
        keys = [key for key, _ in pairs]
        if len(keys) != len(set(keys)):
            raise SnapshotRefused("the frozen snapshot repeats a key")
        return dict(pairs)

    try:
        data = json.loads(text, object_pairs_hook=no_repeats)
    except (TypeError, ValueError):
        raise SnapshotRefused("the frozen snapshot is not valid JSON") from None
    if type(data) is not dict or set(data) != _SNAPSHOT_KEYS or type(data["items"]) is not list:
        raise SnapshotRefused("the frozen snapshot has the wrong shape")
    if not all(type(data[key]) is str for key in ("campaign_id", "currency", "email_subject")):
        raise SnapshotRefused("the frozen snapshot has the wrong shape")
    items = []
    for entry in data["items"]:
        if type(entry) is not dict or set(entry) != _ITEM_KEYS or type(entry["amount_minor"]) is not int:
            raise SnapshotRefused("a frozen item has the wrong shape")
        if not all(type(entry[key]) is str for key in ("receiver_email", "note", "sender_item_id")):
            raise SnapshotRefused("a frozen item has the wrong shape")
        items.append(PayoutItemSpec(entry["receiver_email"], entry["amount_minor"], entry["note"], entry["sender_item_id"]))
    return BatchSnapshot(data["campaign_id"], data["currency"], data["email_subject"], tuple(items))


def _check_id(campaign_id: object) -> None:
    if not isinstance(campaign_id, uuid.UUID):
        raise ValueError("campaign_id must be a UUID")
