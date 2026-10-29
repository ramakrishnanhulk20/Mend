"""The scheduled jobs, run by the mend-jobs cron on Render every 5 minutes.

    python -m mend_engine.jobs all          purge, process_events, reconcile, refresh_items, then cancel_demo_unclaimed
    python -m mend_engine.jobs <job> ...    only the jobs named, in the order given

purge, process_events and reconcile are the engine tasks of the same name in tasks.py,
called in this process; refresh_items and cancel_demo_unclaimed are here because no
route starts them. refresh_items is the scheduled read keyed on Mend's own records:
payout items, batches missing item rows and simulated orders with no purchase, so
nothing only a webhook can bring in is lost when the webhook is (C10). They act for
the shop itself, with no visitor session, which is why none takes an actor.
process_events, reconcile, refresh_items and cancel_demo_unclaimed each hold their
own database lock while they run, so two runs never act on the same thing (C20). Prints one JSON line per job with its counts, or its error code and ref.
purge runs first and every job runs even when an earlier one fails, so neither a slow
nor a failing PayPal holds up the 48-hour purge (C27). Exits 1 when any job did not
answer ok, otherwise 0.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import traceback
import uuid
from collections.abc import Callable, Mapping, Sequence
from datetime import timedelta

import psycopg
from psycopg.types.json import Jsonb

from mend_engine import tasks
from mend_engine.campaigns.attribution import simulated_order_for
from mend_engine.campaigns.cancel import (
    CANCEL_REST_AFTER,
    ITEM_RESTING_SQL,
    UNCLAIMED,
    BatchReadBack,
    CancelIncomplete,
    ReadBackRefused,
    cancel_unclaimed,
    read_back,
    read_batch_back,
)
from mend_engine.campaigns.simulate import read_order
from mend_engine.config import Config
from mend_engine.db.migrate import is_local_development
from mend_engine.events.payout_status import FINAL_STATUSES
from mend_engine.events.process import DENIED, batch_header, record_denied_batch, record_simulated_purchase
from mend_engine.paypal.http import PayPalError, PayPalHttp, PayPalResponse
from mend_engine.paypal.payouts import PAYOUTS_PATH, SnapshotRefused

DEMO_CANCEL_LOCK = 7731300006
DEMO_UNCLAIMED_AFTER = timedelta(minutes=10)
DEMO_CANCEL_MAX_ITEMS = 50
# Demo campaigns with items waiting, oldest batch first, and how many each has, leaving
# out every item resting after a failed cancel (ITEM_RESTING_SQL, the rule
# cancel_unclaimed uses). The stored status is compared as text: effective() keeps
# UNCLAIMED as it is, so this is the same answer cancel_unclaimed's own read gives.
_DEMO_WAITING = (
    "select o.campaign_id, count(*) from campaign_owners o "
    "join payout_batches b on b.campaign_id = o.campaign_id::text "
    "join payout_items i on i.sender_batch_id = b.sender_batch_id "
    "where o.role = 'demo' and i.status = %(unclaimed)s and not " + ITEM_RESTING_SQL + " "
    "group by o.campaign_id "
    "having max(b.created_at) <= now() - %(after)s "
    "order by max(b.created_at), o.campaign_id limit %(most)s"
)

REFRESH_LOCK = 7731300007
REFRESH_AFTER = timedelta(minutes=15)
DEV_REFRESH_AFTER_SETTING = "MEND_DEV_REFRESH_AFTER_SECONDS"
DEV_REFRESH_AFTER_SECONDS = range(30, 901)
# At most three digits, so no value reaches int() long enough to be slow or to raise.
_DEV_WAIT_SHAPE = re.compile(r"[0-9]{1,3}")
REFRESH_MAX_ITEMS = 50
REFRESH_MAX_BATCHES = 10
REFRESH_MAX_ORDERS = 10
REFRESH_ACTOR = "refresh"
# Statuses never read again: the final ones, and SUCCESS, whose ways on are a refund by
# the recipient and REVERSED, which PayPal documents only for web uploads; the item
# webhook reports either. effective() keeps each as it is, so comparing stored text with
# them gives the answer effective() would give, and an unknown status is read.
SETTLED_STATUSES = frozenset(FINAL_STATUSES | {"SUCCESS"})
# Items PayPal may still move, whose batch's payout_batch_id the ledger knows, that
# nothing has touched for REFRESH_AFTER, least recently first.
_REFRESH_DUE = (
    "select i.payout_item_id from payout_items i "
    "join payout_batches b on b.sender_batch_id = i.sender_batch_id "
    "where i.status <> all(%(settled)s) and b.payout_batch_id is not null and i.updated_at <= now() - %(after)s "
    "order by i.updated_at, i.payout_item_id limit %(most)s"
)
# When this job last read the batch, from its "payout_batch_reread" audit rows, or when
# the batch was written if never: the clock the item read keeps in updated_at.
_BATCH_TOUCHED = (
    "greatest(b.created_at, (select max(a.at) from audit_log a where a.action = 'payout_batch_reread' "
    "and a.detail ->> 'sender_batch_id' = b.sender_batch_id))"
)
# Batches whose payout_batch_id the ledger knows that hold fewer item rows than their
# frozen snapshot has items, untouched for REFRESH_AFTER, least recently first. A batch
# still short after a read goes behind every other, so none can hold the rest up.
_SHORT_BATCHES_DUE = (
    "select b.sender_batch_id from payout_batches b "
    "join approved_snapshots s on s.campaign_id::text = b.campaign_id "
    "where b.payout_batch_id is not null "
    "and (select count(*) from payout_items i where i.sender_batch_id = b.sender_batch_id) "
    "< jsonb_array_length(s.canonical_json::jsonb -> 'items') "
    "and " + _BATCH_TOUCHED + " <= now() - %(after)s "
    "order by " + _BATCH_TOUCHED + ", b.sender_batch_id limit %(most)s"
)
_ORDER_TOUCHED = (
    "greatest(o.created_at, (select max(a.at) from audit_log a where a.action = 'simulated_order_reread' "
    "and a.detail ->> 'paypal_order_id' = o.paypal_order_id))"
)
# Orders the simulate button created, with PayPal's order id stored and no purchase
# attributed under it, untouched for REFRESH_AFTER, least recently first.
_ORDERS_DUE = (
    "select o.paypal_order_id from simulated_orders o "
    "where o.paypal_order_id is not null "
    "and not exists (select 1 from attributions t where t.source_order = o.paypal_order_id) "
    "and " + _ORDER_TOUCHED + " <= now() - %(after)s "
    "order by " + _ORDER_TOUCHED + ", o.paypal_order_id limit %(most)s"
)


def dev_refresh_after(config: Config, env: Mapping[str, str]) -> timedelta | None:
    """The wait refresh_items uses in place of REFRESH_AFTER on a local machine, or None to keep REFRESH_AFTER.

    No webhook reaches a local machine, so there this job is the only way a submitted
    batch's items reach the ledger, and 15 minutes hides them from the demo. Returns
    MEND_DEV_REFRESH_AFTER_SECONDS as a timedelta only when all of these hold:
    is_local_development(config), the test migrate uses (MEND_DEV on, DATABASE_URL
    unset); PAYPAL_ENV in env is exactly "sandbox" once trimmed, as load_config reads
    it; and the setting, trimmed, is a whole number from 30 to 900. Otherwise None:
    every deployed engine has DATABASE_URL set and MEND_DEV off, so it never applies
    there. Both values come from env only, never the .env file, the same as the dev
    bridge's token, because dev:console sets them for each jobs run.
    """
    if not is_local_development(config) or (env.get("PAYPAL_ENV") or "").strip() != "sandbox":
        return None
    raw = (env.get(DEV_REFRESH_AFTER_SETTING) or "").strip()
    if not _DEV_WAIT_SHAPE.fullmatch(raw) or int(raw) not in DEV_REFRESH_AFTER_SECONDS:
        return None
    return timedelta(seconds=int(raw))


def refresh_items() -> dict:
    """Read back from PayPal what Mend's own records say PayPal may still change, so the ledger catches up without a webhook (C10).

    Three reads, in this order, each going on past any one failure:
    - Payout items: up to 50 whose status is not SUCCESS, FAILED, BLOCKED, RETURNED,
      REFUNDED or REVERSED (an unknown status counts as PENDING, so it is read) and
      whose row was last touched at least 15 minutes ago, least recently first, each
      read with campaigns.cancel.read_back: PayPal's answer is recorded through
      record_item_status only when it names the item and the batch the ledger holds.
      Each move writes, in the same transaction, one "payout_item_refreshed" audit
      row holding the item id and the statuses from and to. An item whose read fails
      for any reason, or whose answer the state machine refuses, has its row touched
      so it goes behind every other item.
    - Batches missing item rows: up to 10 whose payout_batch_id the ledger knows,
      holding fewer payout_items rows than their frozen snapshot has items, written
      or last read here at least 15 minutes ago, least recently first, so oldest
      first until read. Each is read with campaigns.cancel.read_batch_back, which
      records only items of this batch named in the snapshot. In the same
      transaction each inserted row writes one "payout_item_restored" audit row
      (item id, batch, status), each move one "payout_item_refreshed" row, and the
      batch one "payout_batch_reread" row (counts, outcome "read"). When PayPal
      answers DENIED for that same batch, listing items or not, every snapshot item
      is recorded FAILED through events.process.record_denied_batch and the row's
      outcome is "denied", with items_failed. A read that fails writes
      "payout_batch_reread" with outcome "failed" alone, so the batch goes behind
      every other. Each item skipped is logged with its reason.
    - Simulated orders: up to 10 the simulate button created whose PayPal order id
      is stored and has no attributed purchase, created or last read here at least
      15 minutes ago, least recently first. Each is read with
      campaigns.simulate.read_order and recorded through
      events.process.record_simulated_purchase, the path the capture webhook uses, so
      attribution is identical; one "simulated_order_reread" audit row holds the
      outcome and any fixed reason.
    Every audit row's actor is "refresh". Any error is logged with secrets removed
    under its own ref with the item, batch or order id. Holds its own lock, so two
    runs never overlap; ran is False, with nothing read, when another run holds it.
    On a local machine dev_refresh_after may replace the 15 minutes in all three
    reads with 30 seconds to 15 minutes; anywhere else nothing changes.

    Returns ran, items (items read), moved (forward moves from item and batch reads),
    unchanged and refused (item reads), failed (item, batch and order reads that
    failed), batches (batches read), restored (rows inserted), skipped (batch items
    not recorded), orders (orders read) and purchases (purchases attributed), and
    after, the wait in whole seconds, only when dev_refresh_after set it.

    Not covered: an item or batch whose payout_batch_id the ledger lacks is not
    read, nor a simulated order whose PayPal order id was never stored; the webhook
    or reconcile that fills the batch id in brings it into the next run. A batch
    PayPal keeps listing short, or an order PayPal never completes, is read again
    every 15 minutes behind everything not yet read.
    """

    def work(config: Config, conn: psycopg.Connection) -> dict:
        totals = {
            "items": 0, "moved": 0, "unchanged": 0, "refused": 0, "failed": 0,
            "batches": 0, "restored": 0, "skipped": 0, "orders": 0, "purchases": 0,
        }
        dev_after = dev_refresh_after(config, os.environ)
        after = REFRESH_AFTER if dev_after is None else dev_after
        reported = {} if dev_after is None else {"after": int(dev_after.total_seconds())}
        if not conn.execute("select pg_try_advisory_lock(%s)", (REFRESH_LOCK,)).fetchone()[0]:
            return {"ok": True, "ran": False, **totals, **reported}
        try:
            items = [
                payout_item_id
                for (payout_item_id,) in conn.execute(
                    _REFRESH_DUE,
                    {"settled": sorted(SETTLED_STATUSES), "after": after, "most": REFRESH_MAX_ITEMS},
                )
            ]
            batches = [row[0] for row in conn.execute(_SHORT_BATCHES_DUE, {"after": after, "most": REFRESH_MAX_BATCHES})]
            orders = [row[0] for row in conn.execute(_ORDERS_DUE, {"after": after, "most": REFRESH_MAX_ORDERS})]
            if items or batches or orders:
                with tasks._paypal_client(config) as http:
                    _refresh_items(config, conn, http, items, totals)
                    _restore_batches(config, conn, http, batches, totals)
                    _record_orders(config, conn, http, orders, totals)
        finally:
            conn.execute("select pg_advisory_unlock(%s)", (REFRESH_LOCK,))
        return {"ok": True, "ran": True, **totals, **reported}

    return tasks._run("refresh_items", work)


def _refresh_items(config: Config, conn: psycopg.Connection, http: PayPalHttp, due: list[str], totals: dict) -> None:
    for payout_item_id in due:
        totals["items"] += 1
        try:
            # One transaction, so a move is never stored without its audit row.
            with conn.transaction():
                change = read_back(conn, http, payout_item_id)
                if change.decision == "moved":
                    _audit(conn, "payout_item_refreshed", {"payout_item_id": payout_item_id, "from": change.previous, "to": change.stored})
        except Exception as exc:
            totals["failed"] += 1
            _log_failure(config, {"payout_item_id": payout_item_id}, exc)
            _send_to_back(conn, payout_item_id)
            continue
        if change.decision == "moved":
            totals["moved"] += 1
        elif change.decision == "refused":
            totals["refused"] += 1
            _send_to_back(conn, payout_item_id)
        else:
            totals["unchanged"] += 1


class _BatchAnswer:
    """Passes every call on to http and keeps PayPal's last answer for a batch.

    read_batch_back makes the GET itself and hands back only item changes, so this
    is how the scheduled read learns PayPal's batch_status without a second request.
    """

    def __init__(self, http: PayPalHttp) -> None:
        self._http = http
        self._asked: str | None = None
        self._body: dict | None = None

    def request(self, method: str, path: str, **kwargs: object) -> PayPalResponse:
        response = self._http.request(method, path, **kwargs)
        if method == "GET" and path.startswith(PAYOUTS_PATH + "/"):
            self._asked, self._body = path.rsplit("/", 1)[1], response.body
        return response

    def __getattr__(self, name: str) -> object:
        return getattr(self._http, name)

    def denied(self, sender_batch_id: str) -> bool:
        """True when PayPal answered DENIED for the very batch id read, under this sender_batch_id."""
        if self._body is None:
            return False
        named, status = batch_header(self._body)
        return named == (self._asked, sender_batch_id) and status == DENIED


def _restore_batches(config: Config, conn: psycopg.Connection, http: PayPalHttp, due: list[str], totals: dict) -> None:
    for sender_batch_id in due:
        totals["batches"] += 1
        answer = _BatchAnswer(http)
        try:
            # One transaction, so a restored row or a move is never stored without its audit row.
            with conn.transaction():
                try:
                    result = read_batch_back(conn, answer, sender_batch_id)
                except ReadBackRefused:
                    # A batch PayPal did not process may list no items; any other refusal stands.
                    if not answer.denied(sender_batch_id):
                        raise
                    result = BatchReadBack((), ())
                restored = moved = 0
                for payout_item_id, change in result.changes:
                    if change.decision == "new":
                        restored += 1
                        _audit(
                            conn,
                            "payout_item_restored",
                            {"payout_item_id": payout_item_id, "sender_batch_id": sender_batch_id, "status": change.stored},
                        )
                    elif change.decision == "moved":
                        moved += 1
                        _audit(conn, "payout_item_refreshed", {"payout_item_id": payout_item_id, "from": change.previous, "to": change.stored})
                reread = {"sender_batch_id": sender_batch_id, "outcome": "read", "restored": restored, "moved": moved, "skipped": len(result.skipped)}
                if answer.denied(sender_batch_id):
                    reread.update(outcome="denied", items_failed=record_denied_batch(conn, sender_batch_id))
                _audit(conn, "payout_batch_reread", reread)
        except Exception as exc:
            totals["failed"] += 1
            _log_failure(config, {"sender_batch_id": sender_batch_id}, exc)
            with conn.transaction():
                _audit(conn, "payout_batch_reread", {"sender_batch_id": sender_batch_id, "outcome": "failed"})
            continue
        totals["restored"] += restored
        totals["moved"] += moved
        totals["skipped"] += len(result.skipped)
        for payout_item_id, reason in result.skipped:
            tasks._log(
                {
                    "task": "refresh_items",
                    "ref": str(uuid.uuid4()),
                    "outcome": "skipped",
                    "sender_batch_id": sender_batch_id,
                    "payout_item_id": payout_item_id,
                    "reason": reason,
                }
            )


def _record_orders(config: Config, conn: psycopg.Connection, http: PayPalHttp, due: list[str], totals: dict) -> None:
    for paypal_order_id in due:
        totals["orders"] += 1
        try:
            # One transaction, so a purchase is never stored without its audit rows.
            with conn.transaction():
                match = simulated_order_for(conn, paypal_order_id)
                if match is None:
                    raise LookupError("no simulated order holds this PayPal order id")
                order = read_order(http, paypal_order_id)
                outcome, extra = record_simulated_purchase(conn, match, paypal_order_id, order)
                _audit(
                    conn,
                    "simulated_order_reread",
                    {"paypal_order_id": paypal_order_id, "campaign_id": str(match.campaign_id), "outcome": outcome, "reason": extra.get("reason")},
                )
        except Exception as exc:
            totals["failed"] += 1
            _log_failure(config, {"paypal_order_id": paypal_order_id}, exc)
            with conn.transaction():
                _audit(conn, "simulated_order_reread", {"paypal_order_id": paypal_order_id, "outcome": "failed"})
            continue
        if outcome == "purchase recorded":
            totals["purchases"] += 1


def _audit(conn: psycopg.Connection, action: str, detail: dict) -> None:
    conn.execute("insert into audit_log (actor, action, detail) values (%s, %s, %s)", (REFRESH_ACTOR, action, Jsonb(detail)))


def _send_to_back(conn: psycopg.Connection, payout_item_id: str) -> None:
    # record_item_status touches the row on every answer it stores; a failed read or a
    # refused move stores nothing, so without this the same items would lead every run.
    conn.execute("update payout_items set updated_at = now() where payout_item_id = %s", (payout_item_id,))


def _log_failure(config: Config, ids: dict, exc: Exception) -> None:
    if isinstance(exc, PayPalError):
        error = "paypal_unavailable"
    elif isinstance(exc, ReadBackRefused):
        error = "not_ours"
    elif isinstance(exc, SnapshotRefused):
        error = "snapshot_refused"
    else:
        error = "internal"
    tasks._log(
        {
            "task": "refresh_items",
            "ref": str(uuid.uuid4()),
            "outcome": "failed",
            "error": error,
            "exception": type(exc).__name__,
            **ids,
            "detail": tasks._scrub(str(exc), config),
            "trace": tasks._scrub(traceback.format_exc(), config),
        }
    )


def cancel_demo_unclaimed() -> dict:
    """Ask PayPal to return the cashback demo campaigns left unclaimed, so the shared demo pool refills (C20).

    Takes only campaigns a demo session created whose payout batch is at least 10
    minutes old and holds items the ledger has as UNCLAIMED, counting only items with
    no "payout_item_cancel_failed" audit row in the last hour; a campaign the owner
    created is never touched. Goes oldest batch first, cancelling each campaign
    through campaigns.cancel.cancel_unclaimed, which skips those same resting items,
    and asks PayPal about at most 50 items a run: a campaign with more waiting than
    the run has room for has as many cancelled as fit, and the rest wait for the next
    run. A campaign whose run ended with items PayPal could not answer for
    (CancelIncomplete) still adds what its run did. That, or any other error on one
    campaign, is logged with secrets removed under its own ref with the campaign id,
    counted in failed, and the run goes on to the next. Holds its own lock, so two
    runs never overlap; ran is False, with nothing read, when another run holds it.

    Returns ran, campaigns (how many were taken), and cancelled, returned_minor and
    not_cancellable summed from their CancelReports, and failed (campaigns logged).

    Not covered: a reward PayPal will not cancel stays UNCLAIMED, and counts against
    the demo pool, until PayPal returns it after 30 days or reports it claimed; it is
    asked about again once an hour, on its own.
    """

    def work(config: Config, conn: psycopg.Connection) -> dict:
        totals = {"campaigns": 0, "cancelled": 0, "returned_minor": 0, "not_cancellable": 0, "failed": 0}
        if not conn.execute("select pg_try_advisory_lock(%s)", (DEMO_CANCEL_LOCK,)).fetchone()[0]:
            return {"ok": True, "ran": False, **totals}
        try:
            waiting = conn.execute(
                _DEMO_WAITING,
                {
                    "unclaimed": UNCLAIMED,
                    "rest": CANCEL_REST_AFTER,
                    "after": DEMO_UNCLAIMED_AFTER,
                    "most": DEMO_CANCEL_MAX_ITEMS,
                },
            ).fetchall()
            taken: list[tuple[uuid.UUID, int]] = []
            room = DEMO_CANCEL_MAX_ITEMS
            for campaign_id, items in waiting:
                if room == 0:
                    break
                taken.append((campaign_id, min(items, room)))
                room -= min(items, room)
            if taken:
                with tasks._paypal_client(config) as http:
                    for campaign_id, share in taken:
                        totals["campaigns"] += 1
                        try:
                            report = cancel_unclaimed(conn, http, campaign_id, limit=share)
                        except CancelIncomplete as incomplete:
                            totals["failed"] += 1
                            _log_campaign_failure(config, campaign_id, incomplete)
                            report = incomplete.report
                        except Exception as exc:
                            totals["failed"] += 1
                            _log_campaign_failure(config, campaign_id, exc)
                            continue
                        totals["cancelled"] += report.cancelled
                        totals["returned_minor"] += report.returned_minor
                        totals["not_cancellable"] += report.not_cancellable
        finally:
            conn.execute("select pg_advisory_unlock(%s)", (DEMO_CANCEL_LOCK,))
        return {"ok": True, "ran": True, **totals}

    return tasks._run("cancel_demo_unclaimed", work)


def _log_campaign_failure(config: Config, campaign_id: uuid.UUID, exc: Exception) -> None:
    tasks._log(
        {
            "task": "cancel_demo_unclaimed",
            "ref": str(uuid.uuid4()),
            "outcome": "failed",
            "error": "paypal_unavailable" if isinstance(exc, PayPalError) else "internal",
            "exception": type(exc).__name__,
            "campaign_id": str(campaign_id),
            "detail": tasks._scrub(str(exc), config),
            "trace": tasks._scrub(traceback.format_exc(), config),
        }
    )


JOBS: dict[str, Callable[[], dict]] = {
    "purge": tasks.purge,
    "process_events": tasks.process_events,
    "reconcile": tasks.reconcile,
    "refresh_items": refresh_items,
    "cancel_demo_unclaimed": cancel_demo_unclaimed,
}


def run_jobs(names: Sequence[str]) -> bool:
    """Run each named job once, in order, print its answer, and return True only if every one answered ok."""
    all_ok = True
    for name in names:
        result = JOBS[name]()
        ok = type(result) is dict and result.get("ok") is True
        all_ok = all_ok and ok
        print(json.dumps({"job": name, **(result if type(result) is dict else {"ok": False})}, sort_keys=True), flush=True)
    return all_ok


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m mend_engine.jobs", description="Run the engine's scheduled jobs.")
    parser.add_argument("jobs", nargs="+", choices=["all", *JOBS], help='"all", or one or more job names')
    args = parser.parse_args(argv)
    if "all" in args.jobs and len(args.jobs) > 1:
        parser.error('"all" cannot be combined with job names')
    names = list(JOBS) if args.jobs == ["all"] else args.jobs
    return 0 if run_jobs(names) else 1


if __name__ == "__main__":
    sys.exit(main())
