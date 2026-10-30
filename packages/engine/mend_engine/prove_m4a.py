"""Proves M4a on the demo shop's real records: python -m mend_engine.prove_m4a

Joins the 40 demo stand-ins (the quiet regulars worth a nudge at ranks 2 to 41 on
2026-10-16, by the synthetic address each was given) and one stand-in who is no shop customer, all under
this script's own name, scores the shop, and shows who is eligible and who a running
measurement still holds. It drafts twice over the same members (a draft holds nobody),
approves the first and shows that approving the second is refused member_held, voids
and redraws until the random holdout differs, checks every amount against today's
caps, tries to break the draft rules,
and has one stand-in leave. Prints PASS or FAIL per line and a final M4A RESULT line.
It calls no PayPal API and moves no money. Run python -m mend_engine.seed_demo first,
so the stand-ins are labelled and on the current consent wording. The 40 stand-ins
stay in place for M4b; every campaign this run creates ends voided, and the
non-customer stand-in leaves.
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

from mend_engine.campaigns.approval import ApprovalRefused, approve, review_hash
from mend_engine.campaigns.drafts import DraftRefused, DraftSettings, build_draft, draft_view
from mend_engine.campaigns.eligibility import (
    REGULAR_MIN_DAYS,
    SILENT_MIN_DAYS,
    WORTH_A_NUDGE,
    Candidate,
    forecast_group,
    quiet_regular_members,
    sent_by_receiver,
    worth_a_nudge_refs,
)
from mend_engine.campaigns.holdout import DEFAULT_HOLDOUT_SHARE, holdout_size
from mend_engine.campaigns.scoring import ScoreSet, net_of_later_refunds, score_customers
from mend_engine.config import Config, ConfigError, load_config
from mend_engine.db.connect import connect
from mend_engine.db.migrate import migrate
from mend_engine.members.consent import CONSENT_VERSION, DEMO_SHOP_NAME, consent_hash, consent_text_for
from mend_engine.members.membership import (
    LEFT_REASON,
    SOURCE_SEED,
    VOIDABLE_STATUSES,
    MembershipRefused,
    customer_refs_by_email,
    join_member,
    leave_member,
    match_member_to_customer,
)
from mend_engine.paypal.payouts import normalise_email
from mend_engine.shop.identities import SYNTHETIC_DOMAIN, synthetic_email

ENV_PATH = Path(__file__).resolve().parents[3] / ".env"
AS_OF = date(2026, 10, 16)
DEMO_MEMBERS = 40
# A reserved .example domain: it can never receive mail, and no shop customer has it.
OUTSIDER_EMAIL = "not-a-customer@mend.example"
GOAL = "Bring back our quiet regulars with a small thank-you"
RUN_VOID_REASON = "proof run finished"
ACTOR = "prove_m4a"
CHECKS = 11
# A fixed holdout would match on every draw; a random one over even 2 members differs
# within 16 draws except about once in 65,000 runs.
MAX_REDRAWS = 16
# The owner's campaigns that hold their members, written out again from the rule rather
# than imported, so the eligibility check is compared with a second reading of it: from
# approval on, until voided, or for a sent one until 30 days after it was first sent
# (the first move to submitted, else the first batch row). Drafts hold nobody.
HELD_BY_OWNER_CAMPAIGNS = (
    "select distinct cm.member_id from campaign_members cm join campaigns c on c.campaign_id = cm.campaign_id "
    "left join campaign_owners o on o.campaign_id = c.campaign_id "
    "where cm.member_id is not null and o.role is distinct from 'demo' "
    "and c.status not in ('draft', 'awaiting_approval', 'voided') "
    "and (c.status not in ('submitted', 'completed') or coalesce(coalesce((select min(s.moved_at) from campaign_status_moves s "
    "where s.campaign_id = c.campaign_id and s.to_status = 'submitted'), (select min(b.created_at) from payout_batches b "
    "where b.campaign_id = c.campaign_id::text)) > now() - interval '30 days', true))"
)

_UUID_SHAPE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
_CUSTOMER_REF_SHAPE = re.compile(r"C[0-9]")


class Proof:
    def __init__(self) -> None:
        self.results: list[bool] = []

    def line(self, ok: bool, text: str) -> None:
        self.results.append(ok)
        print(f"[{'PASS' if ok else 'FAIL'}] {text}", flush=True)

    @staticmethod
    def note(text: str) -> None:
        print(f"       NOTE: {text}", flush=True)


def describe(exc: BaseException) -> str:
    # Database errors can quote row values, so only the engine's own messages are shown.
    if isinstance(exc, (ApprovalRefused, DraftRefused, MembershipRefused, ConfigError)):
        return f"{type(exc).__name__}: {exc}"
    return type(exc).__name__


def demo_customers(scores: ScoreSet) -> list[str]:
    """The 40 quiet regulars worth a nudge at ranks 2 to 41, biggest spenders first, the same 40 on every run over the same records.

    Rank 1 of worth_a_nudge_refs is kept for the sandbox receiver, which seed_demo
    links to it, so no stand-in ever holds the one row that can really claim a payout.
    """
    return worth_a_nudge_refs(scores)[1 : 1 + DEMO_MEMBERS]


def join_demo_members(conn: psycopg.Connection, config: Config, refs: list[str]) -> dict[uuid.UUID, str | None]:
    """The stand-ins for refs, joined by the synthetic address each was given, each mapped to the shop customer it matches now.

    The address is fixed by customer_ref, as seed_demo fixes it, so moving the test
    receiver first (which trades two shop emails) never puts the receiver on the list;
    the match is then read through the one email normaliser, as eligibility reads it.
    """
    emails = {join(conn, config, synthetic_email(ref)): synthetic_email(ref) for ref in refs}
    by_email = customer_refs_by_email(conn)
    return {member_id: by_email.get(normalise_email(email)) for member_id, email in emails.items()}


def join(conn: psycopg.Connection, config: Config, email: str, actor: str = ACTOR) -> uuid.UUID:
    # Joined under the script's own name, so each is a demo stand-in (source 'seed'), never a person's row.
    return join_member(
        conn,
        paypal_email=email,
        paypal_payer_id=None,
        email_verified=True,
        shop_name=DEMO_SHOP_NAME,
        client_id=config.paypal_client_id,
        actor=actor,
    )


def roles(conn: psycopg.Connection, campaign_id: uuid.UUID) -> dict[uuid.UUID, str]:
    return dict(conn.execute("select member_id, role from campaign_members where campaign_id = %s", (campaign_id,)))


def check_members(proof: Proof, conn: psycopg.Connection, config: Config, demo: dict, outsider: uuid.UUID) -> None:
    digest = consent_hash(consent_text_for(DEMO_SHOP_NAME))
    rows = conn.execute(
        "select member_id, consent_version, consent_text_sha256, client_id, source from members where member_id = any(%s)",
        ([*demo, outsider],),
    ).fetchall()
    consented = [
        r for r in rows if r[1] == CONSENT_VERSION and r[2] == digest and r[3] == config.paypal_client_id and r[4] == SOURCE_SEED
    ]
    demo_count = sum(1 for r in consented if r[0] in demo)
    ok = len(demo) == demo_count == DEMO_MEMBERS and len(consented) == DEMO_MEMBERS + 1
    proof.line(
        ok,
        f"members: {demo_count} demo stand-ins and the non-customer, each labelled seed under {ACTOR}, "
        f"on consent version {CONSENT_VERSION}",
    )
    if not ok:
        proof.note("a stand-in still on an earlier wording or unlabelled is fixed by running python -m mend_engine.seed_demo")


def held_members(conn: psycopg.Connection) -> set[uuid.UUID]:
    return {member_id for (member_id,) in conn.execute(HELD_BY_OWNER_CAMPAIGNS)}


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
) -> list[Candidate]:
    candidates = quiet_regular_members(conn, scores, AS_OF)
    ids = {c.member_id for c in candidates}
    held = held_members(conn)
    regular = {
        m: ref
        for m, ref in demo.items()
        if ref in scores.scores and scores.purchase_days[ref] >= REGULAR_MIN_DAYS and scores.days_silent[ref] >= SILENT_MIN_DAYS
    }
    # What each may still be paid: paid net of every refund, less rewards sent in 365 days (C4).
    paid = net_of_later_refunds(conn, scores, list(regular.values()))
    sent = sent_by_receiver(conn)
    email_of = dict(conn.execute("select member_id, paypal_email from members where member_id = any(%s)", (list(regular),)))
    no_room = {m for m, ref in regular.items() if m not in held and paid[ref] - sent.get(normalise_email(email_of[m]), 0) < 1}
    expected = set(regular) - held - no_room
    receiver = test_receiver_member(conn, config)
    ok = (
        expected <= ids
        and ids <= expected | ({receiver} if receiver else set())
        and not ids & held
        and outsider not in ids
        and match_member_to_customer(conn, outsider) is None
        and all(scores.paid_minor[a.customer_ref] >= scores.paid_minor[b.customer_ref] for a, b in zip(candidates, candidates[1:]))
        and all(
            scores.purchase_days[c.customer_ref] >= REGULAR_MIN_DAYS
            and scores.days_silent[c.customer_ref] >= SILENT_MIN_DAYS
            and forecast_group(scores.scores[c.customer_ref]) == WORTH_A_NUDGE
            and c.paid_minor >= 1
            for c in candidates
        )
    )
    with_receiver = " (the verified test receiver among them)" if receiver in ids else ""
    proof.line(
        ok,
        f"eligible: {len(candidates)} quiet regular members{with_receiver}, worth a nudge, biggest spenders first; "
        f"{len(held & set(demo))} demo stand-ins held by a running measurement and {len(no_room)} with nothing "
        "left to be paid are left out; the non-customer is not eligible",
    )
    return candidates


def check_one_at_a_time(proof: Proof, conn: psycopg.Connection, config: Config, settings: DraftSettings, first: uuid.UUID, created: list) -> None:
    """A draft holds nobody, so a second draft shares the first's members; once the first is approved the second is refused (C6)."""
    second = build_draft(conn, config, settings).campaign_id
    created.append(second)
    shared = set(roles(conn, second)) & set(roles(conn, first))
    approve(conn, first, approver=ACTOR, presented_hash=review_hash(conn, first), config=config)
    try:
        approve(conn, second, approver=ACTOR, presented_hash=review_hash(conn, second), config=config)
        outcome = "approved"
    except ApprovalRefused as refused:
        outcome = refused.reason
    status = conn.execute("select status from campaigns where campaign_id = %s", (second,)).fetchone()[0]
    ok = bool(shared) and outcome == "member_held" and status == "draft"
    proof.line(
        ok,
        f"one at a time: a second draft shares {len(shared)} members with the first; once the first is approved, "
        "approving the second is refused member_held" + ("" if ok else f" (got {outcome}, status {status})"),
    )


def check_holdout(
    proof: Proof, conn: psycopg.Connection, config: Config, settings: DraftSettings, first: uuid.UUID, first_roles: dict, created: list
) -> uuid.UUID:
    """Checks the first draft's holdout, voids it and redraws over the same members until the holdout differs; returns the redraw."""
    held = {m for m, role in first_roles.items() if role == "holdout"}
    count = len(first_roles)
    unpaid = conn.execute(
        "select count(*) from campaign_members where campaign_id = %s and role = 'holdout' "
        "and amount_minor is null and note is null",
        (first,),
    ).fetchone()[0]
    kept = roles(conn, first) == first_roles
    void_own(conn, [first])
    differs, same_members, draws, current = False, False, 0, first
    while draws < MAX_REDRAWS and not differs:
        draws += 1
        current = build_draft(conn, config, settings).campaign_id
        created.append(current)
        redrawn = roles(conn, current)
        same_members = set(redrawn) == set(first_roles)
        differs = same_members and {m for m, role in redrawn.items() if role == "holdout"} != held
        if not differs:
            void_own(conn, [current])
    ok = len(held) == holdout_size(count, settings.holdout_share) == unpaid and kept and differs
    proof.line(
        ok,
        f"holdout: {len(held)} of {count} held back at random before any summary existed; the same campaign "
        "keeps its holdout when read again; voided and drawn again over the same members, the holdout differs",
    )
    proof.note(f"the holdout differed on redraw {draws} of at most {MAX_REDRAWS}" if differs else f"no redraw of {draws} differed")
    return current


def check_amounts(
    proof: Proof, conn: psycopg.Connection, config: Config, campaign_id: uuid.UUID, settings: DraftSettings, candidates: list[Candidate]
) -> None:
    rows = conn.execute(
        "select member_id, role, amount_minor from campaign_members where campaign_id = %s", (campaign_id,)
    ).fetchall()
    reward = [(m, amount) for m, role, amount in rows if role == "reward"]
    # Each reward's own cap is what eligibility worked out for that member today (C4): paid net of
    # every refund on record, less, for the owner, what was sent to them in the last 365 days.
    room = {c.member_id: c.paid_minor for c in candidates}
    split = settings.budget_minor // len(reward) if reward else 0
    each_ok = all(
        m in room and amount == min(settings.per_recipient_minor, config.item_cap_minor, split, room[m]) for m, amount in reward
    )
    holdout_ok = all(amount is None for _m, role, amount in rows if role == "holdout")
    total = sum(amount for _m, amount in reward)
    ok = bool(reward) and each_ok and holdout_ok and total <= settings.budget_minor
    proof.line(
        ok,
        "amounts: every reward is min(per-recipient, item cap, budget split, what that member may still be paid: "
        "paid net of every refund, less rewards sent in 365 days); total <= budget; holdout members have no amount",
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
    # The first stand-in in the draft, never the test receiver, whose row may be a person's own.
    leaver = conn.execute(
        "select member_id from campaign_members where campaign_id = %s and member_id = any(%s) order by rank limit 1",
        (campaign_id, list(demo)),
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
            candidates = check_eligible(proof, conn, config, scores, demo, outsider)

            settings = DraftSettings(
                goal_text=GOAL,
                as_of=AS_OF,
                budget_minor=min(5000, config.campaign_cap_minor),
                per_recipient_minor=min(300, config.item_cap_minor),
                holdout_share=DEFAULT_HOLDOUT_SHARE,
                max_candidates=DEMO_MEMBERS,
            )
            try:
                first = build_draft(conn, config, settings).campaign_id
            except DraftRefused as refused:
                proof.line(False, f"draft: {refused.reason}; {len(candidates)} members are eligible and a draft needs 2")
                return False
            created.append(first)
            first_roles = roles(conn, first)
            check_one_at_a_time(proof, conn, config, settings, first, created)
            current = check_holdout(proof, conn, config, settings, first, first_roles, created)
            check_amounts(proof, conn, config, current, settings, candidates)
            check_refusals(proof, conn, config, settings)
            check_view(proof, conn, current)
            demo = check_leave(proof, conn, config, current, demo)
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
