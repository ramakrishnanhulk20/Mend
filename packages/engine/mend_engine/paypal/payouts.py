"""Cashback payouts through the PayPal Payouts API, at most one batch per snapshot.

The sender_batch_id is a hash of the frozen snapshot, so the same snapshot can
never become two batches: PayPal refuses a repeated sender_batch_id for 30 days.
The request body is built from the same canonical data that is hashed.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from mend_engine.config import Config
from mend_engine.money import MoneyError, to_decimal_string
from mend_engine.paypal.http import (
    PayPalError,
    PayPalHttp,
    PayPalResponse,
    PayPalUnreachable,
)

PAYOUTS_PATH = "/v1/payments/payouts"
PAYOUT_ITEM_PATH = "/v1/payments/payouts-item"
SUPPORTED_CURRENCY = "USD"
MAX_ITEMS = 200
MAX_NOTE_CHARS = 400
MAX_SUBJECT_CHARS = 255
MAX_RECEIVER_CHARS = 127
# PayPal turns notes starting with these into canned sandbox answers instead of real payouts.
SANDBOX_TRIGGER_PREFIXES = ("POSPYO", "ERRPYO", "POSPOI", "ERRPOI")
RETRY_BACKOFF_SECONDS = (2, 5)
# The only answers that prove PayPal created nothing, and only when no earlier attempt
# for the same sender_batch_id went unanswered. 401, 403 and 429 say nothing about
# the batch itself, so they never count as a refusal.
REFUSAL_STATUSES = (400, 422)

_LONG_DIGIT_RUN = re.compile(r"[0-9]{7,}")
_LETTER_RUN = re.compile(r"[a-z]+", re.ASCII)
# A word, a dot and two or more letters with no space between, such as "evil.example"
# or "x.co": the same pattern the web app's note rule uses.
_DOMAIN_LIKE = re.compile(r"[A-Za-z0-9-]\.[A-Za-z]{2,}", re.ASCII)
# PayPal's Payouts Terms forbid implying PayPal or Venmo sponsors the offer; a note
# never needs to name either.
_PAYMENT_BRANDS = {"paypal": "PayPal", "venmo": "Venmo"}
_PAYOUT_ID = re.compile(r"[A-Z0-9]{1,32}", re.ASCII)
# Every item status PayPal documents is one word of capitals; anything else is not read.
_ITEM_STATUS = re.compile(r"[A-Z]{1,36}", re.ASCII)
_SENDER_ITEM_ID = re.compile(r"[A-Za-z0-9_-]{1,63}", re.ASCII)
_CAMPAIGN_ID = re.compile(r"[A-Za-z0-9_.:-]{1,64}", re.ASCII)
_EMAIL_SHAPE = re.compile(r"[!-?A-~]+@[!-?A-~]+\.[!-?A-~]+", re.ASCII)
# The receiver rule, shared so a member who can join is a member a batch can pay.
EMAIL_SHAPE = _EMAIL_SHAPE

# Module-level so tests can replace the wait without a real 7 second pause.
_sleep = time.sleep


class SnapshotRefused(ValueError):
    """The snapshot breaks a payout rule. Messages name the item number, never its content."""


class PayoutIdRefused(ValueError):
    """A payout id that does not look like one PayPal issues."""


class SubmissionUnknown(Exception):
    """PayPal may or may not hold a batch for this sender_batch_id.

    The caller must reconcile using sender_batch_id before doing anything else.
    """

    def __init__(
        self,
        sender_batch_id: str,
        reason: str,
        *,
        status: int | None = None,
        name: str | None = None,
        debug_id: str | None = None,
    ) -> None:
        self.sender_batch_id = sender_batch_id
        self.reason = reason
        self.status = status
        self.name = name
        self.debug_id = debug_id
        super().__init__(
            f"submission unknown for {sender_batch_id}: {reason} "
            f"(status={status} name={name} debug_id={debug_id})"
        )


BATCH_EXISTS_REASON = (
    "PayPal confirms a batch with this sender_batch_id exists; its payout_batch_id must be "
    "resolved from the batch webhook or Transaction Search; never resubmit under a different id"
)


class SendBlocked(Exception):
    """The caller's check said no just before a POST, so that POST was never sent.

    ambiguous is True when an earlier attempt for this sender_batch_id, in this call
    or an earlier one, may have reached PayPal. attempts counts the POSTs this call
    had already tried.
    """

    def __init__(self, sender_batch_id: str, *, ambiguous: bool, attempts: int) -> None:
        self.sender_batch_id = sender_batch_id
        self.ambiguous = ambiguous
        self.attempts = attempts
        super().__init__(f"send blocked for {sender_batch_id} (ambiguous={ambiguous} attempts={attempts})")


class BatchExistsUnresolved(SubmissionUnknown):
    """PayPal confirms the batch exists; resolve its payout_batch_id from the webhook or Transaction Search, never resubmit under a different id."""

    def __init__(
        self,
        sender_batch_id: str,
        *,
        status: int | None = None,
        name: str | None = None,
        debug_id: str | None = None,
    ) -> None:
        super().__init__(sender_batch_id, BATCH_EXISTS_REASON, status=status, name=name, debug_id=debug_id)


@dataclass(frozen=True)
class PayoutItemSpec:
    receiver_email: str
    amount_minor: int
    note: str
    sender_item_id: str


@dataclass(frozen=True)
class BatchSnapshot:
    campaign_id: str
    currency: str
    email_subject: str
    items: tuple[PayoutItemSpec, ...]


@dataclass
class SubmitResult:
    payout_batch_id: str
    sender_batch_id: str
    outcome: Literal["created", "already_existed"]


def normalise_email(value: str) -> str:
    """The one email normaliser: used for hashing, duplicate checks and the request body."""
    if type(value) is not str:
        raise SnapshotRefused("receiver email must be text")
    return value.strip().lower()


def _canonical_dict(snapshot: BatchSnapshot) -> dict:
    return {
        "campaign_id": snapshot.campaign_id,
        "currency": snapshot.currency,
        "email_subject": snapshot.email_subject,
        "items": [
            {
                "receiver_email": normalise_email(item.receiver_email),
                "amount_minor": item.amount_minor,
                "note": item.note,
                "sender_item_id": item.sender_item_id,
            }
            for item in snapshot.items
        ],
    }


def canonical_json(snapshot: BatchSnapshot) -> str:
    """The exact text that is hashed: sorted keys, no spaces, ASCII only, emails normalised."""
    return json.dumps(
        _canonical_dict(snapshot), sort_keys=True, separators=(",", ":"), ensure_ascii=True
    )


def snapshot_hash(snapshot: BatchSnapshot) -> str:
    return hashlib.sha256(canonical_json(snapshot).encode("ascii")).hexdigest()


def sender_batch_id_for(snapshot: BatchSnapshot) -> str:
    """Deterministic id for a snapshot. Equal snapshots always give the same id."""
    return "mend-" + snapshot_hash(snapshot)[:40]


def _text_problem(text: object, max_chars: int) -> str | None:
    """Why text may not reach a customer's inbox, or None if it may.

    Allows printable ASCII only. Covers links and domain-like words, markup (any "<"
    or ">"), email addresses, long numbers such as phone or card numbers (7 or more
    digits in a row once every character that is not a letter or a digit is removed,
    so "415*555*0199" counts as one run), control characters, sandbox test codes and
    the names PayPal and Venmo in any case or spacing. Does not cover persuasive
    wording, lookalike spellings such as "PayPaI", or digits split by letters such as
    "415x555x0199"; the owner reads every note at approval for that. A full date such
    as "10/16/2026" counts as a long number, as "16.10.2026" did already.
    """
    if type(text) is not str:
        return "is not text"
    if not text.strip():
        return "is empty"
    if len(text) > max_chars:
        return f"is longer than {max_chars} characters"
    if not text.isascii():
        return "has non-ASCII characters"
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in text):
        return "has a control character"
    if "<" in text or ">" in text:
        return "has markup"
    lowered = text.lower()
    if "http" in lowered or "www." in lowered or _DOMAIN_LIKE.search(text):
        return "looks like a link"
    if "@" in text:
        return "contains @"
    # A rule, not a list of separators: str.isalnum keeps Unicode letters and numbers and
    # nothing else. The web app's note rule (packages/web/src/server/notes.ts) is meant
    # to keep the same characters.
    if _LONG_DIGIT_RUN.search("".join(ch for ch in text if ch.isalnum())):
        return "has a run of 7 or more digits"
    if text.lstrip().upper().startswith(SANDBOX_TRIGGER_PREFIXES):
        return "starts with a PayPal sandbox test code"
    brand = _named_brand(lowered)
    if brand:
        return f"names {brand}"
    return None


def _named_brand(lowered: str) -> str | None:
    """PayPal or Venmo if lowered text spells either, in one word or across whole words.

    "PayPal's", "Pay Pal" and "v-e-n-m-o" match; "even more" and "seven months" do
    not, because a name split over words must start and end on word edges.
    """
    words = _LETTER_RUN.findall(lowered)
    for brand, shown in _PAYMENT_BRANDS.items():
        for start, word in enumerate(words):
            if brand in word:
                return shown
            joined = word
            for following in words[start + 1 :]:
                if not brand.startswith(joined):
                    break
                joined += following
                if joined == brand:
                    return shown
    return None


# The note rule, shared so a note accepted anywhere is a note the batch will accept.
note_problem = _text_problem


def validate_snapshot(snapshot: BatchSnapshot, config: Config) -> None:
    """Refuse any snapshot that breaks a payout rule, before anything is sent.

    Raises SnapshotRefused on: no items; more than 200 items; a duplicate receiver
    (after normalise_email) or sender_item_id; an amount below 1 cent or above the
    per-item cap; a total above the campaign cap; a currency other than USD; a
    malformed receiver, campaign id or sender_item_id; a note or subject that is
    empty, too long, non-ASCII, has a control character, "<" or ">", "http", "www.",
    a domain-like word, "@", a run of 7 or more digits once every character that is
    not a letter or a digit is removed, starts with a sandbox test code, or names
    PayPal or Venmo.
    """
    if not isinstance(snapshot, BatchSnapshot):
        raise SnapshotRefused("not a BatchSnapshot")
    if type(snapshot.campaign_id) is not str or not _CAMPAIGN_ID.fullmatch(snapshot.campaign_id):
        raise SnapshotRefused("campaign id is missing or malformed")
    if snapshot.currency != SUPPORTED_CURRENCY:
        raise SnapshotRefused("currency must be USD")
    problem = _text_problem(snapshot.email_subject, MAX_SUBJECT_CHARS)
    if problem:
        raise SnapshotRefused(f"email subject {problem}")
    if type(snapshot.items) is not tuple or not snapshot.items:
        raise SnapshotRefused("a batch needs at least one item")
    if len(snapshot.items) > MAX_ITEMS:
        raise SnapshotRefused(f"a batch may hold at most {MAX_ITEMS} items")

    receivers: set[str] = set()
    item_ids: set[str] = set()
    total = 0
    for index, item in enumerate(snapshot.items, start=1):
        if not isinstance(item, PayoutItemSpec):
            raise SnapshotRefused(f"item {index}: not a PayoutItemSpec")
        receiver = normalise_email(item.receiver_email)
        if len(receiver) > MAX_RECEIVER_CHARS or not _EMAIL_SHAPE.fullmatch(receiver):
            raise SnapshotRefused(f"item {index}: receiver is not a plain email address")
        if receiver in receivers:
            raise SnapshotRefused(f"item {index}: receiver appears twice in the batch")
        receivers.add(receiver)
        if type(item.sender_item_id) is not str or not _SENDER_ITEM_ID.fullmatch(item.sender_item_id):
            raise SnapshotRefused(f"item {index}: sender_item_id is missing or malformed")
        if item.sender_item_id in item_ids:
            raise SnapshotRefused(f"item {index}: sender_item_id appears twice in the batch")
        item_ids.add(item.sender_item_id)
        if type(item.amount_minor) is not int:
            raise SnapshotRefused(f"item {index}: amount must be whole cents")
        if item.amount_minor < 1:
            raise SnapshotRefused(f"item {index}: amount must be at least 1 cent")
        if item.amount_minor > config.item_cap_minor:
            raise SnapshotRefused(f"item {index}: amount is above the per-item cap")
        problem = _text_problem(item.note, MAX_NOTE_CHARS)
        if problem:
            raise SnapshotRefused(f"item {index}: note {problem}")
        total += item.amount_minor
    if total > config.campaign_cap_minor:
        raise SnapshotRefused("batch total is above the campaign cap")


def _payload(snapshot: BatchSnapshot, sender_batch_id: str) -> dict:
    canonical = _canonical_dict(snapshot)
    try:
        items = [
            {
                "recipient_type": "EMAIL",
                "receiver": item["receiver_email"],
                "amount": {
                    "currency": canonical["currency"],
                    "value": to_decimal_string(item["amount_minor"]),
                },
                "note": item["note"],
                "sender_item_id": item["sender_item_id"],
                "purpose": "CASHBACK",
            }
            for item in canonical["items"]
        ]
    except MoneyError:
        raise SnapshotRefused("an amount could not be formatted") from None
    return {
        "sender_batch_header": {
            "sender_batch_id": sender_batch_id,
            "email_subject": canonical["email_subject"],
            "recipient_type": "EMAIL",
        },
        "items": items,
    }


def _error_name(body: dict) -> str | None:
    name = body.get("name")
    return name if isinstance(name, str) else None


def _is_already_exists(body: dict) -> bool:
    details = body.get("details")
    if not isinstance(details, list):
        return False
    return any(
        isinstance(entry, dict) and isinstance(entry.get("issue"), str) and "already exists" in entry["issue"]
        for entry in details
    )


def _batch_id_if_ours(body: dict, sender_batch_id: str) -> str | None:
    """PayPal's payout_batch_id, only if the batch PayPal describes is the one we sent."""
    header = body.get("batch_header")
    if not isinstance(header, dict):
        return None
    payout_batch_id = header.get("payout_batch_id")
    sender_header = header.get("sender_batch_header")
    if not isinstance(payout_batch_id, str) or not _PAYOUT_ID.fullmatch(payout_batch_id):
        return None
    if not isinstance(sender_header, dict) or sender_header.get("sender_batch_id") != sender_batch_id:
        return None
    return payout_batch_id


def _confirm_known(http: PayPalHttp, known_payout_batch_id: str, sender_batch_id: str) -> SubmitResult:
    try:
        batch = get_batch(http, known_payout_batch_id)
    except PayoutIdRefused:
        raise SubmissionUnknown(sender_batch_id, "the known payout_batch_id is malformed") from None
    except PayPalError as exc:
        raise SubmissionUnknown(
            sender_batch_id,
            "could not read the known batch from PayPal",
            status=exc.status,
            name=exc.name,
            debug_id=exc.debug_id,
        ) from None
    if _batch_id_if_ours(batch, sender_batch_id) != known_payout_batch_id:
        raise SubmissionUnknown(
            sender_batch_id, "the known payout_batch_id belongs to a different sender_batch_id at PayPal"
        )
    return SubmitResult(known_payout_batch_id, sender_batch_id, "already_existed")


def _read_answer(
    http: PayPalHttp, response: PayPalResponse, sender_batch_id: str, known_payout_batch_id: str | None, ambiguous: bool
) -> SubmitResult:
    """submit_batch's reading of one answer below 500, by the rules in its docstring."""
    name = _error_name(response.body)
    if response.status == 201:
        payout_batch_id = _batch_id_if_ours(response.body, sender_batch_id)
        if payout_batch_id is None:
            raise SubmissionUnknown(
                sender_batch_id,
                "PayPal accepted the batch but its answer did not match the request",
                status=response.status,
                debug_id=response.debug_id,
            )
        return SubmitResult(payout_batch_id, sender_batch_id, "created")
    if response.status == 400 and _is_already_exists(response.body):
        if known_payout_batch_id is None:
            raise BatchExistsUnresolved(sender_batch_id, status=response.status, name=name, debug_id=response.debug_id)
        return _confirm_known(http, known_payout_batch_id, sender_batch_id)
    if not ambiguous and response.status in REFUSAL_STATUSES:
        raise PayPalError(response.status, name, response.debug_id)
    if 200 <= response.status < 300:
        reason = "unexpected success status from PayPal"
    elif ambiguous:
        reason = "PayPal refused after an earlier attempt may have reached it, so the refusal settles nothing"
    else:
        reason = "PayPal's answer does not show the batch was refused; resend with the same sender_batch_id"
    raise SubmissionUnknown(sender_batch_id, reason, status=response.status, name=name, debug_id=response.debug_id)


def submit_batch(
    http: PayPalHttp,
    snapshot: BatchSnapshot,
    *,
    known_payout_batch_id: str | None = None,
    after_ambiguity: bool = False,
    may_send: Callable[[], bool] | None = None,
) -> SubmitResult:
    """Send the snapshot as one Payouts batch, or confirm the batch it already became.

    Validates the snapshot first. Uses the snapshot's sender_batch_id as both the
    batch id and the PayPal-Request-Id. A timeout, connection error or 5xx is retried
    with the identical request at most twice (after 2 s, then 5 s). Before every POST
    the access token is fetched first, then may_send, when given, is called, so
    nothing but the send itself comes after it; if it returns False nothing is sent
    and SendBlocked is raised. A token fetch that fails counts as an attempt that
    got no clear answer, as it did when the fetch sat inside the POST.

    The outcome is ambiguous once any attempt for this sender_batch_id timed out,
    went unanswered or got a 5xx, in this call or, when after_ambiguity is True, in
    an earlier one. Returns outcome "created" on 201. When PayPal refuses a repeated
    sender_batch_id, returns "already_existed" only if known_payout_batch_id (from
    our ledger) is a batch PayPal reports under this same sender_batch_id; PayPal's
    error carries no usable link, so there is no other way to find the original.

    Raises BatchExistsUnresolved for that refusal when no known id is given (the
    batch exists; resolve its id from the webhook or Transaction Search, never
    resubmit under a different id); PayPalError only for a 400 or 422 while nothing
    is ambiguous, the one answer that proves no batch was created; SubmissionUnknown
    for every other answer, 401, 403 and 429 included, and for any answer at all
    once the outcome is ambiguous; SendBlocked as above; SnapshotRefused for a bad
    snapshot.
    """
    validate_snapshot(snapshot, http.config)
    sender_batch_id = sender_batch_id_for(snapshot)
    body = _payload(snapshot, sender_batch_id)
    headers = {"PayPal-Request-Id": sender_batch_id}

    ambiguous = after_ambiguity
    last: PayPalError | None = None
    for attempt in range(1 + len(RETRY_BACKOFF_SECONDS)):
        if attempt:
            _sleep(RETRY_BACKOFF_SECONDS[attempt - 1])
        try:
            # A token fetch can take up to 15 s. Done first, so the request below reuses
            # the cached token and may_send is the last step before the POST.
            http._bearer()
            if may_send is not None and not may_send():
                raise SendBlocked(sender_batch_id, ambiguous=ambiguous, attempts=attempt)
            response = http.request("POST", PAYOUTS_PATH, json_body=body, headers=headers)
        except PayPalUnreachable as exc:
            ambiguous, last = True, exc
            continue
        except PayPalError as exc:
            # No token, or an answer too large to read: neither proves PayPal created nothing.
            raise SubmissionUnknown(
                sender_batch_id, "no readable answer from PayPal", status=exc.status, name=exc.name, debug_id=exc.debug_id
            ) from None
        if response.status >= 500:
            ambiguous, last = True, PayPalError(response.status, _error_name(response.body), response.debug_id)
            continue
        return _read_answer(http, response, sender_batch_id, known_payout_batch_id, ambiguous)

    raise SubmissionUnknown(
        sender_batch_id,
        "no clear answer from PayPal after 3 attempts",
        status=last.status if last else None,
        name=last.name if last else None,
        debug_id=last.debug_id if last else None,
    )


def _get(http: PayPalHttp, path: str) -> dict:
    response = http.request("GET", path)
    if response.status != 200:
        raise PayPalError(response.status, _error_name(response.body), response.debug_id)
    return response.body


def get_batch(http: PayPalHttp, payout_batch_id: str) -> dict:
    """PayPal's current view of a batch. Raises PayoutIdRefused or PayPalError."""
    if type(payout_batch_id) is not str or not _PAYOUT_ID.fullmatch(payout_batch_id):
        raise PayoutIdRefused("payout_batch_id is malformed")
    return _get(http, f"{PAYOUTS_PATH}/{payout_batch_id}")


def get_item(http: PayPalHttp, payout_item_id: str) -> dict:
    """PayPal's current view of one payout item. Raises PayoutIdRefused or PayPalError."""
    if type(payout_item_id) is not str or not _PAYOUT_ID.fullmatch(payout_item_id):
        raise PayoutIdRefused("payout_item_id is malformed")
    return _get(http, f"{PAYOUT_ITEM_PATH}/{payout_item_id}")


def cancel_item(http: PayPalHttp, payout_item_id: str) -> str:
    """Ask PayPal to cancel one UNCLAIMED payout item, so its money returns to the shop.

    Sends POST /v1/payments/payouts-item/{id}/cancel once and never retries: PayPal
    cancels only while an item is UNCLAIMED, so after an unclear answer the ledger
    and the item's webhook settle what happened, not a second call. Returns the
    item's transaction_status from a 200 answer for this same item (PayPal documents
    RETURNED as the only value). Raises PayoutIdRefused for a malformed id before
    anything is sent, PayPalUnreachable on a timeout or connection failure, and
    PayPalError carrying the HTTP status for any other answer, a 200 included when
    it names another item or a status that is not one word of capital letters.
    """
    if type(payout_item_id) is not str or not _PAYOUT_ID.fullmatch(payout_item_id):
        raise PayoutIdRefused("payout_item_id is malformed")
    # PayPal's own sample sends an empty JSON object as the body.
    response = http.request("POST", f"{PAYOUT_ITEM_PATH}/{payout_item_id}/cancel", json_body={})
    if response.status != 200:
        raise PayPalError(response.status, _error_name(response.body), response.debug_id)
    status = response.body.get("transaction_status")
    if response.body.get("payout_item_id") != payout_item_id or not isinstance(status, str) or not _ITEM_STATUS.fullmatch(status):
        raise PayPalError(response.status, "UNREADABLE_CANCEL_ANSWER", response.debug_id)
    return status
