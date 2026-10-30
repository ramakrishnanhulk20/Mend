"""Proves M4b on the demo shop and the live PayPal sandbox: python -m mend_engine.prove_m4b

Imports the shop's cancellations as refunds, shows an unverified member links to no
history, links the sandbox test receiver to one quiet regular as a verified member,
drafts a 3.00 USD campaign, tries three wrong approvals, approves it, tampers with a
second approved campaign, races 20 submits at the first, follows the one real batch
at PayPal, replays it, attacks the audit log and runs the 48-hour purge. Prints PASS
or FAIL per line and a final M4B RESULT line.

Real sandbox spend per run: at most 3.00 USD in payouts plus PayPal's fee per item.
The @shop.example receivers are not sandbox accounts, so their items stay UNCLAIMED
and PayPal returns them after 30 days. The test receiver stays a member, linked to
one shop customer's record by email, and later runs reuse that link.

Members this script joins are stand-ins under its own name (source 'seed'). A test
receiver with no member row becomes one; a row the receiver made itself through Log
in with PayPal is used as it is, and if it is on an earlier consent wording the run
stops and waits for the receiver to join again. A run within 30 days of the last
sent one finds the receiver held by that measurement and says so (C6).
"""

from __future__ import annotations

import re
import sys
import threading
import time as clock
import uuid
from dataclasses import replace
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import httpx
import psycopg
from psycopg.types.json import Jsonb

from mend_engine.campaigns.approval import (
    ApprovalRefused,
    EditRefused,
    approve,
    current_snapshot,
    frozen_snapshot,
    review_hash,
    set_amount,
)
from mend_engine.campaigns.drafts import DraftRefused, DraftSettings, build_draft
from mend_engine.campaigns.eligibility import quiet_regular_members, worth_a_nudge_refs
from mend_engine.campaigns.scoring import SHOP_ZONE, ScoreSet, score_customers
from mend_engine.campaigns.spend import CapExceeded, database_now, spent_last_24h_minor
from mend_engine.campaigns.submission import SubmissionResult, submit
from mend_engine.config import Config, ConfigError, load_config
from mend_engine.data.uci import CACHE_DIR, SourceError, ensure_source
from mend_engine.db.connect import connect
from mend_engine.db.migrate import migrate
from mend_engine.maintenance.purge import purge_paypal_events
from mend_engine.members.consent import ACCEPTED_CONSENT_VERSIONS, DEMO_SHOP_NAME
from mend_engine.members.membership import (
    SOURCE_SEED,
    MembershipRefused,
    customer_refs_by_email,
    join_member,
    leave_member,
    match_member_to_customer,
)
from mend_engine.money import MoneyError, to_minor
from mend_engine.paypal.http import PayPalError, PayPalHttp
from mend_engine.paypal.payouts import PAYOUTS_PATH, SnapshotRefused, SubmissionUnknown, get_batch, normalise_email
from mend_engine.shop.identities import SYNTHETIC_DOMAIN
from mend_engine.shop.import_orders import ImportRefused, import_refunds

ENV_PATH = Path(__file__).resolve().parents[3] / ".env"
AS_OF = date(2026, 10, 16)
GOAL = "Bring back our quiet regulars with a small thank-you"
BUDGET_MINOR = 300
PER_RECIPIENT_MINOR = 25
HOLDOUT_SHARE = Decimal("0.50")
MAX_CANDIDATES = 250
# The holdout is a fresh random draw for every draft (C6), so the test receiver is
# held back about half the time; such drafts are voided and drawn again.
MAX_DRAWS = 12
APPROVER = "owner"
ACTOR = "prove_m4b"
RACERS = 20
POLL_EVERY_SECONDS = 10
POLL_FOR_SECONDS = 180
HELD_BACK_REASON = "proof run: the test receiver was held back"
CHECKS = 11

_STATUS = re.compile(r"[A-Z_]{1,36}", re.ASCII)
_PAYOUT_ID = re.compile(r"[A-Z0-9]{1,32}", re.ASCII)
_DECIMAL = re.compile(r"[0-9]{1,12}(\.[0-9]{1,2})?", re.ASCII)


class Proof:
    def __init__(self) -> None:
        self.results: list[bool] = []

    def line(self, ok: bool, text: str) -> None:
        self.results.append(ok)
        print(f"[{'PASS' if ok else 'FAIL'}] {text}", flush=True)

    @staticmethod
    def note(text: str) -> None:
        print(f"       NOTE: {text}", flush=True)


class RequestTally:
    """Counts every HTTP request the engine makes to PayPal, across threads."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.requests = 0
        self.payout_posts = 0


class CountingTransport(httpx.BaseTransport):
    """A real HTTPS transport that counts each request before sending it."""

    def __init__(self, tally: RequestTally) -> None:
        self._inner = httpx.HTTPTransport()
        self._tally = tally

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        with self._tally.lock:
            self._tally.requests += 1
            if request.method == "POST" and request.url.path == PAYOUTS_PATH:
                self._tally.payout_posts += 1
        return self._inner.handle_request(request)

    def close(self) -> None:
        self._inner.close()


def counted_http(config: Config, tally: RequestTally) -> PayPalHttp:
    return PayPalHttp(config, transport=CountingTransport(tally))


def describe(exc: BaseException) -> str:
    # Database and HTTP errors can quote row values or URLs, so only the engine's own messages are shown.
    if isinstance(exc, SubmissionUnknown):
        return f"SubmissionUnknown: {exc.reason} (status={exc.status} name={exc.name} debug_id={exc.debug_id})"
    if isinstance(exc, PayPalError):
        return f"{type(exc).__name__} status={exc.status} name={exc.name} debug_id={exc.debug_id}"
    if isinstance(
        exc,
        (ApprovalRefused, EditRefused, DraftRefused, MembershipRefused, ConfigError, CapExceeded,
         SnapshotRefused, SourceError, ImportRefused, MoneyError),
    ):
        return f"{type(exc).__name__}: {exc}"
    return type(exc).__name__


def fee_cents(value: object) -> int | None:
    if not isinstance(value, str) or not _DECIMAL.fullmatch(value):
        return None
    try:
        return to_minor(value)
    except MoneyError:
        return None


def usd(minor: int) -> str:
    return f"{minor // 100:,}.{minor % 100:02d}"


def audit(conn: psycopg.Connection, action: str, detail: dict) -> None:
    with conn.transaction():
        conn.execute("insert into audit_log (actor, action, detail) values (%s, %s, %s)", (ACTOR, action, Jsonb(detail)))


def end_of_as_of() -> datetime:
    return datetime.combine(AS_OF + timedelta(days=1), time.min, tzinfo=SHOP_ZONE).astimezone(timezone.utc)


def check_refunds(proof: Proof, conn: psycopg.Connection) -> ScoreSet:
    path = ensure_source(CACHE_DIR)
    fingerprint = "select md5(string_agg(r.xmin::text || r::text, '|' order by r.refund_ref)) from shop_refunds r"
    first = import_refunds(conn, path)
    before = conn.execute(fingerprint).fetchone()[0]
    second = import_refunds(conn, path)
    unchanged = conn.execute(fingerprint).fetchone()[0] == before
    scores = score_customers(conn, AS_OF)
    # A second, separate sum of the same records, so the netting is checked against SQL, not against itself.
    end = end_of_as_of()
    expected = dict(
        conn.execute(
            "select o.customer_ref, greatest(o.paid - coalesce(r.refunded, 0), 0) from "
            "(select customer_ref, sum(total_minor) as paid from shop_orders where ordered_at < %s group by 1) o "
            "left join (select customer_ref, sum(amount_minor) as refunded from shop_refunds "
            "where refunded_at < %s group by 1) r using (customer_ref)",
            (end, end),
        )
    )
    gross = dict(conn.execute("select customer_ref, sum(total_minor) from shop_orders where ordered_at < %s group by 1", (end,)))
    lowered = sum(1 for ref, paid in scores.paid_minor.items() if paid < gross[ref])
    ok = (
        first.refunds > 0
        and second.inserted_refunds == 0
        and second.refunds == first.refunds
        and unchanged
        and scores.converged
        and scores.paid_minor == {ref: int(v) for ref, v in expected.items()}
        and lowered > 0
    )
    proof.line(ok, f"refunds: {first.refunds:,} cancellation records imported; paid amounts now net of refunds")
    proof.note(
        f"{first.inserted_refunds:,} new this run and {second.inserted_refunds} on the second import; "
        f"{first.unknown_customer} skipped as their customer has no shop record; "
        f"{usd(first.total_minor)} USD refunded in all; paid lowered for {lowered:,} customers"
    )
    return scores


def quiet_regulars(scores: ScoreSet) -> list[str]:
    return [ref for ref in worth_a_nudge_refs(scores) if scores.paid_minor[ref] >= PER_RECIPIENT_MINOR]


def unlinked_quiet_regular(conn: psycopg.Connection, scores: ScoreSet) -> str:
    by_email = customer_refs_by_email(conn)
    linked = {by_email.get(normalise_email(e)) for (e,) in conn.execute("select paypal_email from members")}
    for ref in quiet_regulars(scores):
        if ref not in linked:
            return ref
    raise LookupError("no quiet regular is free to link")


def check_verified(proof: Proof, conn: psycopg.Connection, config: Config, scores: ScoreSet) -> None:
    ref = unlinked_quiet_regular(conn, scores)
    email = conn.execute("select email from shop_customers where customer_ref = %s", (ref,)).fetchone()[0]
    member_id = join_member(
        conn, paypal_email=email, paypal_payer_id=None, email_verified=False,
        shop_name=DEMO_SHOP_NAME, client_id=config.paypal_client_id, actor=ACTOR,
    )
    try:
        linked = match_member_to_customer(conn, member_id)
        eligible = member_id in {c.member_id for c in quiet_regular_members(conn, scores, AS_OF)}
    finally:
        leave_member(conn, member_id)
    proof.line(
        linked is None and not eligible,
        "verified only: a member with an unverified PayPal email links to no history and is never eligible",
    )


def link_test_receiver(conn: psycopg.Connection, config: Config, scores: ScoreSet) -> uuid.UUID | None:
    """The test receiver's member id, linked to one quiet regular; None while its own row is on an earlier wording.

    With no member row, the receiver is joined as a stand-in under this script's name.
    A stand-in row is joined again, which brings it to the current wording. A row the
    receiver made through Log in with PayPal is never changed here: on an accepted
    wording it is used as it is, on an earlier one only the receiver can agree again.
    """
    receiver = normalise_email(config.test_receiver or "")
    row = conn.execute("select customer_ref from shop_customers where email = %s", (receiver,)).fetchone()
    if row is None:
        ref = unlinked_quiet_regular(conn, scores)
        with conn.transaction():
            conn.execute("update shop_customers set email = %s where customer_ref = %s", (receiver, ref))
            conn.execute(
                "insert into audit_log (actor, action, detail) values (%s, %s, %s)",
                (ACTOR, "shop_customer_linked_to_sandbox_receiver", Jsonb({"customer_ref": ref})),
            )
    member_id = join_member(
        conn, paypal_email=receiver, paypal_payer_id=None, email_verified=True,
        shop_name=DEMO_SHOP_NAME, client_id=config.paypal_client_id, actor=ACTOR,
    )
    source, version = conn.execute("select source, consent_version from members where member_id = %s", (member_id,)).fetchone()
    if source != SOURCE_SEED and version not in ACCEPTED_CONSENT_VERSIONS:
        return None
    return member_id


def receiver_unavailable(conn: psycopg.Connection, scores: ScoreSet, receiver_id: uuid.UUID) -> str | None:
    """Why the test receiver cannot be drafted for the owner now, or None when it can."""
    if receiver_id in {c.member_id for c in quiet_regular_members(conn, scores, AS_OF)}:
        return None
    # Drafts hold nobody; first sent is the first move to submitted, else the first batch row, as eligibility reads it.
    unsent, closes = conn.execute(
        "select bool_or(sent is null), max(sent + interval '30 days') from (select coalesce((select min(s.moved_at) "
        "from campaign_status_moves s where s.campaign_id = c.campaign_id and s.to_status = 'submitted'), "
        "(select min(b.created_at) from payout_batches b where b.campaign_id = c.campaign_id::text)) as sent "
        "from campaign_members cm join campaigns c using (campaign_id) left join campaign_owners o using (campaign_id) "
        "where cm.member_id = %s and c.status not in ('voided', 'draft', 'awaiting_approval') and o.role is distinct from 'demo') held",
        (receiver_id,),
    ).fetchone()
    if unsent:
        return "the test receiver is held by an approved owner campaign not yet sent, which holds it until voided"
    if closes is not None and closes > database_now(conn):
        return f"the test receiver is held by a running measurement until {closes.astimezone(timezone.utc):%Y-%m-%d %H:%M} UTC"
    return "the test receiver is not an eligible quiet regular (unlinked, or nothing left to be paid)"


def settings() -> DraftSettings:
    return DraftSettings(
        goal_text=GOAL,
        as_of=AS_OF,
        budget_minor=BUDGET_MINOR,
        per_recipient_minor=PER_RECIPIENT_MINOR,
        holdout_share=HOLDOUT_SHARE,
        max_candidates=MAX_CANDIDATES,
    )


def void_draft(conn: psycopg.Connection, campaign_id: uuid.UUID, reason: str) -> None:
    with conn.transaction():
        voided = conn.execute(
            "update campaigns set status = 'voided', void_reason = %s where campaign_id = %s and status = 'draft' returning 1",
            (reason, campaign_id),
        ).fetchone()
        if voided:
            conn.execute(
                "insert into audit_log (actor, action, detail) values (%s, %s, %s)",
                (ACTOR, "campaign_voided", Jsonb({"campaign_id": str(campaign_id), "reason": reason})),
            )


def left_member_refusal(conn: psycopg.Connection, config: Config, receiver_id: uuid.UUID, created: list) -> str:
    """Drafts a campaign, has one rewarded member leave, and returns the reason approval gave."""
    campaign_id = build_draft(conn, config, settings()).campaign_id
    created.append(campaign_id)
    shown = review_hash(conn, campaign_id)
    # A stand-in, never the receiver or a person who joined, since it leaves and is joined again as a stand-in.
    leaver = conn.execute(
        "select cm.member_id from campaign_members cm join members m using (member_id) where cm.campaign_id = %s "
        "and cm.role = 'reward' and cm.member_id <> %s and m.source = %s order by cm.rank limit 1",
        (campaign_id, receiver_id, SOURCE_SEED),
    ).fetchone()[0]
    email = conn.execute("select paypal_email from members where member_id = %s", (leaver,)).fetchone()[0]
    leave_member(conn, leaver)
    try:
        approve(conn, campaign_id, approver=APPROVER, presented_hash=shown, config=config)
        reason = "approved"
    except ApprovalRefused as refused:
        reason = refused.reason
    # They join again as a new member, so the demo keeps its 40 members.
    join_member(
        conn, paypal_email=email, paypal_payer_id=None, email_verified=True,
        shop_name=DEMO_SHOP_NAME, client_id=config.paypal_client_id, actor=ACTOR,
    )
    return reason


def draft_main(proof: Proof, conn: psycopg.Connection, config: Config, receiver_id: uuid.UUID, created: list) -> uuid.UUID | None:
    held_back = 0
    for _draw in range(MAX_DRAWS):
        result = build_draft(conn, config, settings())
        created.append(result.campaign_id)
        role = conn.execute(
            "select role from campaign_members where campaign_id = %s and member_id = %s", (result.campaign_id, receiver_id)
        ).fetchone()
        if role == ("reward",):
            ok = result.total_minor <= BUDGET_MINOR and result.rewarded >= 1 and result.held_back >= 1
            proof.line(
                ok,
                f"draft: campaign {result.campaign_id} with {result.rewarded} rewarded and {result.held_back} "
                f"held back, total {usd(result.total_minor)} USD",
            )
            proof.note(
                f"the holdout is a fresh random draw for each draft; the test receiver was held back in "
                f"{held_back} earlier draws this run, and those drafts were voided"
            )
            return result.campaign_id
        held_back += 1
        void_draft(conn, result.campaign_id, HELD_BACK_REASON)
    proof.line(False, f"draft: the test receiver was held back in all {MAX_DRAWS} draws")
    return None


def check_refusals(proof: Proof, conn: psycopg.Connection, config: Config, campaign_id: uuid.UUID, left_reason: str) -> None:
    real = review_hash(conn, campaign_id)
    wrong = real[:-1] + ("0" if real[-1] != "0" else "1")
    reasons = []
    try:
        approve(conn, campaign_id, approver=APPROVER, presented_hash=wrong, config=config)
        reasons.append("approved")
    except ApprovalRefused as refused:
        reasons.append(refused.reason)
    total = sum(item.amount_minor for item in current_snapshot(conn, campaign_id).items)
    spent = spent_last_24h_minor(conn, database_now(conn))
    tight = replace(config, daily_cap_minor=spent + total - 1)
    try:
        approve(conn, campaign_id, approver=APPROVER, presented_hash=real, config=tight)
        reasons.append("approved")
    except ApprovalRefused as refused:
        reasons.append(refused.reason)
    status = conn.execute("select status from campaigns where campaign_id = %s", (campaign_id,)).fetchone()[0]
    ok = reasons == ["hash_mismatch", "over_daily_cap"] and left_reason == "voided" and status == "draft"
    proof.line(ok, "approval refused: wrong presented hash; a recipient who left; a budget over the daily cap")
    proof.note(
        f"reasons given: {reasons[0]}, {left_reason} (leaving voided that draft), {reasons[1]}; for the cap check "
        f"the cap was set to {tight.daily_cap_minor} cents, 1 below the {spent} spent in the last 24 hours plus this "
        f"campaign's {total}"
    )


def check_approval(proof: Proof, conn: psycopg.Connection, config: Config, campaign_id: uuid.UUID) -> bool:
    approval = approve(conn, campaign_id, approver=APPROVER, presented_hash=review_hash(conn, campaign_id), config=config)
    stored = conn.execute(
        "select c.status, s.snapshot_hash, s.approved_by from campaigns c join approved_snapshots s using (campaign_id) "
        "where campaign_id = %s",
        (campaign_id,),
    ).fetchone()
    ok = stored == ("approved", approval.snapshot_hash, APPROVER)
    proof.line(ok, f"approval: approved with hash {approval.snapshot_hash[:12]}")
    return ok


def check_tamper(proof: Proof, conn: psycopg.Connection, config: Config, created: list) -> None:
    campaign_id = build_draft(conn, config, settings()).campaign_id
    created.append(campaign_id)
    approve(conn, campaign_id, approver=APPROVER, presented_hash=review_hash(conn, campaign_id), config=config)
    ref, amount = conn.execute(
        "select ref, amount_minor from campaign_members where campaign_id = %s and role = 'reward' order by rank limit 1",
        (campaign_id,),
    ).fetchone()
    before = conn.execute("select * from campaign_members where campaign_id = %s order by rank", (campaign_id,)).fetchall()
    refused = False
    try:
        with conn.transaction():
            conn.execute(
                "update campaign_members set amount_minor = amount_minor + 1 where campaign_id = %s and ref = %s",
                (campaign_id, ref),
            )
    except psycopg.errors.RaiseException:
        refused = True
    after = conn.execute("select * from campaign_members where campaign_id = %s order by rank", (campaign_id,)).fetchall()
    edit = set_amount(conn, campaign_id, ref, max(amount - 1, 1), config)
    tally = RequestTally()
    http = counted_http(config, tally)
    try:
        result = submit(conn, http, campaign_id, config)
    finally:
        http.close()
    ok = (
        refused
        and after == before
        and (edit.status, edit.applied) == ("voided", False)
        and (result.status, result.sent) == ("voided", False)
        and tally.requests == 0
    )
    proof.line(ok, "tamper: editing an amount after approval is refused by the database trigger and the campaign is not paid")
    proof.note(
        f"campaign {campaign_id}: the edit through set_amount voided it ({edit.status}); submit sent "
        f"{tally.requests} requests"
    )


def check_race(proof: Proof, config: Config, campaign_id: uuid.UUID) -> SubmissionResult | None:
    tally = RequestTally()
    connections = [connect(config) for _ in range(RACERS)]
    start = threading.Barrier(RACERS)
    results: list[SubmissionResult] = []
    errors: list[str] = []
    lock = threading.Lock()

    def run(conn: psycopg.Connection) -> None:
        http = counted_http(config, tally)
        try:
            start.wait()
            result = submit(conn, http, campaign_id, config)
            with lock:
                results.append(result)
        except Exception as exc:
            with lock:
                errors.append(describe(exc))
        finally:
            http.close()

    threads = [threading.Thread(target=run, args=(c,)) for c in connections]
    try:
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=120)
    finally:
        for conn in connections:
            conn.close()
    winners = [r for r in results if r.sent]
    ok = len(results) == RACERS and not errors and tally.payout_posts == 1 and len(winners) == 1
    if ok:
        proof.line(True, f"race: {RACERS} concurrent submit calls on separate connections sent exactly 1 Payouts request")
    else:
        proof.line(
            False,
            f"race: {len(results)} of {RACERS} calls returned, {tally.payout_posts} Payouts requests, "
            f"{len(winners)} sent; errors: {'; '.join(errors) or 'none'}",
        )
    return winners[0] if len(winners) == 1 else None


def check_payout(proof: Proof, conn: psycopg.Connection, http: PayPalHttp, campaign_id: uuid.UUID, sent: SubmissionResult) -> None:
    snap = frozen_snapshot(conn, campaign_id)
    receiver_of = {item.sender_item_id: item.receiver_email for item in snap.items}
    amount_total = sum(item.amount_minor for item in snap.items)
    test_ref = next(ref for ref, email in receiver_of.items() if not email.endswith("@" + SYNTHETIC_DOMAIN))
    payout_batch_id = sent.payout_batch_id
    deadline = clock.monotonic() + POLL_FOR_SECONDS
    statuses: dict[str, str] = {}
    fees = 0
    while True:
        batch = get_batch(http, payout_batch_id)
        statuses, fees = {}, 0
        for entry in batch.get("items") or []:
            payout_item = entry.get("payout_item") if isinstance(entry, dict) else None
            item_id = entry.get("payout_item_id") if isinstance(entry, dict) else None
            if not isinstance(payout_item, dict) or not isinstance(item_id, str) or not _PAYOUT_ID.fullmatch(item_id):
                continue
            ref = payout_item.get("sender_item_id")
            raw = entry.get("transaction_status")
            status = raw if isinstance(raw, str) and _STATUS.fullmatch(raw) else "UNKNOWN"
            if ref not in receiver_of:
                continue
            statuses[ref] = status
            fee = entry.get("payout_item_fee") or {}
            value = fee.get("value") if isinstance(fee, dict) else None
            fee_minor = fee_cents(value)
            fees += fee_minor or 0
            with conn.transaction():
                conn.execute(
                    "insert into payout_items (payout_item_id, sender_batch_id, sender_item_id, status, fee_minor) "
                    "values (%s, %s, %s, %s, %s) on conflict (payout_item_id) do update set "
                    "status = excluded.status, fee_minor = excluded.fee_minor, updated_at = now()",
                    (item_id, sent.sender_batch_id, ref, status, fee_minor),
                )
        settled = len(statuses) == len(receiver_of) and not any(s in ("PENDING", "UNKNOWN") for s in statuses.values())
        if settled or clock.monotonic() + POLL_EVERY_SECONDS > deadline:
            break
        clock.sleep(POLL_EVERY_SECONDS)
    good = sum(1 for s in statuses.values() if s in ("SUCCESS", "PENDING"))
    unclaimed = [ref for ref, s in statuses.items() if s == "UNCLAIMED"]
    ok = (
        len(statuses) == len(receiver_of)
        and good + len(unclaimed) == len(statuses)
        and statuses.get(test_ref) in ("SUCCESS", "PENDING")
        and all(receiver_of[ref].endswith("@" + SYNTHETIC_DOMAIN) for ref in unclaimed)
    )
    proof.line(
        ok,
        f"payout: batch {payout_batch_id} created; items: {good} SUCCESS or PENDING, {len(unclaimed)} UNCLAIMED "
        f"expected for @{SYNTHETIC_DOMAIN} receivers",
    )
    proof.note(
        f"test receiver's item {statuses.get(test_ref, 'missing')}; sandbox spend {usd(amount_total)} USD in payouts "
        f"plus {usd(fees)} USD PayPal fees on {len(statuses)} items"
    )
    audit(conn, "payout_status", {"payout_batch_id": payout_batch_id, "items": len(statuses), "unclaimed": len(unclaimed), "fees_minor": fees})


def check_replay(proof: Proof, conn: psycopg.Connection, config: Config, campaign_id: uuid.UUID, sent: SubmissionResult) -> None:
    tally = RequestTally()
    http = counted_http(config, tally)
    try:
        again = submit(conn, http, campaign_id, config)
    finally:
        http.close()
    ok = (
        (again.status, again.sent, again.payout_batch_id, again.sender_batch_id)
        == ("submitted", False, sent.payout_batch_id, sent.sender_batch_id)
        and tally.requests == 0
    )
    proof.line(ok, "replay: submitting the same campaign again sends nothing and reports submitted")


def check_audit(proof: Proof, conn: psycopg.Connection, first_id: int) -> None:
    target = conn.execute("select max(id) from audit_log").fetchone()[0]
    refused = []
    for verb, statement in (
        ("UPDATE", "update audit_log set detail = detail where id = %s"),
        ("DELETE", "delete from audit_log where id = %s"),
    ):
        try:
            with conn.transaction():
                conn.execute(statement, (target,))
        except psycopg.errors.RaiseException:
            refused.append(verb)
    written, with_at = conn.execute(
        "select count(*), count(*) filter (where position('@' in actor || action || detail::text) > 0) "
        "from audit_log where id > %s",
        (first_id,),
    ).fetchone()
    ok = refused == ["UPDATE", "DELETE"] and written > 0 and with_at == 0
    proof.line(ok, f"audit: UPDATE and DELETE on audit_log refused; the run wrote {written} audit rows, none containing an @")


def check_purge(proof: Proof, conn: psycopg.Connection, run_id: str) -> None:
    old, new = f"prove-m4b-{run_id}-49h", f"prove-m4b-{run_id}-47h"
    with conn.transaction():
        for name, hours in ((old, 49), (new, 47)):
            conn.execute(
                "insert into paypal_events (transmission_id, event_id, event_type, received_at, purge_after, raw) "
                "values (%s, %s, 'MEND.PROOF.PURGE', now() - make_interval(hours => %s), "
                "now() - make_interval(hours => %s) + interval '48 hours', '{}')",
                (name, name, hours, hours),
            )
    deleted = purge_paypal_events(conn)
    present = {r[0] for r in conn.execute("select transmission_id from paypal_events where transmission_id = any(%s)", ([old, new],))}
    stale = conn.execute("select count(*) from paypal_events where received_at < now() - interval '48 hours'").fetchone()[0]
    with conn.transaction():
        conn.execute("delete from paypal_events where transmission_id = %s", (new,))
    ok = present == {new} and deleted >= 1 and stale == 0
    proof.line(ok, "purge: rows past purge_after deleted, rows inside 48 hours kept")
    proof.note(f"{deleted} rows deleted this run; no stored PayPal payload is older than 48 hours; the 47-hour test row was then removed")


def run() -> bool:
    proof = Proof()
    run_id = uuid.uuid4().hex[:12]
    try:
        config = load_config(str(ENV_PATH) if ENV_PATH.is_file() else None)
        if not config.test_receiver:
            raise ConfigError("MEND_TEST_RECEIVER is not set")
        migrate(config)
        conn = connect(config)
    except Exception as exc:
        proof.line(False, f"database: {describe(exc)}")
        return False
    http = PayPalHttp(config)
    created: list[uuid.UUID] = []
    with conn:
        first_id = conn.execute("select coalesce(max(id), 0) from audit_log").fetchone()[0]
        try:
            scores = check_refunds(proof, conn)
            check_verified(proof, conn, config, scores)
            receiver_id = link_test_receiver(conn, config, scores)
            if receiver_id is None:
                proof.line(False, "receiver: waiting for the test customer to join again under the current consent")
                return False
            unavailable = receiver_unavailable(conn, scores, receiver_id)
            if unavailable is not None:
                proof.line(False, f"receiver: {unavailable}")
                return False
            left_reason = left_member_refusal(conn, config, receiver_id, created)
            # Before the main draft: a member is in one draft at a time (C6), and the edit voids
            # this campaign, so its members are free again for the main one.
            check_tamper(proof, conn, config, created)
            campaign_id = draft_main(proof, conn, config, receiver_id, created)
            if campaign_id is None:
                return False
            check_refusals(proof, conn, config, campaign_id, left_reason)
            if not check_approval(proof, conn, config, campaign_id):
                return False
            sent = check_race(proof, config, campaign_id)
            if sent is None or sent.status != "submitted" or sent.payout_batch_id is None:
                proof.line(False, f"payout: no batch was created ({sent.status if sent else 'no winner'})")
            else:
                check_payout(proof, conn, http, campaign_id, sent)
                check_replay(proof, conn, config, campaign_id, sent)
            check_audit(proof, conn, first_id)
            check_purge(proof, conn, run_id)
        except Exception as exc:
            proof.line(False, f"stopped: {describe(exc)}")
            return False
        finally:
            for campaign_id in created:
                void_draft(conn, campaign_id, "proof run finished")
            http.close()
    return all(proof.results) and len(proof.results) == CHECKS


def main() -> int:
    try:
        passed = run()
    except Exception as exc:
        print(f"[FAIL] stopped: {describe(exc)}", flush=True)
        passed = False
    print(f"M4B RESULT: {'PASS' if passed else 'FAIL'}", flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
