"""Joining and leaving the shop's thank-you list, and matching a member to the shop's records.

A member row holds only what the customer gave through Log in with PayPal plus the
consent they agreed to. It is the only source of a payout receiver (C5 restated):
the shop's order records are used to decide who to thank, never where money goes.
Leaving takes effect at once: every campaign that has not been sent yet and
includes the member is voided in the same transaction that deletes them (C28).
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass

import psycopg
from psycopg.types.json import Jsonb

from mend_engine.members.consent import CONSENT_VERSION, consent_hash, consent_text_for

# The exact receiver rules the Payouts payload is built with, so a member who can
# join is a member PayPal can pay.
from mend_engine.paypal.payouts import EMAIL_SHAPE, MAX_RECEIVER_CHARS, SnapshotRefused, normalise_email

# Nothing has left the shop for a campaign in these states, so a member leaving voids it.
VOIDABLE_STATUSES = ("draft", "awaiting_approval", "approved")
LEFT_REASON = "a member left"
ACTOR = "member"

# PayPal's payer ids are short upper-case codes; the exact shape is confirmed from a
# real userinfo response later, so this accepts letters and digits only.
_PAYER_ID = re.compile(r"[A-Za-z0-9]{1,64}", re.ASCII)
_CLIENT_ID = re.compile(r"[A-Za-z0-9_-]{1,200}", re.ASCII)

_INSERT_MEMBER = (
    "insert into members (paypal_email, paypal_payer_id, email_verified, consent_version, "
    "consent_text_sha256, client_id) values (%s, %s, %s, %s, %s, %s) "
    "on conflict do nothing returning member_id"
)
_INSERT_AUDIT = "insert into audit_log (actor, action, detail) values (%s, %s, %s)"


class MembershipRefused(ValueError):
    """A join that breaks a membership rule. Messages never repeat the email or payer id.

    reason is one of three fixed codes: "not_payable" for an email PayPal could not
    be paid at, "identity_conflict" when the email or payer id belongs to a different
    member, and "bad_input" for every other refused value.
    """

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


@dataclass(frozen=True)
class LeaveResult:
    """removed is False when no such member existed. voided_campaigns lists every campaign voided."""

    removed: bool
    voided_campaigns: tuple[uuid.UUID, ...]


def join_member(
    conn: psycopg.Connection,
    *,
    paypal_email: str,
    paypal_payer_id: str | None,
    email_verified: bool,
    shop_name: str,
    client_id: str,
) -> uuid.UUID:
    """Record a customer's consent to the thank-you list and return their member id.

    Stores the email after normalise_email, the consent version and the hash of the
    consent text for shop_name. Writes one audit_log row with the member id and
    consent version when a member is created.

    Joining again with the same email returns the same member id. When the stored
    email is unverified and this call's is verified, the member is upgraded in one
    transaction: email_verified becomes true, the current consent version and text
    hash replace the earlier ones (the verified owner is consenting now, the first
    consent came from someone PayPal had not verified), a missing payer id is filled
    from this call, and one audit_log row "member_email_verified" holds the member
    id and consent version. A verified member is never downgraded. Every other
    repeat join changes nothing and writes no audit row.

    Raises MembershipRefused for an email PayPal could not be paid at, a malformed
    payer id or client id, an email_verified that is not a bool, a bad shop name, or
    an email or payer id that already belongs to a different member (a PayPal
    account is never silently moved to another email or the reverse). Nothing is
    written when it raises.
    """
    email = _checked_email(paypal_email)
    if paypal_payer_id is not None and (type(paypal_payer_id) is not str or not _PAYER_ID.fullmatch(paypal_payer_id)):
        raise MembershipRefused("bad_input", "payer id is malformed")
    if type(email_verified) is not bool:
        raise MembershipRefused("bad_input", "email_verified must be true or false")
    if type(client_id) is not str or not _CLIENT_ID.fullmatch(client_id):
        raise MembershipRefused("bad_input", "client id is malformed")
    try:
        digest = consent_hash(consent_text_for(shop_name))
    except ValueError as exc:
        raise MembershipRefused("bad_input", str(exc)) from None

    with conn.transaction():
        row = conn.execute(
            _INSERT_MEMBER, (email, paypal_payer_id, email_verified, CONSENT_VERSION, digest, client_id)
        ).fetchone()
        if row is not None:
            member_id = row[0]
            conn.execute(
                _INSERT_AUDIT,
                (ACTOR, "member_joined", Jsonb({"member_id": str(member_id), "consent_version": CONSENT_VERSION})),
            )
            return member_id
        # Locked until commit, so two verified joins at once upgrade the member and write its audit row only once.
        existing = conn.execute(
            "select member_id, paypal_email, paypal_payer_id, email_verified from members "
            "where paypal_email = %s or paypal_payer_id = %s for update",
            (email, paypal_payer_id),
        ).fetchall()
        if len(existing) == 1:
            member_id, stored_email, stored_payer_id, stored_verified = existing[0]
            if stored_email == email and (paypal_payer_id is None or stored_payer_id in (None, paypal_payer_id)):
                if email_verified and not stored_verified:
                    conn.execute(
                        # The verified owner consents now, so the consent record's time and app are theirs too.
                        "update members set email_verified = true, consent_version = %s, consent_text_sha256 = %s, "
                        "paypal_payer_id = coalesce(paypal_payer_id, %s), client_id = %s, joined_at = now() where member_id = %s",
                        (CONSENT_VERSION, digest, paypal_payer_id, client_id, member_id),
                    )
                    conn.execute(
                        _INSERT_AUDIT,
                        (
                            ACTOR,
                            "member_email_verified",
                            Jsonb({"member_id": str(member_id), "consent_version": CONSENT_VERSION}),
                        ),
                    )
                return member_id
    raise MembershipRefused("identity_conflict", "this email or PayPal account already belongs to a different member")


def leave_member(conn: psycopg.Connection, member_id: uuid.UUID) -> LeaveResult:
    """Remove a member at once, in one transaction.

    Voids every campaign in draft, awaiting_approval or approved that includes the
    member (status voided, void_reason "a member left") and removes the member's
    rows from those campaigns. Deletes the member row; rows in campaigns already
    past approval keep their place with member_id set to null. Writes one audit_log
    row holding only the member id, and one per voided campaign.

    Leaving twice is harmless: the second call returns removed=False. Raises
    ValueError if member_id is not a uuid.UUID.
    """
    if not isinstance(member_id, uuid.UUID):
        raise ValueError("member_id must be a UUID")
    with conn.transaction():
        # The member row is locked before campaigns are read. A draft being written
        # at the same time holds a key-share lock on it through its foreign key, so
        # either that draft commits first and is voided below, or this delete
        # commits first and the draft's insert fails. No draft can slip between.
        found = conn.execute("select 1 from members where member_id = %s for update", (member_id,)).fetchone()
        if found is None:
            return LeaveResult(removed=False, voided_campaigns=())
        voided = tuple(
            row[0]
            for row in conn.execute(
                "update campaigns set status = 'voided', void_reason = %s "
                "where status = any(%s) and campaign_id in "
                "(select campaign_id from campaign_members where member_id = %s) "
                "returning campaign_id",
                (LEFT_REASON, list(VOIDABLE_STATUSES), member_id),
            )
        )
        conn.execute(
            "delete from campaign_members where member_id = %s and campaign_id = any(%s)",
            (member_id, list(voided)),
        )
        conn.execute("delete from members where member_id = %s", (member_id,))
        conn.execute(_INSERT_AUDIT, (ACTOR, "member_left", Jsonb({"member_id": str(member_id)})))
        for campaign_id in voided:
            conn.execute(
                _INSERT_AUDIT,
                (ACTOR, "campaign_voided", Jsonb({"campaign_id": str(campaign_id), "reason": LEFT_REASON})),
            )
    return LeaveResult(removed=True, voided_campaigns=voided)


def customer_refs_by_email(conn: psycopg.Connection) -> dict[str, str]:
    """Every shop customer's reference, keyed by their email after normalise_email.

    Normalising happens here in Python, with the same function that stored the
    member's email, never in SQL, so both sides of the match come out of one
    normaliser. An email that two shop customers share after normalising maps to
    neither, because a match that could be either person is no match.
    """
    refs: dict[str, str] = {}
    shared: set[str] = set()
    for customer_ref, email in conn.execute("select customer_ref, email from shop_customers"):
        key = normalise_email(email)
        if key in refs:
            shared.add(key)
        refs[key] = customer_ref
    for key in shared:
        del refs[key]
    return refs


def match_member_to_customer(conn: psycopg.Connection, member_id: uuid.UUID) -> str | None:
    """The shop customer_ref whose email normalises equal to the member's PayPal email, or None.

    None when the member does not exist, PayPal has not verified the member's email,
    no shop customer has that email, or more than one does. An unverified email
    proves nothing about who owns it, so it could claim another person's orders.
    Reads every shop customer's email, which is fine at one shop's scale. Raises
    ValueError if member_id is not a uuid.UUID.
    """
    if not isinstance(member_id, uuid.UUID):
        raise ValueError("member_id must be a UUID")
    row = conn.execute(
        "select paypal_email from members where member_id = %s and email_verified", (member_id,)
    ).fetchone()
    if row is None:
        return None
    return customer_refs_by_email(conn).get(normalise_email(row[0]))


def _checked_email(value: object) -> str:
    try:
        email = normalise_email(value)  # type: ignore[arg-type]
    except SnapshotRefused:
        raise MembershipRefused("not_payable", "email must be text") from None
    if len(email) > MAX_RECEIVER_CHARS or not EMAIL_SHAPE.fullmatch(email):
        raise MembershipRefused("not_payable", "email is not a plain address PayPal can pay")
    return email
