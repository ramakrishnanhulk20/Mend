"""Proves M4a on the demo shop's real records: python -m mend_engine.prove_m4a

Joins 40 demo members (the 40 quiet regulars most at risk on 2026-10-16, by their
synthetic shop emails) and one member who is no shop customer, scores the shop,
builds two campaign drafts, tries to break the draft rules, and has one member
leave. Prints PASS or FAIL per line and a final M4A RESULT line. It calls no
PayPal API and moves no money. The 40 demo members stay in place for M4b; every
campaign this run creates ends voided, and the non-customer member leaves.
"""

from __future__ import annotations

import json
import re
import sys
import uuid
from dataclasses import replace
from datetime import date
from decimal import Decimal
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from mend_engine.campaigns.drafts import DraftRefused, DraftSettings, build_draft, draft_view
from mend_engine.campaigns.eligibility import REGULAR_MIN_DAYS, SILENT_MIN_DAYS, quiet_regular_members
from mend_engine.campaigns.holdout import DEFAULT_HOLDOUT_SHARE, holdout_size
from mend_engine.campaigns.scoring import ScoreSet, paid_net_of_refunds, score_customers
from mend_engine.config import Config, ConfigError, load_config
from mend_engine.db.connect import connect
from mend_engine.db.migrate import migrate
from mend_engine.members.consent import CONSENT_VERSION, DEMO_SHOP_NAME, consent_hash, consent_text_for
from mend_engine.members.membership import (
    LEFT_REASON,
    VOIDABLE_STATUSES,
    MembershipRefused,
    join_member,
    leave_member,
    match_member_to_customer,
)
from mend_engine.paypal.payouts import normalise_email
from mend_engine.shop.identities import SYNTHETIC_DOMAIN

ENV_PATH = Path(__file__).resolve().parents[3] / ".env"
AS_OF = date(2026, 10, 16)
DEMO_MEMBERS = 40
# A reserved .example domain: it can never receive mail, and no shop customer has it.
OUTSIDER_EMAIL = "not-a-customer@mend.example"
GOAL = "Bring back our quiet regulars with a small thank-you"
RUN_VOID_REASON = "proof run finished"
ACTOR = "prove_m4a"
CHECKS = 10

_UUID_SHAPE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
_CUSTOMER_REF_SHAPE = re.compile(r"C[0-9]")


class Proof:
    def __init__(self) -> None:
        self.results: list[bool] = []

    def line(self, ok: bool, text: str) -> None:
        self.results.append(ok)
        print(f"[{'PASS' if ok else 'FAIL'}] {text}", flush=True)


def describe(exc: BaseException) -> str:
    # Database errors can quote row values, so only the engine's own messages are shown.
    if isinstance(exc, (DraftRefused, MembershipRefused, ConfigError)):
        return f"{type(exc).__name__}: {exc}"
    return type(exc).__name__


def demo_customers(scores: ScoreSet) -> list[str]:
    """The 40 quiet regulars most at risk, the same 40 on every run over the same records."""
    quiet = [
        ref
        for ref in scores.scores
        if scores.purchase_days[ref] >= REGULAR_MIN_DAYS and scores.days_silent[ref] >= SILENT_MIN_DAYS
    ]
    return sorted(quiet, key=lambda ref: (scores.scores[ref], ref))[:DEMO_MEMBERS]


def join_demo_members(conn: psycopg.Connection, config: Config, refs: list[str]) -> dict[uuid.UUID, str]:
    emails = dict(conn.execute("select customer_ref, email from shop_customers where customer_ref = any(%s)", (refs,)))
    return {join(conn, config, emails[ref]): ref for ref in refs}


def join(conn: psycopg.Connection, config: Config, email: str) -> uuid.UUID:
    return join_member(
        conn,
        paypal_email=email,
        paypal_payer_id=None,
        email_verified=True,
        shop_name=DEMO_SHOP_NAME,
        client_id=config.paypal_client_id,
    )


def roles(conn: psycopg.Connection, campaign_id: uuid.UUID) -> dict[uuid.UUID, str]:
    return dict(conn.execute("select member_id, role from campaign_members where campaign_id = %s", (campaign_id,)))


def check_members(proof: Proof, conn: psycopg.Connection, config: Config, demo: dict, outsider: uuid.UUID) -> None:
    digest = consent_hash(consent_text_for(DEMO_SHOP_NAME))
    rows = conn.execute(
        "select member_id, consent_version, consent_text_sha256, client_id from members where member_id = any(%s)",
        ([*demo, outsider],),
    ).fetchall()
    consented = [r for r in rows if r[1] == CONSENT_VERSION and r[2] == digest and r[3] == config.paypal_client_id]
    demo_count = sum(1 for r in consented if r[0] in demo)
    ok = len(demo) == demo_count == DEMO_MEMBERS and len(consented) == DEMO_MEMBERS + 1
    proof.line(ok, f"members: {demo_count} demo members joined with consent version {CONSENT_VERSION}")


def test_receiver_member(conn: psycopg.Connection, config: Config) -> uuid.UUID | None:
    """The verified member prove_m4b links to one quiet regular as the sandbox test receiver, if it exists yet."""
    if not config.test_receiver:
        return None
    row = conn.execute(
        "select member_id from members where paypal_email = %s and email_verified", (normalise_email(config.test_receiver),)
    ).fetchone()
    return row[0] if row else None


def check_eligible(
    proof: Proof, conn: psycopg.Connection, config: Config, scores: ScoreSet, demo: dict, outsider: uuid.UUID
) -> None:
    candidates = quiet_regular_members(conn, scores, AS_OF)
    ids = [c.member_id for c in candidates]
    # Refunds can cancel all a demo customer paid; such a member could be paid nothing, so is never eligible (C4).
    refunded_out = {m for m, ref in demo.items() if scores.paid_minor[ref] < 1}
    receiver = test_receiver_member(conn, config)
    allowed = set(demo) | ({receiver} if receiver else set())
    ok = (
        set(demo) - refunded_out <= set(ids)
        and not refunded_out & set(ids)
        and set(ids) <= allowed
        and outsider not in ids
        and match_member_to_customer(conn, outsider) is None
        and all(a.score <= b.score for a, b in zip(candidates, candidates[1:]))
        and all(
            scores.purchase_days[c.customer_ref] >= REGULAR_MIN_DAYS
            and scores.days_silent[c.customer_ref] >= SILENT_MIN_DAYS
            and c.paid_minor >= 1
            for c in candidates
        )
    )
    with_receiver = " (the verified test receiver among them)" if receiver in ids else ""
    proof.line(
        ok,
        f"eligible: {len(candidates)} quiet regular members{with_receiver}, most at risk first; "
        f"{len(refunded_out)} demo members whose refunds cancel what they paid are left out; "
        "the non-customer member is not eligible",
    )


def check_holdout(
    proof: Proof, conn: psycopg.Connection, first: uuid.UUID, first_roles: dict, second: uuid.UUID, settings: DraftSettings
) -> None:
    held = {m for m, role in first_roles.items() if role == "holdout"}
    count = len(first_roles)
    unpaid = conn.execute(
        "select count(*) from campaign_members where campaign_id = %s and role = 'holdout' "
        "and amount_minor is null and note is null",
        (first,),
    ).fetchone()[0]
    second_held = {m for m, role in roles(conn, second).items() if role == "holdout"}
    ok = (
        len(held) == holdout_size(count, settings.holdout_share) == unpaid
        and roles(conn, first) == first_roles
        and second_held != held
    )
    proof.line(
        ok,
        f"holdout: {len(held)} of {count} held back at random before any summary existed; "
        "the same campaign keeps the same holdout when read again",
    )


def check_amounts(proof: Proof, conn: psycopg.Connection, config: Config, campaign_id: uuid.UUID, settings: DraftSettings) -> None:
    rows = conn.execute(
        "select member_id, role, amount_minor from campaign_members where campaign_id = %s", (campaign_id,)
    ).fetchall()
    reward = [(m, amount) for m, role, amount in rows if role == "reward"]
    customer_of = {m: match_member_to_customer(conn, m) for m, _ in reward}
    # The cap on each reward is what the customer paid net of refunds, the one number the draft and approval both use (C4).
    paid = paid_net_of_refunds(conn, AS_OF, [ref for ref in customer_of.values() if ref])
    split = settings.budget_minor // len(reward) if reward else 0
    each_ok = all(
        customer_of[m] in paid
        and amount == min(settings.per_recipient_minor, config.item_cap_minor, split, paid[customer_of[m]])
        for m, amount in reward
    )
    holdout_ok = all(amount is None for _m, role, amount in rows if role == "holdout")
    total = sum(amount for _m, amount in reward)
    ok = bool(reward) and each_ok and holdout_ok and total <= settings.budget_minor
    proof.line(
        ok,
        "amounts: every reward at most min(per-recipient, item cap, budget split, what they paid); "
        "total <= budget; holdout members have no amount",
    )


def check_refusals(proof: Proof, conn: psycopg.Connection, config: Config, settings: DraftSettings) -> None:
    attempts = [
        (replace(settings, budget_minor=config.campaign_cap_minor + 1), "budget_over_cap"),
        (replace(settings, per_recipient_minor=config.item_cap_minor + 1), "per_recipient_over_cap"),
        (replace(settings, holdout_share=Decimal("0.6")), "holdout_share_out_of_range"),
        (replace(settings, goal_text="x" * 501), "goal_too_long"),
        (replace(settings, goal_text="Bring back\x07the regulars"), "goal_control_character"),
    ]
    before = conn.execute("select count(*) from campaigns").fetchone()[0]
    missed = []
    for attempt, reason in attempts:
        try:
            build_draft(conn, config, attempt)
            missed.append(f"{reason} was accepted")
        except DraftRefused as exc:
            if exc.reason != reason:
                missed.append(f"{reason} came back as {exc.reason}")
    stored = conn.execute("select count(*) from campaigns").fetchone()[0] - before
    tail = "" if not missed and stored == 0 else f" ({'; '.join(missed) or f'{stored} campaigns stored'})"
    proof.line(
        not missed and stored == 0,
        "refusals: over-budget, over item cap, holdout share 0.6, a 501-character goal, "
        "a goal with a control character, each refused with its reason" + tail,
    )


def check_view(proof: Proof, conn: psycopg.Connection, campaign_id: uuid.UUID) -> None:
    view = draft_view(conn, campaign_id)
    text = json.dumps(view)
    member_ids = [str(r[0]) for r in conn.execute("select member_id from campaign_members where campaign_id = %s", (campaign_id,))]
    ok = (
        bool(view)
        and all(set(row) == {"ref", "role", "rank", "amount_minor", "note"} for row in view)
        and "@" not in text
        and not _UUID_SHAPE.search(text)
        and not _CUSTOMER_REF_SHAPE.search(text)
        and not any(m in text for m in member_ids)
    )
    proof.line(ok, "view: draft_view exposes refs, roles, ranks, amounts and notes only (no email, member id or customer ref anywhere in it)")


def check_leave(proof: Proof, conn: psycopg.Connection, config: Config, campaign_id: uuid.UUID, demo: dict) -> dict:
    leaver = conn.execute(
        "select member_id from campaign_members where campaign_id = %s and rank = 1", (campaign_id,)
    ).fetchone()[0]
    email = conn.execute("select paypal_email from members where member_id = %s", (leaver,)).fetchone()[0]
    result = leave_member(conn, leaver)
    status = conn.execute("select status, void_reason from campaigns where campaign_id = %s", (campaign_id,)).fetchone()
    still_there = conn.execute(
        "select (select count(*) from members where member_id = %s), "
        "(select count(*) from campaign_members where member_id = %s)",
        (leaver, leaver),
    ).fetchone()
    audit = conn.execute(
        "select detail from audit_log where action = 'member_left' order by id desc limit 1"
    ).fetchone()
    ok = (
        result.removed
        and campaign_id in result.voided_campaigns
        and status == ("voided", LEFT_REASON)
        and still_there == (0, 0)
        and audit is not None
        and audit[0] == {"member_id": str(leaver)}
    )
    proof.line(
        ok,
        "leave: a member who leaves voids the draft that included them and is deleted; "
        "an audit row holds only their member id",
    )
    # They join again, as a new member, so M4b still finds all 40 demo members.
    ref = demo.pop(leaver)
    demo[join(conn, config, email)] = ref
    return demo


def check_c25(proof: Proof, conn: psycopg.Connection, config: Config) -> None:
    emails = [r[0] for r in conn.execute("select paypal_email from members")]
    # The sandbox test receiver is a PayPal sandbox account, not a person, so it is the one other allowed address.
    test_addresses = {OUTSIDER_EMAIL} | ({normalise_email(config.test_receiver)} if config.test_receiver else set())
    outside = [e for e in emails if not e.endswith("@" + SYNTHETIC_DOMAIN) and e not in test_addresses]
    proof.line(
        bool(emails) and not outside,
        f"C25: every member email in the database ends with @{SYNTHETIC_DOMAIN} or is one of the two test addresses "
        "(the non-customer and the sandbox test receiver)",
    )


def check_kept(proof: Proof, conn: psycopg.Connection, demo: dict) -> None:
    count = conn.execute("select count(*) from members where member_id = any(%s)", (list(demo),)).fetchone()[0]
    proof.line(count == DEMO_MEMBERS, f"kept: {count} demo members left in place for M4b")


def void_own(conn: psycopg.Connection, created: list[uuid.UUID]) -> None:
    if not created:
        return
    with conn.transaction():
        voided = conn.execute(
            "update campaigns set status = 'voided', void_reason = %s "
            "where campaign_id = any(%s) and status = any(%s) returning campaign_id",
            (RUN_VOID_REASON, created, list(VOIDABLE_STATUSES)),
        ).fetchall()
        for (campaign_id,) in voided:
            conn.execute(
                "insert into audit_log (actor, action, detail) values (%s, %s, %s)",
                (ACTOR, "campaign_voided", Jsonb({"campaign_id": str(campaign_id), "reason": RUN_VOID_REASON})),
            )


def run() -> bool:
    proof = Proof()
    try:
        config = load_config(str(ENV_PATH) if ENV_PATH.is_file() else None)
        migrate(config)
        conn = connect(config)
    except Exception as exc:
        proof.line(False, f"database: {describe(exc)}")
        return False
    created: list[uuid.UUID] = []
    with conn:
        try:
            scores = score_customers(conn, AS_OF)
            if not scores.converged:
                proof.line(False, f"scoring: {scores.message}")
                return False
            demo = join_demo_members(conn, config, demo_customers(scores))
            outsider = join(conn, config, OUTSIDER_EMAIL)
            check_members(proof, conn, config, demo, outsider)
            proof.line(True, f"scoring: BG/NBD converged on {len(scores.scores):,} shop customers as of {AS_OF}")
            check_eligible(proof, conn, config, scores, demo, outsider)

            settings = DraftSettings(
                goal_text=GOAL,
                as_of=AS_OF,
                budget_minor=min(5000, config.campaign_cap_minor),
                per_recipient_minor=min(300, config.item_cap_minor),
                holdout_share=DEFAULT_HOLDOUT_SHARE,
                max_candidates=DEMO_MEMBERS,
            )
            first = build_draft(conn, config, settings).campaign_id
            created.append(first)
            first_roles = roles(conn, first)
            second = build_draft(conn, config, settings).campaign_id
            created.append(second)
            check_holdout(proof, conn, first, first_roles, second, settings)
            check_amounts(proof, conn, config, first, settings)
            check_refusals(proof, conn, config, settings)
            check_view(proof, conn, first)
            demo = check_leave(proof, conn, config, first, demo)
            check_c25(proof, conn, config)
            leave_member(conn, outsider)
            check_kept(proof, conn, demo)
        finally:
            void_own(conn, created)
    return all(proof.results) and len(proof.results) == CHECKS


def main() -> int:
    try:
        passed = run()
    except Exception as exc:
        print(f"[FAIL] stopped: {describe(exc)}", flush=True)
        passed = False
    print(f"M4A RESULT: {'PASS' if passed else 'FAIL'}", flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
