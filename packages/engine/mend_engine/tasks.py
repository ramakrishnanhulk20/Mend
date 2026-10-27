"""The engine's front door: one plain function per job the web console or the scheduler can start.

The engine service on Render's private network and the local dev bridge both reach
these functions through task_server.py, and through nothing else; the cron job reaches
the scheduled ones through jobs.py. Every argument arrives as JSON from the web app, so
each task checks the shape of what it is given before anything is read, opens its
own config and database connection, and returns a JSON-safe dict:
{"ok": True, ...} on success, or {"ok": False, "error": <fixed code>, "ref": <id>}
on any refusal or failure. The detail of a failure goes only to the server log
under that ref, with secrets removed (C26, C17).

Two roles act here (C18, C20). The owner works under the deployment's caps. A demo
visitor works under fixed, tighter caps written below, and only ever on campaigns
its own session created (C19); a campaign it did not create is "not_found", the
same answer as one that does not exist, so nothing about it leaks.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
import traceback
import uuid
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import replace
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from time import monotonic, sleep
from urllib.parse import urlsplit

import psycopg
from psycopg.types.json import Jsonb

from mend_engine.campaigns import simulate
from mend_engine.campaigns.approval import (
    OPEN_STATUSES,
    ApprovalRefused,
    EditRefused,
    approve,
    frozen_snapshot,
    review_hash,
)
from mend_engine.campaigns.approval import set_note as set_campaign_note
from mend_engine.campaigns.cancel import cancel_unclaimed as cancel_unclaimed_items
from mend_engine.campaigns.drafts import NOTE_TEMPLATE, DraftRefused, DraftSettings, build_draft, draft_view
from mend_engine.campaigns.eligibility import REGULAR_MIN_DAYS, SILENT_MIN_DAYS
from mend_engine.campaigns.reconcile import reconcile as reconcile_campaigns
from mend_engine.campaigns.results import ArmResults, PayoutStanding, campaign_results
from mend_engine.campaigns.scoring import SHOP_ZONE, ScoreSet, score_customers
from mend_engine.campaigns.spend import CAMPAIGN_VOIDED_SQL, ITEM_CAME_BACK_SQL, MONEY_BACK_STATUSES, WINDOW, CapExceeded
from mend_engine.campaigns.submission import submit
from mend_engine.config import Config, ConfigError, load_config
from mend_engine.db.connect import connect
from mend_engine.events.process import process_events as process_stored_events
from mend_engine.maintenance.purge import purge_paypal_events
from mend_engine.members.consent import DEMO_SHOP_NAME, consent_hash, consent_text_for
from mend_engine.members.membership import (
    MembershipRefused,
    customer_refs_by_email,
    join_member,
    leave_member,
    match_member_to_customer,
)
from mend_engine.paypal.balances import BalanceTooLow
from mend_engine.paypal.http import PayPalError, PayPalHttp
from mend_engine.paypal.payouts import SnapshotRefused, normalise_email, note_problem
from mend_engine.store_facts import CDNOW_KEY, UCI_KEY, read_facts

ENV_PATH = Path(__file__).resolve().parents[3] / ".env"

# Every task a caller may start, by name. The dev bridge and main.py register exactly these.
TASK_NAMES = (
    "draft_campaign",
    "view_campaign",
    "approve_campaign",
    "submit_campaign",
    "simulate_return",
    "results",
    "shop_summary",
    "quiet_regulars",
    "process_events",
    "reconcile",
    "purge",
    "draft_limits",
    "note_context",
    "set_note",
    "request_approval",
    "consent_text",
    "join",
    "leave",
    "cancel_unclaimed",
)

ROLES = ("owner", "demo")
# Demo caps, in USD cents. Fixed in code so no setting, request or session can loosen
# them, and never looser than the owner's caps from config.
DEMO_ITEM_CAP_MINOR = 200
DEMO_CAMPAIGN_CAP_MINOR = 1000
DEMO_DAILY_CAP_MINOR = 5000
DEMO_CAMPAIGNS_PER_SESSION_PER_DAY = 5
DEMO_SUBMITS_PER_SESSION_PER_DAY = 2
# Scoring and drafting cost grows with the candidates asked for; the owner keeps build_draft's 2 to 250.
DEMO_MAX_CANDIDATES = 20
# Refusal codes that mean a limit was hit. Each one writes a "limit_hit" audit row (C20, C23).
LIMIT_CODES = frozenset({"limit_reached", "over_cap", "low_balance", "over_demo_daily_cap"})
# Must match the web app's idle limit (packages/web/src/server/sessions.ts), so a
# session the web app would refuse is refused here too.
SESSION_IDLE = timedelta(hours=2)

# Lock keys. The two-number form keeps one lock per demo session for drafting; the
# single number serialises demo submissions, so two cannot both fit under the demo pool
# or both be a session's second send of the day.
DRAFT_LOCK_CLASS = 773131
DEMO_SPEND_LOCK = 7731300005
# A demo send that cannot take the spend lock in this long answers "busy" (C20): a
# send stuck on a slow PayPal must not hold every other visitor's send for ever.
DEMO_SPEND_WAIT_SECONDS = 10.0
DEMO_SPEND_POLL_SECONDS = 0.2
# Module-level so tests can replace the wait without a real 10 second pause.
_sleep = sleep
_monotonic = monotonic

MAX_LOG_DETAIL_CHARS = 4000
MAX_QUIET_REGULARS = 50
SUMMARY_CURRENCY = "USD"
# What a note may be written from (C15): a few recent item names, cut short, and how
# long since the customer last ordered. More names are read than kept because some
# are dropped by the note rule.
NOTE_CONTEXT_ITEMS = 5
NOTE_ITEM_SCAN = 25
MAX_ITEM_NAME_CHARS = 60

_SESSION_ID = re.compile(r"[0-9a-f]{64}", re.ASCII)
_CAMPAIGN_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.ASCII)
_ISO_DAY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", re.ASCII)
_SHARE = re.compile(r"0\.[0-9]{1,2}", re.ASCII)
_REF = re.compile(r"R[1-9][0-9]{0,3}", re.ASCII)
_CODE = re.compile(r"[a-z][a-z_]{0,63}", re.ASCII)
_INSERT_AUDIT = "insert into audit_log (actor, action, detail) values (%s, %s, %s)"
_SETTINGS_KEYS = frozenset({"goal_text", "as_of", "budget_minor", "per_recipient_minor", "holdout_share", "max_candidates"})
_ACTOR_KEYS = frozenset({"role", "session"})
# What the web app passes on from Log in with PayPal, and nothing else (PLAN.md 3a).
_IDENTITY_KEYS = frozenset({"email", "email_verified", "payer_id"})
MAX_IDENTITY_EMAIL_CHARS = 254
# PayPal documents payer ids as 13 characters; real ones are upper-case letters and digits.
_PAYER_ID = re.compile(r"[A-Z0-9]{13}", re.ASCII)
# MembershipRefused reasons to this module's codes. A reason missing here is unexpected and fails as "internal".
_MEMBERSHIP_CODES = {"not_payable": "not_payable", "identity_conflict": "identity_conflict", "bad_input": "bad_identity"}
_MEMBERSHIP_DETAILS = {
    "not_payable": "the PayPal email is not an address PayPal can pay",
    "identity_conflict": "this email or PayPal account already belongs to a different member",
    "bad_identity": "the membership rules refused the identity",
}
_LOG_HEX = re.compile(r"\b[0-9a-f]{64}\b")
_LOG_COOKIE = re.compile(r"s1\.[A-Za-z0-9_-]{20,}")
# The same email shape the web app removes before text reaches the model (packages/web/src/server/claude.ts).
_LOG_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
_SECRET_ENV_NAMES = (
    "PAYPAL_CLIENT_SECRET",
    "PAYPAL_CLIENT_ID",
    "DATABASE_URL",
    "MEND_OWNER_PASSWORD",
    "MEND_BRIDGE_TOKEN",
    "MEND_ENGINE_TOKEN",
    "RENDER_API_KEY",
)
# The role of the actor the running task checked, so a refusal raised anywhere below
# it, in this module or another, is recorded against the right role. _run resets it.
_ACTING_ROLE: ContextVar[str | None] = ContextVar("mend_acting_role", default=None)


class _Refused(Exception):
    """A refusal this module decides itself. code is a fixed string, never caller text."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code


# Every refusal that carries a code: _Refused as code, the others as reason.
_CODED_REFUSALS = (_Refused, DraftRefused, ApprovalRefused, simulate.SimulateRefused)


def _load_config() -> Config:
    return load_config(str(ENV_PATH) if ENV_PATH.is_file() else None)


def _paypal(config: Config) -> PayPalHttp:
    return PayPalHttp(config)


@contextmanager
def _database(config: Config) -> Iterator[psycopg.Connection]:
    # connect() runs no DDL, only a one-time check that the schema is in place, so
    # tasks running at once cannot deadlock on schema locks (C22).
    conn = connect(config)
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def _paypal_client(config: Config) -> Iterator[PayPalHttp]:
    http = _paypal(config)
    try:
        yield http
    finally:
        http.close()


def draft_campaign(settings: object, actor: object) -> dict:
    """Build and store one campaign draft for the actor, under the actor's caps.

    settings is {"goal_text", "as_of" (YYYY-MM-DD), "budget_minor", "per_recipient_minor",
    "holdout_share" (a string such as "0.30"), "max_candidates"} and nothing else.
    A demo actor drafts under 1000 cents per campaign and 200 per person, from at most
    20 candidates, at most 5 campaigns per session in any 24 hours, and the demo pool
    of 5000 cents per rolling day; a demo max_candidates above 20 is refused before
    anything is scored. The campaign is recorded against the actor's session in
    campaign_owners in the same transaction as the draft. Returns campaign_id and
    counts; refusals carry build_draft's reason, "over_cap", "limit_reached" or
    "over_demo_daily_cap".
    """

    def work(config: Config, conn: psycopg.Connection) -> dict:
        role, session = _checked_actor(conn, actor)
        draft_settings = _checked_settings(settings)
        if role == "demo" and draft_settings.max_candidates > DEMO_MAX_CANDIDATES:
            raise _Refused("over_cap", f"a demo draft may consider at most {DEMO_MAX_CANDIDATES} candidates")
        with conn.transaction():
            if role == "demo":
                # Held until commit, so two drafts from one session cannot both pass the count.
                conn.execute("select pg_advisory_xact_lock(%s::integer, hashtext(%s))", (DRAFT_LOCK_CLASS, session))
                made = conn.execute(
                    "select count(*) from campaign_owners o join campaigns c on c.campaign_id = o.campaign_id "
                    "where o.session_id = %s and c.created_at > now() - %s",
                    (session, WINDOW),
                ).fetchone()[0]
                if made >= DEMO_CAMPAIGNS_PER_SESSION_PER_DAY:
                    raise _Refused("limit_reached", f"a demo session may draft {DEMO_CAMPAIGNS_PER_SESSION_PER_DAY} campaigns a day")
            result = build_draft(conn, _role_config(config, role), draft_settings)
            if role == "demo":
                _check_demo_pool(conn, result.total_minor)
            conn.execute(
                "insert into campaign_owners (campaign_id, role, session_id) values (%s, %s, %s)",
                (result.campaign_id, role, session),
            )
        return {
            "ok": True,
            "campaign_id": str(result.campaign_id),
            "candidates": result.candidates,
            "rewarded": result.rewarded,
            "held_back": result.held_back,
            "total_minor": result.total_minor,
        }

    return _run("draft_campaign", work)


def view_campaign(campaign_id: object, actor: object) -> dict:
    """The campaign as its creator (or the owner) may see it: settings, rows and the hash to approve.

    Rows carry ref, role, rank, amount_minor and note only: no email, member id or
    customer ref (C12). review_hash is the hash approve_campaign needs back, or None
    when the campaign is not open or cannot be approved as it stands (review_problem
    then names the fixed reason).
    """

    def work(config: Config, conn: psycopg.Connection) -> dict:
        role, session = _checked_actor(conn, actor)
        cid = _checked_campaign(conn, campaign_id, role, session)
        status, goal_text, as_of, budget, per_recipient, share = conn.execute(
            "select status, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share from campaigns where campaign_id = %s",
            (cid,),
        ).fetchone()
        rows = draft_view(conn, cid)
        hash_shown: str | None = None
        problem: str | None = None
        if status in OPEN_STATUSES:
            try:
                hash_shown = review_hash(conn, cid)
            except ApprovalRefused as refused:
                problem = _code(refused.reason)
        return {
            "ok": True,
            "campaign_id": str(cid),
            "status": status,
            "goal_text": goal_text,
            "as_of": as_of.isoformat(),
            "budget_minor": budget,
            "per_recipient_minor": per_recipient,
            "holdout_share": str(share),
            "total_minor": sum(row["amount_minor"] or 0 for row in rows),
            "rows": rows,
            "review_hash": hash_shown,
            "review_problem": problem,
        }

    return _run("view_campaign", work)


def approve_campaign(campaign_id: object, actor: object, presented_hash: object) -> dict:
    """Approve the actor's campaign exactly as shown, under the actor's caps (C2, C4).

    A demo actor approves only under the demo caps and only if the campaign's total
    still fits the demo pool. Refusals carry approve()'s reason or "over_demo_daily_cap".
    """

    def work(config: Config, conn: psycopg.Connection) -> dict:
        role, session = _checked_actor(conn, actor)
        cid = _checked_campaign(conn, campaign_id, role, session)
        if type(presented_hash) is not str:
            raise _Refused("invalid_input", "presented_hash must be text")
        if role == "demo":
            total = conn.execute(
                "select coalesce(sum(amount_minor), 0) from campaign_members where campaign_id = %s and role = 'reward'",
                (cid,),
            ).fetchone()[0]
            _check_demo_pool(conn, int(total))
        approval = approve(
            conn, cid, approver=_approver(role, session), presented_hash=presented_hash, config=_role_config(config, role)
        )
        return {
            "ok": True,
            "campaign_id": str(cid),
            "snapshot_hash": approval.snapshot_hash,
            "approved_at": _utc_text(approval.approved_at),
        }

    return _run("approve_campaign", work)


def submit_campaign(campaign_id: object, actor: object) -> dict:
    """Send the actor's approved campaign as its one Payouts batch (C1, C3).

    A demo session may send at most 2 campaigns in any 24 hours, not counting
    voided ones, and its batch must also fit the demo pool; demo submissions take
    one lock so two cannot both use the same headroom or the same allowance. A demo
    send past either is refused, "limit_reached" or "over_demo_daily_cap", before
    anything is sent. A demo send that cannot take that lock within 10 seconds is
    refused "busy" with nothing read or sent. Calling it again never sends a second
    batch, so a campaign already in the ledger is not held to the 2 a day: sent is
    True only for the call that sent it. For either role, a send the shop's PayPal
    balance cannot cover with the floor left over is refused "low_balance", or
    "balance_unavailable" when the balance cannot be read; the campaign stays
    approved and can be sent later.
    """

    def work(config: Config, conn: psycopg.Connection) -> dict:
        role, session = _checked_actor(conn, actor)
        cid = _checked_campaign(conn, campaign_id, role, session)
        role_config = _role_config(config, role)
        try:
            with _paypal_client(config) as http:
                if role != "demo":
                    result = submit(conn, http, cid, role_config)
                else:
                    if not _take_demo_spend_lock(conn):
                        raise _Refused("busy", f"another demo send held the demo spend lock for {DEMO_SPEND_WAIT_SECONDS:g} seconds")
                    try:
                        in_ledger = conn.execute(
                            "select 1 from payout_batches where campaign_id = %s", (str(cid),)
                        ).fetchone()
                        if in_ledger is None:
                            _check_demo_submits(conn, session)
                        snap = frozen_snapshot(conn, cid)
                        if snap is not None and in_ledger is None:
                            _check_demo_pool(conn, sum(item.amount_minor for item in snap.items))
                        result = submit(conn, http, cid, role_config)
                    finally:
                        conn.execute("select pg_advisory_unlock(%s)", (DEMO_SPEND_LOCK,))
        except BalanceTooLow as short:
            raise _Refused(short.code, str(short)) from None
        return {
            "ok": True,
            "campaign_id": str(cid),
            "status": result.status,
            "sent": result.sent,
            "payout_batch_id": result.payout_batch_id,
        }

    return _run("submit_campaign", work)


def simulate_return(campaign_id: object, ref: object, actor: object) -> dict:
    """One sandbox return purchase by member ref of the actor's sent campaign (C21)."""

    def work(config: Config, conn: psycopg.Connection) -> dict:
        role, session = _checked_actor(conn, actor)
        cid = _checked_campaign(conn, campaign_id, role, session)
        with _paypal_client(config) as http:
            order = simulate.simulate_return(conn, http, cid, ref)  # type: ignore[arg-type]
        return {
            "ok": True,
            "campaign_id": str(cid),
            "ref": order.ref,
            "paypal_order_id": order.paypal_order_id,
            "paypal_status": order.paypal_status,
        }

    return _run("simulate_return", work)


def results(campaign_id: object, actor: object) -> dict:
    """The actor's campaign results: rewarded against held back, real and simulated apart.

    payouts says where each item of the batch stands (campaigns.results.PayoutStanding):
    items, by_status, claimed_minor, unclaimed_minor, returned_minor, failed_minor,
    pending_minor and unclaimed_return_by (UTC ISO 8601 text, or None).
    """

    def work(config: Config, conn: psycopg.Connection) -> dict:
        role, session = _checked_actor(conn, actor)
        cid = _checked_campaign(conn, campaign_id, role, session)
        found = campaign_results(conn, cid)
        return {
            "ok": True,
            "campaign_id": str(cid),
            "status": found.status,
            "rewarded": _arm(found.rewarded),
            "holdout": _arm(found.holdout),
            "spend_minor": found.spend_minor,
            "fees_minor": found.fees_minor,
            "window_starts_at": _utc_text(found.window_starts_at),
            "window_ends_at": _utc_text(found.window_ends_at),
            "window_open": found.window_open,
            "p_value": _finite(found.p_value),
            "verdict": found.verdict,
            "payouts": _payouts(found.payouts),
        }

    return _run("results", work)


def cancel_unclaimed(campaign_id: object, actor: object) -> dict:
    """Ask PayPal to return the actor's campaign's unclaimed cashback to the shop now, not after 30 days.

    The same actor and campaign checks as results: the owner on any campaign, a demo
    actor only on its own. Only items the ledger holds as UNCLAIMED are asked about,
    one cancel call each (campaigns.cancel). cancelled counts the items PayPal
    accepted the cancel for, returned_minor the approved cents of those it answered
    RETURNED, still_unclaimed the items still waiting afterwards, not_cancellable
    the items PayPal refused. Refuses "not_submitted" when the campaign has no
    payout batch, and fails "paypal_unavailable" when PayPal errors or cannot be
    reached part way; items cancelled before that stay cancelled.
    """

    def work(config: Config, conn: psycopg.Connection) -> dict:
        role, session = _checked_actor(conn, actor)
        cid = _checked_campaign(conn, campaign_id, role, session)
        if conn.execute("select 1 from payout_batches where campaign_id = %s", (str(cid),)).fetchone() is None:
            raise _Refused("not_submitted", "the campaign has no payout batch, so nothing is waiting to be claimed")
        with _paypal_client(config) as http:
            report = cancel_unclaimed_items(conn, http, cid)
        return {
            "ok": True,
            "campaign_id": str(cid),
            "cancelled": report.cancelled,
            "returned_minor": report.returned_minor,
            "still_unclaimed": report.still_unclaimed,
            "not_cancellable": report.not_cancellable,
        }

    return _run("cancel_unclaimed", work)


def shop_summary() -> dict:
    """The landing page's live numbers, read from the shop's own records now, plus the stored model proofs. No actor.

    as_of is the London day of the shop's latest order, the day its records run to
    (None, with every count 0, when there are none). quiet_regulars counts customers
    who bought on 3 or more days and have been silent 60 or more by as_of, the rule
    campaigns use. quiet_regulars_paid_12m_minor is what they paid in the 12 months
    up to as_of, net of refunds in those months and never below 0 per customer, in
    USD cents. benchmark and backtest are the rows python -m mend_engine.store_facts
    wrote, each None when missing or malformed: no number is shown that was not
    measured (6j). Returns counts only, never a name, email, member id or customer ref.
    """

    def work(config: Config, conn: psycopg.Connection) -> dict:
        as_of = _shop_as_of(conn)
        quiet: list[str] = []
        paid_12m = 0
        if as_of is not None:
            scores = score_customers(conn, as_of)
            quiet = _quiet_refs(scores)
            paid_12m = _paid_in_last_year(conn, as_of, quiet)
        customers, members = conn.execute("select (select count(*) from shop_customers), (select count(*) from members)").fetchone()
        facts = read_facts(conn)
        return {
            "ok": True,
            "as_of": as_of.isoformat() if as_of is not None else None,
            "shop_customers": customers,
            "members": members,
            "quiet_regulars": len(quiet),
            "quiet_regulars_paid_12m_minor": paid_12m,
            "currency": SUMMARY_CURRENCY,
            "benchmark": facts[CDNOW_KEY],
            "backtest": facts[UCI_KEY],
        }

    return _run("shop_summary", work)


def quiet_regulars(actor: object, limit: object) -> dict:
    """The shop's quiet regulars as of its latest order day, most at risk first, at most limit (1 to 50) of them.

    Each row is position (1 = most at risk, an index into this answer and nothing
    else), the customer's synthetic display_name, purchase_days, days_silent, score
    (expected purchases over the next 13 weeks, rounded to 4 places), paid_net_minor
    (paid to as_of net of refunds, USD cents) and member (a verified member's email
    matches, so they could be thanked). Never an email, member id or customer ref
    (C12, C15). total counts every quiet regular, shown or not. Refuses with
    "invalid_input" for a limit that is not a whole number from 1 to 50 and
    "model_not_converged" when the model cannot rank anyone.
    """

    def work(config: Config, conn: psycopg.Connection) -> dict:
        _checked_actor(conn, actor)
        if type(limit) is not int or not 1 <= limit <= MAX_QUIET_REGULARS:
            raise _Refused("invalid_input", f"limit must be a whole number from 1 to {MAX_QUIET_REGULARS}")
        as_of = _shop_as_of(conn)
        if as_of is None:
            return {"ok": True, "as_of": None, "total": 0, "rows": []}
        scores = score_customers(conn, as_of)
        if not scores.converged:
            raise _Refused("model_not_converged", scores.message)
        quiet = sorted(_quiet_refs(scores), key=lambda ref: (scores.scores[ref], ref))
        shown = quiet[:limit]
        names = dict(conn.execute("select customer_ref, display_name from shop_customers where customer_ref = any(%s)", (shown,)))
        members = _member_refs(conn)
        rows = [
            {
                "position": position,
                "display_name": names[ref],
                "purchase_days": scores.purchase_days[ref],
                "days_silent": scores.days_silent[ref],
                "score": round(scores.scores[ref], 4),
                "paid_net_minor": scores.paid_minor[ref],
                "member": ref in members,
            }
            for position, ref in enumerate(shown, start=1)
        ]
        return {"ok": True, "as_of": as_of.isoformat(), "total": len(quiet), "rows": rows}

    return _run("quiet_regulars", work)


def draft_limits(actor: object) -> dict:
    """The day and the caps a draft for this actor is held to, so a plan can be fitted inside them before it is asked for.

    as_of is the London day of the shop's latest order (None when there are none),
    the day draft_campaign scores on. campaign_cap_minor and item_cap_minor are the
    caps of the actor's role from the same _role_config draft_campaign uses: the
    deployment's own for the owner, 1000 and 200 cents for demo.
    """

    def work(config: Config, conn: psycopg.Connection) -> dict:
        role, _session = _checked_actor(conn, actor)
        caps = _role_config(config, role)
        as_of = _shop_as_of(conn)
        return {
            "ok": True,
            "as_of": as_of.isoformat() if as_of is not None else None,
            "campaign_cap_minor": caps.campaign_cap_minor,
            "item_cap_minor": caps.item_cap_minor,
        }

    return _run("draft_limits", work)


def note_context(campaign_id: object, ref: object, actor: object) -> dict:
    """What a thank-you note for one rewarded customer may be written from, and nothing more (C6, C13, C15).

    Only for a rewarded row of a draft campaign the actor may act on. Returns the
    shop's name, up to 5 item names from that one customer's orders in the shop's
    own records, most recent first, and days_since_last_order as of the campaign's
    day. Item names are lowercased, cut to 60 characters and dropped when the note
    rule refuses them (a link, an "@", a long number, the name PayPal), so nothing
    link-like reaches the model. Never a name, email, member id or customer ref.
    Refuses "holdout_ref" for a held-back row, "unknown_ref", "not_editable" once
    the campaign is not a draft, and "recipient_not_member" when the row's member
    left or matches no shop customer.
    """

    def work(config: Config, conn: psycopg.Connection) -> dict:
        role, session = _checked_actor(conn, actor)
        cid = _checked_campaign(conn, campaign_id, role, session)
        ref_text = _checked_ref(ref)
        row = conn.execute(
            "select c.status, c.shop_name, c.as_of, m.role, m.member_id from campaigns c "
            "join campaign_members m on m.campaign_id = c.campaign_id where c.campaign_id = %s and m.ref = %s",
            (cid, ref_text),
        ).fetchone()
        if row is None:
            raise _Refused("unknown_ref", "no such ref in this campaign")
        status, shop_name, as_of, row_role, member_id = row
        if row_role != "reward":
            raise _Refused("holdout_ref", "held-back members never get a note")
        if status != "draft":
            raise _Refused("not_editable", f"the campaign is {status}; notes are written only while it is a draft")
        customer = _customer_of_member(conn, member_id)
        if customer is None:
            raise _Refused("recipient_not_member", "the row's member left or matches no shop customer")
        until = _end_of_london_day(as_of)
        last = conn.execute(
            "select max(ordered_at) from shop_orders where customer_ref = %s and currency = 'USD' and ordered_at < %s",
            (customer, until),
        ).fetchone()[0]
        names = conn.execute(
            "select l.description from shop_order_lines l join shop_orders o on o.order_ref = l.order_ref "
            "where o.customer_ref = %s and o.currency = 'USD' and o.ordered_at < %s "
            "group by l.description order by max(o.ordered_at) desc, l.description limit %s",
            (customer, until, NOTE_ITEM_SCAN),
        ).fetchall()
        return {
            "ok": True,
            "shop_name": shop_name,
            "recent_items": _note_items(name for (name,) in names),
            "days_since_last_order": (as_of - last.astimezone(SHOP_ZONE).date()).days if last is not None else None,
        }

    return _run("note_context", work)


def set_note(campaign_id: object, ref: object, note: object, actor: object) -> dict:
    """Write one rewarded customer's thank-you note into the actor's draft campaign (C2, C6, C13).

    note is the text, held to the one payout note rule (note_problem), or None for
    the code-owned template. Only while the campaign is a draft: once it awaits
    approval or was approved the note is refused, never changed, so nothing here
    can void an approval. Refuses "note_rejected" for a note the rule refuses,
    "holdout_ref" for a held-back row, "unknown_ref", and "not_editable".
    """

    def work(config: Config, conn: psycopg.Connection) -> dict:
        role, session = _checked_actor(conn, actor)
        cid = _checked_campaign(conn, campaign_id, role, session)
        ref_text = _checked_ref(ref)
        if note is not None and type(note) is not str:
            raise _Refused("invalid_input", "note must be text or null")
        with conn.transaction():
            # Locked until commit, so the campaign cannot leave draft between this check and the write.
            status, shop_name = conn.execute(
                "select status, shop_name from campaigns where campaign_id = %s for update", (cid,)
            ).fetchone()
            if status != "draft":
                raise _Refused("not_editable", f"the campaign is {status}; notes are written only while it is a draft")
            text = NOTE_TEMPLATE.format(shop_name=shop_name) if note is None else note
            try:
                set_campaign_note(conn, cid, ref_text, text)
            except EditRefused as refused:
                raise _Refused(refused.reason, str(refused)) from None
        return {"ok": True, "campaign_id": str(cid), "ref": ref_text, "template": note is None}

    return _run("set_note", work)


def request_approval(campaign_id: object, actor: object) -> dict:
    """Move the actor's draft campaign to awaiting_approval; it never approves anything (C2).

    One conditional update from draft and one audit row, in one transaction. A
    person still has to approve the exact snapshot with approve_campaign. Refuses
    "already_requested" when the campaign already awaits approval and "not_open"
    for any other status.
    """

    def work(config: Config, conn: psycopg.Connection) -> dict:
        role, session = _checked_actor(conn, actor)
        cid = _checked_campaign(conn, campaign_id, role, session)
        with conn.transaction():
            moved = conn.execute(
                "update campaigns set status = 'awaiting_approval' where campaign_id = %s and status = 'draft' returning 1",
                (cid,),
            ).fetchone()
            if moved is None:
                status = conn.execute("select status from campaigns where campaign_id = %s", (cid,)).fetchone()[0]
                if status == "awaiting_approval":
                    raise _Refused("already_requested", "the campaign already awaits approval")
                raise _Refused("not_open", f"the campaign is {status}, not a draft")
            conn.execute(
                _INSERT_AUDIT, (_approver(role, session), "approval_requested", Jsonb({"campaign_id": str(cid)}))
            )
        return {"ok": True, "campaign_id": str(cid), "status": "awaiting_approval"}

    return _run("request_approval", work)


def consent_text() -> dict:
    """The sentence a customer agrees to when they join the demo shop's thank-you list, and its hash. No actor.

    The join page shows text and sends hash back to join, so a change of wording
    between the page and the click is refused rather than recorded (C28).
    """

    def work(config: Config, conn: psycopg.Connection) -> dict:
        text = consent_text_for(DEMO_SHOP_NAME)
        return {"ok": True, "shop_name": DEMO_SHOP_NAME, "text": text, "hash": consent_hash(text)}

    return _run("consent_text", work)


def join(identity: object, consent: object) -> dict:
    """Add the customer PayPal just signed in to the demo shop's thank-you list (C28).

    identity is exactly {"email", "email_verified", "payer_id"} from Log in with
    PayPal; consent is the hash consent_text gave the page the customer saw. The
    member is recorded with the current consent version and this app's client id.
    Joining again returns the same member_id; it changes nothing, except that a verified
    join upgrades a member who first joined unverified (join_member). created says
    whether this call made the member; it is read just before the join, so two
    first joins at the same moment may both say True for the same member_id.
    linked says whether a verified email matches one shop customer. Refuses
    "bad_identity" for an identity of the wrong shape, "consent_changed" when
    consent is not exactly the current hash, "not_payable" for an email PayPal
    could not pay, and "identity_conflict" when the email or payer id belongs to a
    different member. Nothing is written on a refusal.
    """

    def work(config: Config, conn: psycopg.Connection) -> dict:
        email, verified, payer_id = _checked_identity(identity)
        if type(consent) is not str or consent != consent_hash(consent_text_for(DEMO_SHOP_NAME)):
            raise _Refused("consent_changed", "the consent hash is not the current wording's")
        existing = conn.execute("select 1 from members where paypal_email = %s", (normalise_email(email),)).fetchone()
        try:
            member_id = join_member(
                conn,
                paypal_email=email,
                paypal_payer_id=payer_id,
                email_verified=verified,
                shop_name=DEMO_SHOP_NAME,
                client_id=config.paypal_client_id,
            )
        except MembershipRefused as refused:
            code = _MEMBERSHIP_CODES.get(refused.reason)
            if code is None:
                raise
            raise _Refused(code, _MEMBERSHIP_DETAILS[code]) from None
        return {
            "ok": True,
            "member_id": str(member_id),
            "created": existing is None,
            "linked": match_member_to_customer(conn, member_id) is not None,
        }

    return _run("join", work)


def leave(identity: object) -> dict:
    """Take the customer PayPal just signed in off the thank-you list at once (C28).

    identity has the same shape join takes. The member is found by the one email
    normaliser. Leaving voids every campaign not yet sent that holds the member, in
    the same transaction that deletes them; voided counts those campaigns. left is
    False when no member has that email, which is not an error. Refuses
    "bad_identity" for an identity of the wrong shape, "email_unverified" before
    any lookup when PayPal has not verified the email (an unverified email proves
    nothing about who owns it), and "identity_conflict" when the member has a payer
    id and the identity carries a different one.
    """

    def work(config: Config, conn: psycopg.Connection) -> dict:
        email, verified, payer_id = _checked_identity(identity)
        if verified is not True:
            raise _Refused("email_unverified", "leaving needs an email PayPal has verified")
        row = conn.execute(
            "select member_id, paypal_payer_id from members where paypal_email = %s", (normalise_email(email),)
        ).fetchone()
        if row is None:
            return {"ok": True, "left": False, "voided": 0}
        member_id, stored_payer_id = row
        if stored_payer_id is not None and payer_id is not None and stored_payer_id != payer_id:
            raise _Refused("identity_conflict", "the member's PayPal account is not the one signed in")
        result = leave_member(conn, member_id)
        return {"ok": True, "left": result.removed, "voided": len(result.voided_campaigns)}

    return _run("leave", work)


def process_events() -> dict:
    """Give stored webhook deliveries their one outcome each (C10). A scheduled job; no actor."""

    def work(config: Config, conn: psycopg.Connection) -> dict:
        with _paypal_client(config) as http:
            report = process_stored_events(conn, http)
        return {"ok": True, "ran": report.ran, "outcomes": dict(report.outcomes), "retrying": report.retrying}

    return _run("process_events", work)


def reconcile() -> dict:
    """Settle campaigns whose batch outcome is unknown, never sending a second batch (C3). No actor."""

    def work(config: Config, conn: psycopg.Connection) -> dict:
        with _paypal_client(config) as http:
            report = reconcile_campaigns(conn, http)
        return {
            "ok": True,
            "ran": report.ran,
            "looked_at": len(report.actions),
            "sent": sum(1 for action in report.actions if action.sent),
            "waiting": len(report.waiting),
        }

    return _run("reconcile", work)


def purge() -> dict:
    """The 48-hour purge of raw PayPal payloads (C27). No actor."""

    def work(config: Config, conn: psycopg.Connection) -> dict:
        return {"ok": True, "deleted": purge_paypal_events(conn)}

    return _run("purge", work)


def _run(task: str, work: Callable[[Config, psycopg.Connection], dict]) -> dict:
    """Run one task's work and turn every outcome into a JSON-safe dict; never raises.

    A refusal whose code is in LIMIT_CODES also writes one "limit_hit" audit row.
    """
    ref = str(uuid.uuid4())
    config: Config | None = None
    acting = _ACTING_ROLE.set(None)
    try:
        config = _load_config()
        with _database(config) as conn:
            try:
                result = work(config, conn)
            except _CODED_REFUSALS as refused:
                _record_limit_hit(conn, task, refused, config)
                raise
        # Checked here so a value JSON cannot carry fails now, as a logged error, not in the caller.
        json.dumps(result, allow_nan=False)
        _log({"task": task, "ref": ref, "outcome": "ok"})
        return result
    except _Refused as refused:
        return _refusal(task, ref, refused.code, refused, config)
    except DraftRefused as refused:
        return _refusal(task, ref, refused.reason, refused, config)
    except ApprovalRefused as refused:
        return _refusal(task, ref, refused.reason, refused, config)
    except simulate.SimulateRefused as refused:
        return _refusal(task, ref, refused.reason, refused, config)
    except CapExceeded as refused:
        return _refusal(task, ref, "over_daily_cap", refused, config)
    except SnapshotRefused as refused:
        return _refusal(task, ref, "snapshot_refused", refused, config)
    except (simulate.SimulateFailed, PayPalError) as failed:
        return _failure(task, ref, "paypal_unavailable", failed, config)
    except LookupError as missing:
        return _refusal(task, ref, "not_found", missing, config)
    except ConfigError as broken:
        return _failure(task, ref, "internal", broken, config)
    except Exception as unexpected:
        return _failure(task, ref, "internal", unexpected, config)
    finally:
        _ACTING_ROLE.reset(acting)


def _record_limit_hit(conn: psycopg.Connection, task: str, refused: Exception, config: Config) -> None:
    """One "limit_hit" audit row holding only the task, the code and the actor's role, when the refusal's code is a limit."""
    code = _code(refused.code if isinstance(refused, _Refused) else getattr(refused, "reason", None))
    if code not in LIMIT_CODES:
        return
    try:
        with conn.transaction():
            conn.execute(_INSERT_AUDIT, ("engine", "limit_hit", Jsonb({"task": task, "code": code, "role": _ACTING_ROLE.get()})))
    except psycopg.Error as lost:
        # The refusal stays the answer; a row that could not be written is logged instead.
        _log({"task": task, "outcome": "limit_hit_not_recorded", "error": code, "detail": _scrub(str(lost), config)})


def _refusal(task: str, ref: str, code: str, exc: BaseException, config: Config | None) -> dict:
    code = _code(code)
    _log({"task": task, "ref": ref, "outcome": "refused", "error": code, "detail": _scrub(str(exc), config)})
    return {"ok": False, "error": code, "ref": ref}


def _failure(task: str, ref: str, code: str, exc: BaseException, config: Config | None) -> dict:
    _log(
        {
            "task": task,
            "ref": ref,
            "outcome": "failed",
            "error": code,
            "exception": type(exc).__name__,
            "detail": _scrub(str(exc), config),
            "trace": _scrub(traceback.format_exc(), config),
        }
    )
    return {"ok": False, "error": code, "ref": ref}


def _code(value: object) -> str:
    """A refusal code as returned to the caller: a fixed lowercase word, or "refused"."""
    return value if isinstance(value, str) and _CODE.fullmatch(value) else "refused"


def _log(record: dict) -> None:
    # One JSON object per line: escaping keeps newlines in a detail from forging a second line.
    record = {"at": datetime.now(timezone.utc).isoformat(), "kind": "engine_task", **record}
    sys.stderr.write(json.dumps(record, default=str) + "\n")
    sys.stderr.flush()


def _scrub(text: str, config: Config | None) -> str:
    """text with every known secret, session id, cookie-shaped token and email address replaced, and capped in length."""
    secrets = [os.environ.get(name) for name in _SECRET_ENV_NAMES]
    if config is not None:
        secrets += [config.paypal_client_secret, config.paypal_client_id, config.database_url]
        if config.database_url:
            try:
                secrets.append(urlsplit(config.database_url).password)
            except ValueError:
                pass
    for secret in secrets:
        if secret and len(secret) >= 6:
            text = text.replace(secret, "[removed]")
    text = _LOG_EMAIL.sub("[email]", _LOG_COOKIE.sub("[cookie]", _LOG_HEX.sub("[hex64]", text)))
    return text[:MAX_LOG_DETAIL_CHARS]


def _checked_actor(conn: psycopg.Connection, actor: object) -> tuple[str, str]:
    """(role, session) for an actor whose session is live in the sessions table with that role.

    The web app has already checked the session; this second check means a run
    started for a session that has since expired or signed out does nothing.
    """
    if type(actor) is not dict or set(actor) != _ACTOR_KEYS:
        raise _Refused("invalid_actor", "actor must be exactly {role, session}")
    role, session = actor["role"], actor["session"]
    if role not in ROLES or type(session) is not str or not _SESSION_ID.fullmatch(session):
        raise _Refused("invalid_actor", "actor role or session has the wrong shape")
    live = conn.execute(
        "select role from sessions where session_id = %s and expires_at > now() and last_seen_at > now() - %s",
        (session, SESSION_IDLE),
    ).fetchone()
    if live is None or live[0] != role:
        raise _Refused("forbidden", "the actor's session is not live with that role")
    _ACTING_ROLE.set(role)
    return role, session


def _checked_campaign(conn: psycopg.Connection, campaign_id: object, role: str, session: str) -> uuid.UUID:
    """The campaign id, if the actor may act on it: the owner on any, a demo session only on its own (C19)."""
    if type(campaign_id) is not str or not _CAMPAIGN_ID.fullmatch(campaign_id):
        raise _Refused("invalid_input", "campaign_id must be a lowercase UUID")
    cid = uuid.UUID(campaign_id)
    if role == "owner":
        found = conn.execute("select 1 from campaigns where campaign_id = %s", (cid,)).fetchone()
    else:
        found = conn.execute(
            "select 1 from campaign_owners where campaign_id = %s and role = 'demo' and session_id = %s", (cid, session)
        ).fetchone()
    if found is None:
        # The same answer whether the campaign is missing or another visitor's.
        raise _Refused("not_found", "no such campaign for this actor")
    return cid


def _checked_settings(settings: object) -> DraftSettings:
    """DraftSettings from the JSON the web app sent. Ranges and caps are build_draft's to check."""
    if type(settings) is not dict or set(settings) != _SETTINGS_KEYS:
        raise _Refused("invalid_input", "settings must have exactly the draft keys")
    as_of_text, share_text = settings["as_of"], settings["holdout_share"]
    if type(as_of_text) is not str or not _ISO_DAY.fullmatch(as_of_text):
        raise _Refused("invalid_input", "as_of must be YYYY-MM-DD")
    if type(share_text) is not str or not _SHARE.fullmatch(share_text):
        raise _Refused("invalid_input", "holdout_share must be a decimal string such as 0.30")
    if type(settings["goal_text"]) is not str:
        raise _Refused("invalid_input", "goal_text must be text")
    for name in ("budget_minor", "per_recipient_minor", "max_candidates"):
        if type(settings[name]) is not int:
            raise _Refused("invalid_input", f"{name} must be a whole number")
    try:
        as_of = date.fromisoformat(as_of_text)
    except ValueError:
        raise _Refused("invalid_input", "as_of is not a real date") from None
    return DraftSettings(
        goal_text=settings["goal_text"],
        as_of=as_of,
        budget_minor=settings["budget_minor"],
        per_recipient_minor=settings["per_recipient_minor"],
        holdout_share=Decimal(share_text),
        max_candidates=settings["max_candidates"],
    )


def _checked_identity(identity: object) -> tuple[str, bool, str | None]:
    """(email, email_verified, payer_id) from an identity of exactly the Log in with PayPal shape.

    Checks shape only. Whether PayPal could pay the email is join_member's rule, so
    one function decides it for joining and for the payout.
    """
    if type(identity) is not dict or set(identity) != _IDENTITY_KEYS:
        raise _Refused("bad_identity", "identity must be exactly {email, email_verified, payer_id}")
    email, verified, payer_id = identity["email"], identity["email_verified"], identity["payer_id"]
    if type(email) is not str or len(email) > MAX_IDENTITY_EMAIL_CHARS:
        raise _Refused("bad_identity", f"email must be text of at most {MAX_IDENTITY_EMAIL_CHARS} characters")
    if type(verified) is not bool:
        raise _Refused("bad_identity", "email_verified must be true or false")
    if payer_id is not None and (type(payer_id) is not str or not _PAYER_ID.fullmatch(payer_id)):
        raise _Refused("bad_identity", "payer_id must be null or 13 capital letters and digits")
    return email, verified, payer_id


def _checked_ref(ref: object) -> str:
    if type(ref) is not str or not _REF.fullmatch(ref):
        raise _Refused("invalid_input", "ref must look like R1")
    return ref


def _customer_of_member(conn: psycopg.Connection, member_id: uuid.UUID | None) -> str | None:
    """The shop customer a verified member is matched to, by the one email normaliser, as eligibility matches them."""
    row = conn.execute("select paypal_email from members where member_id = %s and email_verified", (member_id,)).fetchone()
    if row is None:
        return None
    return customer_refs_by_email(conn).get(normalise_email(row[0]))


def _note_items(names: Iterable[object]) -> list[str]:
    """Up to NOTE_CONTEXT_ITEMS item names, tidied, deduplicated, and each one passing the note rule."""
    kept: list[str] = []
    for name in names:
        text = " ".join(str(name).split()).lower()[:MAX_ITEM_NAME_CHARS].strip()
        if text and text not in kept and note_problem(text, MAX_ITEM_NAME_CHARS) is None:
            kept.append(text)
        if len(kept) == NOTE_CONTEXT_ITEMS:
            break
    return kept


def _role_config(config: Config, role: str) -> Config:
    """The caps a role works under. The rolling daily cap stays the shop's own; demo also has its pool."""
    if role == "owner":
        return config
    return replace(
        config,
        item_cap_minor=min(config.item_cap_minor, DEMO_ITEM_CAP_MINOR),
        campaign_cap_minor=min(config.campaign_cap_minor, DEMO_CAMPAIGN_CAP_MINOR),
    )


def demo_spent_last_24h_minor(conn: psycopg.Connection) -> int:
    """Cents in every demo-created campaign that reached submitting in the last 24 hours.

    Counted the way spend.spent_last_24h_minor counts the shop's own cap, limited to
    campaigns a demo session created: a voided campaign counts nothing, an item
    PayPal reports FAILED, BLOCKED, RETURNED or REFUNDED stops counting, one with no
    status yet still counts.
    """
    row = conn.execute(
        "select coalesce(sum((item ->> 'amount_minor')::bigint), 0) "
        "from approved_snapshots s join campaign_owners o on o.campaign_id = s.campaign_id and o.role = 'demo' "
        "cross join lateral jsonb_array_elements(s.canonical_json::jsonb -> 'items') item "
        "where exists (select 1 from payout_batches b where b.campaign_id = s.campaign_id::text and b.created_at > now() - %s) "
        "and not " + CAMPAIGN_VOIDED_SQL + " and not " + ITEM_CAME_BACK_SQL,
        (WINDOW, list(MONEY_BACK_STATUSES)),
    ).fetchone()
    return int(row[0])


def _check_demo_pool(conn: psycopg.Connection, extra_minor: int) -> None:
    spent = demo_spent_last_24h_minor(conn)
    if spent + extra_minor > DEMO_DAILY_CAP_MINOR:
        raise _Refused(
            "over_demo_daily_cap",
            f"demo campaigns spent {spent} cents in 24 hours; {extra_minor} more would pass {DEMO_DAILY_CAP_MINOR}",
        )


def _check_demo_submits(conn: psycopg.Connection, session: str) -> None:
    """Refuse once this demo session's campaigns hold DEMO_SUBMITS_PER_SESSION_PER_DAY batches written in the last 24 hours.

    A campaign counts from the moment its payout_batches row is written, the same
    moment the shop's cap and the demo pool start counting it, and stops counting
    when it is voided, as it does for them.
    """
    sent = conn.execute(
        "select count(*) from campaign_owners s where s.role = 'demo' and s.session_id = %s and exists "
        "(select 1 from payout_batches b where b.campaign_id = s.campaign_id::text and b.created_at > now() - %s) "
        "and not " + CAMPAIGN_VOIDED_SQL,
        (session, WINDOW),
    ).fetchone()[0]
    if sent >= DEMO_SUBMITS_PER_SESSION_PER_DAY:
        raise _Refused("limit_reached", f"a demo session may send {DEMO_SUBMITS_PER_SESSION_PER_DAY} campaigns a day")


def _take_demo_spend_lock(conn: psycopg.Connection) -> bool:
    """Take DEMO_SPEND_LOCK for this connection's session, trying for up to DEMO_SPEND_WAIT_SECONDS.

    True once it is held; the caller must release it. False when another
    connection held it the whole time, with nothing held.
    """
    deadline = _monotonic() + DEMO_SPEND_WAIT_SECONDS
    while True:
        if conn.execute("select pg_try_advisory_lock(%s)", (DEMO_SPEND_LOCK,)).fetchone()[0]:
            return True
        left = deadline - _monotonic()
        if left <= 0:
            return False
        _sleep(min(DEMO_SPEND_POLL_SECONDS, left))


def _approver(role: str, session: str) -> str:
    """The principal id written to the audit log: "owner", or "demo:" and a tag that is not the session id."""
    if role == "owner":
        return "owner"
    return "demo:" + hashlib.sha256(f"approver:{session}".encode("ascii")).hexdigest()[:16]


def _shop_as_of(conn: psycopg.Connection) -> date | None:
    """The London calendar day of the shop's latest order, the day scoring counts purchase days on."""
    latest = conn.execute("select max(ordered_at) from shop_orders where currency = 'USD'").fetchone()[0]
    return latest.astimezone(SHOP_ZONE).date() if latest is not None else None


def _quiet_refs(scores: ScoreSet) -> list[str]:
    """Customers who are quiet regulars by the campaign rule, from the same ScoreSet the list and the draft use."""
    return sorted(
        ref
        for ref, days in scores.purchase_days.items()
        if days >= REGULAR_MIN_DAYS and scores.days_silent[ref] >= SILENT_MIN_DAYS
    )


def _end_of_london_day(day: date) -> datetime:
    return datetime.combine(day + timedelta(days=1), time.min, tzinfo=SHOP_ZONE).astimezone(timezone.utc)


def _paid_in_last_year(conn: psycopg.Connection, as_of: date, refs: list[str]) -> int:
    """USD cents these customers paid on the London days after the same day a year before as_of, up to as_of.

    Refunds in the same months come off each customer's total, which never goes below 0.
    """
    try:
        year_before = as_of.replace(year=as_of.year - 1)
    except ValueError:
        year_before = as_of.replace(year=as_of.year - 1, day=28)
    window = (refs, _end_of_london_day(year_before), _end_of_london_day(as_of))
    paid = dict(
        conn.execute(
            "select customer_ref, sum(total_minor) from shop_orders where customer_ref = any(%s) and currency = 'USD' "
            "and ordered_at >= %s and ordered_at < %s group by customer_ref",
            window,
        )
    )
    refunded = dict(
        conn.execute(
            "select customer_ref, sum(amount_minor) from shop_refunds where customer_ref = any(%s) "
            "and refunded_at >= %s and refunded_at < %s group by customer_ref",
            window,
        )
    )
    return sum(max(int(total) - int(refunded.get(ref, 0)), 0) for ref, total in paid.items())


def _member_refs(conn: psycopg.Connection) -> set[str]:
    """Customer refs a verified member is matched to, by the one email normaliser, as eligibility matches them."""
    refs = customer_refs_by_email(conn)
    matched = set()
    for (email,) in conn.execute("select paypal_email from members where email_verified"):
        ref = refs.get(normalise_email(email))
        if ref is not None:
            matched.add(ref)
    return matched


def _arm(arm: ArmResults) -> dict:
    return {
        "members": arm.members,
        "real_returns": arm.real_returns,
        "real_rate": _finite(arm.real_rate),
        "simulated_returns": arm.simulated_returns,
    }


def _payouts(standing: PayoutStanding) -> dict:
    return {
        "items": standing.items,
        "by_status": dict(standing.by_status),
        "claimed_minor": standing.claimed_minor,
        "unclaimed_minor": standing.unclaimed_minor,
        "returned_minor": standing.returned_minor,
        "failed_minor": standing.failed_minor,
        "pending_minor": standing.pending_minor,
        "unclaimed_return_by": _utc_text(standing.unclaimed_return_by),
    }


def _finite(value: float | None) -> float | None:
    return value if value is not None and math.isfinite(value) else None


def _utc_text(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat() if value is not None else None
