"""Proves M5 on the demo shop, the live PayPal sandbox and real webhooks: python -m mend_engine.prove_m5

Starts the web app behind a temporary cloudflared tunnel with a temporary PayPal
webhook (packages/web/scripts/webhook-session.ts). Then sends a 2.00 USD campaign
and follows its payout items through PayPal's own events, shows that a verified
event for a batch we did not create changes nothing, buys once as a rewarded and
once as a held-back member with the simulate button and attributes both captures,
reads the results, settles a campaign whose submit answer was lost without a
second batch, has the database refuse a voided campaign's approval, and checks the
stored outcomes for personal data. Prints PASS or FAIL per line and a final
M5 RESULT line. The webhook, tunnel and server are removed even when a step fails.

Real sandbox spend per run: the campaign (at most 2.00 USD), one 0.10 USD payout
outside the ledger, the reconcile campaign (at most 0.25 USD), plus PayPal's fee
per item. The two 12.50 USD card purchases are paid in to the shop.
"""

from __future__ import annotations

import json
import queue
import shutil
import subprocess
import sys
import threading
import time as clock
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

import httpx
import psycopg
from psycopg.types.json import Jsonb

from mend_engine.campaigns.approval import ApprovalRefused, approve, review_hash
from mend_engine.campaigns.drafts import DraftRefused, DraftSettings, build_draft
from mend_engine.campaigns.reconcile import reconcile
from mend_engine.campaigns.results import TOO_EARLY, campaign_results
from mend_engine.campaigns.scoring import score_customers
from mend_engine.campaigns.simulate import SimulateFailed, SimulateRefused, read_order, simulate_return
from mend_engine.campaigns.submission import submit
from mend_engine.config import ConfigError, load_config
from mend_engine.db.connect import connect
from mend_engine.db.migrate import migrate
from mend_engine.events.payout_status import as_seen, effective
from mend_engine.events.process import process_events
from mend_engine.maintenance.purge import purge_paypal_events
from mend_engine.money import MoneyError
from mend_engine.paypal.http import PayPalError, PayPalHttp
from mend_engine.paypal.payouts import (
    PAYOUTS_PATH,
    BatchSnapshot,
    PayoutItemSpec,
    SnapshotRefused,
    SubmissionUnknown,
    get_batch,
    get_item,
    submit_batch,
)
from mend_engine.prove_m4b import link_test_receiver

ENV_PATH = Path(__file__).resolve().parents[3] / ".env"
WEB_DIR = Path(__file__).resolve().parents[2] / "web"
TSX_CLI = WEB_DIR / "node_modules" / "tsx" / "dist" / "cli.mjs"
EVENT_TYPES = [
    *(f"PAYMENT.PAYOUTS-ITEM.{name}" for name in ("SUCCEEDED", "FAILED", "BLOCKED", "HELD", "UNCLAIMED", "RETURNED", "REFUNDED", "CANCELED")),
    *(f"PAYMENT.PAYOUTSBATCH.{name}" for name in ("DENIED", "PROCESSING", "SUCCESS")),
    "PAYMENT.CAPTURE.COMPLETED",
]
AS_OF = date(2026, 10, 16)
GOAL = "Bring back our quiet regulars with a small thank-you"
BUDGET_MINOR = 200
PER_RECIPIENT_MINOR = 25
HOLDOUT_SHARE = Decimal("0.50")
MAX_CANDIDATES = 250
RECONCILE_BUDGET_MINOR = 25
OUTSIDE_MINOR = 10
# The holdout is a fresh random draw for every draft (C6), so the test receiver is
# held back about half the time; such drafts are voided and drawn again.
MAX_DRAWS = 12
APPROVER = "owner"
ACTOR = "prove_m5"
READY_WITHIN_SECONDS = 600
PAYOUT_EVENTS_WITHIN_SECONDS = 480
CAPTURES_WITHIN_SECONDS = 300
POLL_EVERY_SECONDS = 15
CHECKS = 9
# The order's state machine, written out again so the run is checked against it, not against the code.
FORWARD = {
    "PENDING": {"SUCCESS", "UNCLAIMED", "FAILED", "ONHOLD", "BLOCKED"},
    "ONHOLD": {"SUCCESS", "UNCLAIMED", "FAILED", "BLOCKED"},
    "UNCLAIMED": {"SUCCESS", "RETURNED"},
    "SUCCESS": {"REFUNDED"},
}


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
    # Database and HTTP errors can quote row values or URLs, so only the engine's own messages are shown.
    if isinstance(exc, SubmissionUnknown):
        return f"SubmissionUnknown: {exc.reason} (status={exc.status} name={exc.name} debug_id={exc.debug_id})"
    if isinstance(exc, PayPalError):
        return f"{type(exc).__name__} status={exc.status} name={exc.name} debug_id={exc.debug_id}"
    if isinstance(exc, (ApprovalRefused, DraftRefused, ConfigError, SnapshotRefused, MoneyError, SimulateRefused, SimulateFailed, HarnessError)):
        return f"{type(exc).__name__}: {exc}"
    return type(exc).__name__


def usd(minor: int) -> str:
    return f"{minor // 100:,}.{minor % 100:02d}"


def audit(conn: psycopg.Connection, action: str, detail: dict) -> None:
    with conn.transaction():
        conn.execute("insert into audit_log (actor, action, detail) values (%s, %s, %s)", (ACTOR, action, Jsonb(detail)))


class HarnessError(RuntimeError):
    """The webhook session did not come up or did not answer."""


class WebhookSession:
    """Drives packages/web/scripts/webhook-session.ts: it holds the webhook, tunnel and server open until stdin closes."""

    def __init__(self) -> None:
        node = shutil.which("node")
        if node is None or not TSX_CLI.is_file():
            raise HarnessError("node or tsx is missing; run npm install in packages/web")
        self.records: queue.Queue[dict] = queue.Queue()
        self.stderr_tail: list[str] = []
        self.process = subprocess.Popen(
            [node, str(TSX_CLI), "scripts/webhook-session.ts", *EVENT_TYPES],
            cwd=WEB_DIR,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self) -> None:
        for text in self.process.stdout:
            try:
                record = json.loads(text)
            except ValueError:
                continue
            if isinstance(record, dict):
                self.records.put(record)

    def _read_stderr(self) -> None:
        for text in self.process.stderr:
            self.stderr_tail = [*self.stderr_tail[-19:], text.rstrip()]

    def wait_ready(self) -> dict:
        deadline = clock.monotonic() + READY_WITHIN_SECONDS
        while clock.monotonic() < deadline:
            try:
                record = self.records.get(timeout=5)
            except queue.Empty:
                if self.process.poll() is not None:
                    raise HarnessError("the webhook session exited before it was ready") from None
                continue
            if record.get("ready") is True:
                return record
            if record.get("ready") is False:
                raise HarnessError(f"the webhook session failed: {record.get('error')}")
        raise HarnessError("the webhook session was not ready in time")

    def stop(self) -> list[dict]:
        """Close stdin so the session cleans up; returns its cleanup records, the last one {"done": ...}."""
        cleanup: list[dict] = []
        try:
            self.process.stdin.close()
        except OSError:
            pass
        deadline = clock.monotonic() + 180
        while clock.monotonic() < deadline:
            try:
                record = self.records.get(timeout=5)
            except queue.Empty:
                if self.process.poll() is not None and self.records.empty():
                    break
                continue
            cleanup.append(record)
            if record.get("done") is True:
                break
        if self.process.poll() is None:
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/pid", str(self.process.pid), "/T", "/F"], capture_output=True, check=False)
            else:
                self.process.kill()
            cleanup.append({"done": True, "ok": False, "error": "the session had to be killed"})
        return cleanup


class LostAnswerTransport(httpx.BaseTransport):
    """Sends the first Payouts request to PayPal for real, then acts as if its answer never came back.

    Later Payouts requests (submit_batch's retries) time out without being sent, as if
    the network stayed down. Every other request passes through untouched.
    """

    def __init__(self) -> None:
        self._inner = httpx.HTTPTransport()
        self.posts = 0
        self.first_status: int | None = None
        self.first_batch_id: str | None = None

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path == PAYOUTS_PATH:
            self.posts += 1
            if self.posts == 1:
                response = self._inner.handle_request(request)
                response.read()
                self.first_status = response.status_code
                try:
                    self.first_batch_id = json.loads(response.content)["batch_header"]["payout_batch_id"]
                except (ValueError, KeyError, TypeError):
                    self.first_batch_id = None
                response.close()
            raise httpx.ReadTimeout("the answer was lost on the way back", request=request)
        return self._inner.handle_request(request)

    def close(self) -> None:
        self._inner.close()


class PostTally(httpx.BaseTransport):
    """A real transport that notes the status PayPal gave each Payouts request."""

    def __init__(self) -> None:
        self._inner = httpx.HTTPTransport()
        self.payout_statuses: list[int] = []

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        response = self._inner.handle_request(request)
        if request.method == "POST" and request.url.path == PAYOUTS_PATH:
            self.payout_statuses.append(response.status_code)
        return response

    def close(self) -> None:
        self._inner.close()


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


def send_campaign(proof: Proof, conn: psycopg.Connection, config, http: PayPalHttp, receiver_id: uuid.UUID, created: list) -> dict | None:
    settings = DraftSettings(GOAL, AS_OF, BUDGET_MINOR, PER_RECIPIENT_MINOR, HOLDOUT_SHARE, MAX_CANDIDATES)
    for draw in range(MAX_DRAWS):
        result = build_draft(conn, config, settings)
        created.append(result.campaign_id)
        role = conn.execute(
            "select role from campaign_members where campaign_id = %s and member_id = %s", (result.campaign_id, receiver_id)
        ).fetchone()
        if role == ("reward",):
            break
        void_draft(conn, result.campaign_id, "proof run: the test receiver was held back")
    else:
        proof.line(False, f"campaign: the test receiver was held back in all {MAX_DRAWS} draws")
        return None
    campaign_id = result.campaign_id
    approve(conn, campaign_id, approver=APPROVER, presented_hash=review_hash(conn, campaign_id), config=config)
    sent = submit(conn, http, campaign_id, config)
    ok = sent.status == "submitted" and sent.sent and sent.payout_batch_id is not None
    proof.line(
        ok,
        f"campaign: {campaign_id} drafted, approved and submitted, {result.rewarded} rewarded and {result.held_back} held back",
    )
    proof.note(
        f"batch {sent.payout_batch_id}, {usd(result.total_minor)} USD in {result.rewarded} items; the test receiver was "
        f"held back in {draw} earlier draws, voided"
    )
    if not ok:
        return None
    return {
        "campaign_id": campaign_id,
        "sender_batch_id": sent.sender_batch_id,
        "payout_batch_id": sent.payout_batch_id,
        "rewarded": result.rewarded,
        "held_back": result.held_back,
        "total_minor": result.total_minor,
    }


def send_outside_payout(conn: psycopg.Connection, config, http: PayPalHttp, run_id: str) -> str:
    """One small real payout to the test receiver that is never written to the ledger."""
    snap = BatchSnapshot(
        campaign_id=f"m5-outside-{run_id}",
        currency="USD",
        email_subject="Mend proof payout",
        items=(PayoutItemSpec(config.test_receiver, OUTSIDE_MINOR, "Mend proof payout outside the ledger", "outside-1"),),
    )
    result = submit_batch(http, snap)
    audit(conn, "proof_payout_outside_ledger", {"payout_batch_id": result.payout_batch_id, "amount_minor": OUTSIDE_MINOR})
    return result.payout_batch_id


def lose_an_answer(conn: psycopg.Connection, config, created: list) -> dict:
    """A one-recipient campaign whose batch PayPal creates but whose answer never reaches submit()."""
    settings = DraftSettings(GOAL, AS_OF, RECONCILE_BUDGET_MINOR, RECONCILE_BUDGET_MINOR, HOLDOUT_SHARE, 2)
    campaign_id = build_draft(conn, config, settings).campaign_id
    created.append(campaign_id)
    approve(conn, campaign_id, approver=APPROVER, presented_hash=review_hash(conn, campaign_id), config=config)
    lost = LostAnswerTransport()
    http = PayPalHttp(config, transport=lost)
    try:
        first = submit(conn, http, campaign_id, config)
    finally:
        http.close()
    tally = PostTally()
    http = PayPalHttp(config, transport=tally)
    try:
        report = reconcile(conn, http)
    finally:
        http.close()
    mine = [a for a in report.actions if a.campaign_id == campaign_id]
    return {
        "campaign_id": campaign_id,
        "sender_batch_id": first.sender_batch_id,
        "after_submit": first.status,
        "lost_posts": lost.posts,
        "first_status": lost.first_status,
        "first_batch_id": lost.first_batch_id,
        "after_reconcile": mine[0].after if mine else None,
        "reconcile_statuses": tally.payout_statuses,
        "reconcile_actions": len(report.actions),
    }


def simulate_both(conn: psycopg.Connection, http: PayPalHttp, campaign: dict, receiver_id: uuid.UUID) -> dict:
    campaign_id = campaign["campaign_id"]
    rewarded_ref = conn.execute(
        "select ref from campaign_members where campaign_id = %s and member_id = %s", (campaign_id, receiver_id)
    ).fetchone()[0]
    holdout_ref = conn.execute(
        "select ref from campaign_members where campaign_id = %s and role = 'holdout' order by rank limit 1", (campaign_id,)
    ).fetchone()[0]
    orders = {"reward": simulate_return(conn, http, campaign_id, rewarded_ref), "holdout": simulate_return(conn, http, campaign_id, holdout_ref)}
    try:
        simulate_return(conn, http, campaign_id, "R9999")
        refused = "accepted"
    except SimulateRefused as exc:
        refused = exc.reason
    return {"orders": orders, "refused": refused, "at": clock.monotonic()}


def outcomes_for(conn: psycopg.Connection, key: str, values: list[str]) -> list[tuple]:
    return conn.execute(
        "select outcome, detail from event_outcomes where detail ->> %s = any(%s) order by processed_at",
        (key, values),
    ).fetchall()


def item_state(conn: psycopg.Connection, http: PayPalHttp, campaign: dict) -> dict:
    """Item outcomes for the campaign's batch and, once every item has one, how they compare with PayPal now."""
    item_outcomes = [
        (o, d) for o, d in outcomes_for(conn, "sender_batch_id", [campaign["sender_batch_id"]]) if d.get("payout_item_id")
    ]
    covered = {d["payout_item_id"] for _o, d in item_outcomes}
    stored = dict(
        conn.execute(
            "select payout_item_id, status from payout_items where sender_batch_id = %s", (campaign["sender_batch_id"],)
        ).fetchall()
    )
    mismatched = None
    if len(covered) >= campaign["rewarded"]:
        try:
            mismatched = [item for item, status in stored.items() if as_seen(get_item(http, item).get("transaction_status")) != status]
        except PayPalError:
            mismatched = None
    return {"outcomes": item_outcomes, "covered": covered, "stored": stored, "mismatched": mismatched}


def wait_for_events(conn: psycopg.Connection, http: PayPalHttp, campaign: dict, outside_batch: str, recon: dict, sims: dict) -> dict:
    payout_deadline = clock.monotonic() + PAYOUT_EVENTS_WITHIN_SECONDS
    capture_deadline = sims["at"] + CAPTURES_WITHIN_SECONDS
    order_ids = [o.paypal_order_id for o in sims["orders"].values()]
    state: dict = {"captures_timed_out": False}
    while True:
        process_events(conn, http, limit=200)
        items = item_state(conn, http, campaign)
        outside = outcomes_for(conn, "payout_batch_id", [outside_batch])
        recon_status = conn.execute("select status from campaigns where campaign_id = %s", (recon["campaign_id"],)).fetchone()[0]
        captures = outcomes_for(conn, "paypal_order_id", order_ids)
        captures_done = {d["paypal_order_id"] for _o, d in captures} == set(order_ids)
        if not captures_done and clock.monotonic() > capture_deadline:
            state["captures_timed_out"] = True
        state.update(items=items, outside=outside, recon_status=recon_status, captures=captures, captures_done=captures_done)
        payouts_done = items["mismatched"] == [] and bool(outside) and recon_status == "submitted"
        captures_settled = captures_done or state["captures_timed_out"]
        if (payouts_done and captures_settled) or (clock.monotonic() > payout_deadline and captures_settled):
            return state
        clock.sleep(POLL_EVERY_SECONDS)


def arrived_since(conn: psycopg.Connection, started: datetime) -> str:
    rows = conn.execute(
        "select event_type, count(*) from paypal_events where received_at >= %s group by 1 order by 1", (started,)
    ).fetchall()
    return ", ".join(f"{event_type} x{count}" for event_type, count in rows) or "nothing"


def check_statuses(proof: Proof, campaign: dict, state: dict) -> None:
    items = state["items"]
    recorded = [d for o, d in items["outcomes"] if o == "status recorded"]
    refused = [d for o, d in items["outcomes"] if o == "status refused"]
    backwards = [
        d for d in recorded
        if d.get("decision") == "moved" and d.get("to") not in FORWARD.get(effective(d.get("from")), set())
    ]
    ok = (
        len(items["covered"]) == campaign["rewarded"]
        and len(items["stored"]) == campaign["rewarded"]
        and items["mismatched"] == []
        and not backwards
    )
    proof.line(
        ok,
        f"statuses: {len(items['outcomes'])} payout item events processed; every status matches PayPal's re-read; "
        "none moved backwards",
    )
    counts: dict[str, int] = {}
    for status in items["stored"].values():
        counts[status] = counts.get(status, 0) + 1
    proof.note(
        f"{len(items['covered'])} of {campaign['rewarded']} items heard from; stored now: "
        f"{', '.join(f'{n} {s}' for s, n in sorted(counts.items())) or 'none'}; {len(refused)} stale moves refused; "
        f"mismatches with PayPal: {len(items['mismatched']) if items['mismatched'] is not None else 'not checked'}"
    )


def check_forged(proof: Proof, conn: psycopg.Connection, outside_batch: str, state: dict) -> None:
    outside = state["outside"]
    items = [d.get("payout_item_id") for _o, d in outside if d.get("payout_item_id")]
    stored = conn.execute("select count(*) from payout_items where payout_item_id = any(%s)", (items,)).fetchone()[0]
    in_ledger = conn.execute("select count(*) from payout_batches where payout_batch_id = %s", (outside_batch,)).fetchone()[0]
    ok = bool(outside) and all(o == "not ours" for o, _d in outside) and stored == 0 and in_ledger == 0
    proof.line(ok, "forged status: a verified event naming a batch we did not create changes nothing")
    kinds = sorted({d.get("event_type") for _o, d in outside})
    proof.note(
        f"batch {outside_batch} ({usd(OUTSIDE_MINOR)} USD to the test receiver, outside the ledger): {len(outside)} verified "
        f"events ({', '.join(kinds) or 'none'}), outcomes {sorted({o for o, _d in outside}) or 'none'}; payout_items rows: {stored}"
    )


def check_simulate(proof: Proof, conn: psycopg.Connection, sims: dict) -> None:
    orders = sims["orders"]
    stored = dict(
        conn.execute(
            "select paypal_order_id, ref from simulated_orders where simulated_order_id = any(%s)",
            ([o.simulated_order_id for o in orders.values()],),
        ).fetchall()
    )
    ok = (
        all(o.paypal_status == "COMPLETED" for o in orders.values())
        and stored == {o.paypal_order_id: o.ref for o in orders.values()}
        and sims["refused"] == "unknown_ref"
    )
    proof.line(ok, "simulate: return purchases created for one rewarded and one holdout member")
    proof.note(
        f"rewarded {orders['reward'].ref} order {orders['reward'].paypal_order_id}, holdout {orders['holdout'].ref} order "
        f"{orders['holdout'].paypal_order_id}, both {usd(1250)} USD by sandbox card; a ref outside the campaign was "
        f"refused ({sims['refused']}) with no PayPal call"
    )


def check_attribution(proof: Proof, conn: psycopg.Connection, http: PayPalHttp, sims: dict, state: dict, started: datetime) -> None:
    orders = sims["orders"]
    if not state["captures_done"]:
        proof.line(
            False,
            f"attribution: no PAYMENT.CAPTURE.COMPLETED outcome for both orders within {CAPTURES_WITHIN_SECONDS // 60} minutes; "
            f"arrived since the run started: {arrived_since(conn, started)}",
        )
        return
    rows = {
        source: (role, ref, simulated)
        for source, role, ref, simulated in conn.execute(
            "select source_order, role, ref, simulated from attributions where source_order = any(%s)",
            ([o.paypal_order_id for o in orders.values()],),
        )
    }
    reread = {arm: read_order(http, o.paypal_order_id).get("status") for arm, o in orders.items()}
    outcomes = {d["paypal_order_id"]: o for o, d in state["captures"]}
    ok = (
        all(outcomes.get(o.paypal_order_id) == "purchase recorded" for o in orders.values())
        and all(rows.get(o.paypal_order_id) == (arm, o.ref, True) for arm, o in orders.items())
        and set(reread.values()) == {"COMPLETED"}
    )
    proof.line(ok, "attribution: both captures verified, re-read COMPLETED, attributed as simulated to the right arm")
    proof.note(f"outcomes {sorted(set(outcomes.values()))}; attributed arms {sorted(r[0] for r in rows.values())}")


def check_results(proof: Proof, conn: psycopg.Connection, campaign: dict) -> None:
    result = campaign_results(conn, campaign["campaign_id"])
    a, b = result.rewarded.real_returns, result.holdout.real_returns
    r, h = result.rewarded.members, result.holdout.members
    ok = (
        (r, h) == (campaign["rewarded"], campaign["held_back"])
        and (result.rewarded.simulated_returns, result.holdout.simulated_returns) == (1, 1)
        and (a, b) == (0, 0)
        and result.verdict == TOO_EARLY
    )
    proof.line(
        ok,
        f"results: rewarded {a} of {r}, holdout {b} of {h} real returns; simulated shown separately; verdict: {result.verdict}",
    )
    proof.note(
        f"simulated returns: rewarded {result.rewarded.simulated_returns}, holdout {result.holdout.simulated_returns}; "
        f"spend {usd(result.spend_minor)} USD (SUCCESS and PENDING items), fees {usd(result.fees_minor)} USD; "
        f"one-sided p {result.p_value:.3f}; window open until {result.window_ends_at:%Y-%m-%d %H:%M} UTC"
    )


def check_reconcile(proof: Proof, conn: psycopg.Connection, http: PayPalHttp, recon: dict, state: dict) -> None:
    ledger = conn.execute(
        "select payout_batch_id from payout_batches where campaign_id = %s", (str(recon["campaign_id"]),)
    ).fetchall()
    confirmed = None
    if len(ledger) == 1 and ledger[0][0]:
        confirmed = (get_batch(http, ledger[0][0]).get("batch_header") or {}).get("sender_batch_header", {}).get("sender_batch_id")
    ok = (
        recon["after_submit"] == "submission_unknown"
        and recon["first_status"] == 201
        and recon["after_reconcile"] == "exists_unresolved"
        and recon["reconcile_statuses"] == [400]
        and state["recon_status"] == "submitted"
        and len(ledger) == 1
        and ledger[0][0] == recon["first_batch_id"]
        and confirmed == recon["sender_batch_id"]
    )
    proof.line(ok, "reconcile: a campaign forced into submission_unknown is resolved without a second batch")
    proof.note(
        f"campaign {recon['campaign_id']}: PayPal created batch {recon['first_batch_id']} but the answer was lost "
        f"({recon['lost_posts']} attempts, 1 sent); reconcile resent the same sender_batch_id and PayPal answered "
        f"{recon['reconcile_statuses']} (already exists), leaving {recon['after_reconcile']}; the batch webhook then moved it "
        f"to {state['recon_status']}; ledger rows: {len(ledger)}"
    )


def check_guard(proof: Proof, conn: psycopg.Connection) -> None:
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Wolf and Wren Gifts', %s, %s, 100, 25, 0.5, 'draft') returning campaign_id",
        (GOAL, AS_OF),
    ).fetchone()[0]
    void_draft(conn, campaign_id, "proof run: status guard check")
    refused = False
    try:
        with conn.transaction():
            conn.execute("update campaigns set status = 'approved' where campaign_id = %s", (campaign_id,))
    except psycopg.errors.RaiseException:
        refused = True
    status = conn.execute("select status from campaigns where campaign_id = %s", (campaign_id,)).fetchone()[0]
    moves = conn.execute(
        "select from_status, to_status from campaign_status_moves where campaign_id = %s order by moved_at", (campaign_id,)
    ).fetchall()
    ok = refused and status == "voided" and moves == [(None, "draft"), ("draft", "voided")]
    proof.line(ok, "status guard: voided to approved refused by the database")


def check_privacy(proof: Proof, conn: psycopg.Connection, config) -> None:
    text = (
        conn.execute("select coalesce(string_agg(outcome || ' ' || detail::text, ' '), '') from event_outcomes").fetchone()[0]
        + " "
        + conn.execute("select coalesce(string_agg(a::text, ' '), '') from attributions a").fetchone()[0]
    )
    names = [r[0] for r in conn.execute("select display_name from shop_customers")]
    emails = [r[0] for r in conn.execute("select paypal_email from members")] + [config.test_receiver]
    found = [label for label, hit in (
        ("@", "@" in text),
        ("a shop customer's name", any(name in text for name in names)),
        ("a member's email", any(email and email in text for email in emails)),
        ("the card holder's name", "Test Buyer" in text),
    ) if hit]
    rows = conn.execute("select (select count(*) from event_outcomes), (select count(*) from attributions)").fetchone()
    proof.line(not found and rows[0] > 0, "privacy: event_outcomes and attributions hold no email or name")
    proof.note(f"searched {rows[0]} outcome rows and {rows[1]} attribution rows; found: {', '.join(found) or 'nothing'}")


def run() -> bool:
    proof = Proof()
    run_id = uuid.uuid4().hex[:12]
    started = datetime.now(timezone.utc)
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
    session: WebhookSession | None = None
    cleanup_ok = False
    with conn:
        try:
            purged = purge_paypal_events(conn)
            session = WebhookSession()
            ready = session.wait_ready()
            proof.note(
                f"webhook {ready.get('webhook_id')} on a temporary tunnel, {ready.get('event_types')} event types; "
                f"{purged} raw events past 48 hours purged first"
            )
            scores = score_customers(conn, AS_OF)
            receiver_id = link_test_receiver(conn, config, scores)
            campaign = send_campaign(proof, conn, config, http, receiver_id, created)
            if campaign is None:
                return False
            outside_batch = send_outside_payout(conn, config, http, run_id)
            recon = lose_an_answer(conn, config, created)
            sims = simulate_both(conn, http, campaign, receiver_id)
            state = wait_for_events(conn, http, campaign, outside_batch, recon, sims)
            check_statuses(proof, campaign, state)
            check_forged(proof, conn, outside_batch, state)
            check_simulate(proof, conn, sims)
            check_attribution(proof, conn, http, sims, state, started)
            check_results(proof, conn, campaign)
            check_reconcile(proof, conn, http, recon, state)
            check_guard(proof, conn)
            check_privacy(proof, conn, config)
        except Exception as exc:
            proof.line(False, f"stopped: {describe(exc)}")
            if session is not None and session.stderr_tail and isinstance(exc, HarnessError):
                proof.note("session stderr: " + " | ".join(session.stderr_tail[-5:]))
        finally:
            for campaign_id in created:
                void_draft(conn, campaign_id, "proof run finished")
            if session is not None:
                records = session.stop()
                done = next((r for r in records if r.get("done") is True), {})
                steps = {r.get("cleanup"): r for r in records if r.get("cleanup")}
                cleanup_ok = done.get("ok") is True and all(r.get("ok") is True for r in steps.values())
                webhook = steps.get("webhook", {})
                deliveries = (steps.get("server") or {}).get("deliveries") or {}
                text = (
                    f"cleanup: webhook {webhook.get('webhook_id', 'none')} deleted (status {webhook.get('status')}), "
                    f"tunnel, server and database handle stopped"
                )
                if cleanup_ok:
                    proof.note(text)
                else:
                    print(f"[FAIL] {text}: {json.dumps(records)}", flush=True)
                proof.note(f"deliveries the receiver logged: {json.dumps(deliveries, sort_keys=True)}")
            http.close()
    return cleanup_ok and all(proof.results) and len(proof.results) == CHECKS


def main() -> int:
    try:
        passed = run()
    except Exception as exc:
        print(f"[FAIL] stopped: {describe(exc)}", flush=True)
        passed = False
    print(f"M5 RESULT: {'PASS' if passed else 'FAIL'}", flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
