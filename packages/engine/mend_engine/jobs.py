"""The scheduled jobs, run by the mend-jobs cron on Render every 5 minutes.

    python -m mend_engine.jobs all          purge, process_events, reconcile, refresh_items, then cancel_demo_unclaimed
    python -m mend_engine.jobs <job> ...    only the jobs named, in the order given

purge, process_events and reconcile are the engine tasks of the same name in tasks.py,
called in this process; refresh_items and cancel_demo_unclaimed are here because no
route starts them. They act for the shop itself, with no visitor session, which is why
none takes an actor. process_events, reconcile, refresh_items and cancel_demo_unclaimed
each hold their own database lock while they run, so two runs never act on the same
thing (C20). Prints one JSON line per job with its counts, or its error code and ref.
purge runs first and every job runs even when an earlier one fails, so neither a slow
nor a failing PayPal holds up the 48-hour purge (C27). Exits 1 when any job did not
answer ok, otherwise 0.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
import uuid
from collections.abc import Callable, Sequence
from datetime import timedelta

import psycopg
from psycopg.types.json import Jsonb

from mend_engine import tasks
from mend_engine.campaigns.cancel import UNCLAIMED, ReadBackRefused, cancel_unclaimed, read_back
from mend_engine.config import Config
from mend_engine.events.payout_status import FINAL_STATUSES
from mend_engine.paypal.http import PayPalError

DEMO_CANCEL_LOCK = 7731300006
DEMO_UNCLAIMED_AFTER = timedelta(minutes=10)
DEMO_CANCEL_MAX_ITEMS = 50
# A campaign with a refused or failed cancel is left alone this long, so items PayPal
# will not cancel are not asked about again every run ahead of everyone else's.
DEMO_CANCEL_RETRY_AFTER = timedelta(hours=1)
# Demo campaigns with items waiting, oldest batch first, and how many each has, leaving
# out any campaign with a payout_item_cancel_failed row in the last hour. The stored
# status is compared as text: effective() keeps UNCLAIMED as it is, so this is the same
# answer cancel_unclaimed's own read of the ledger gives.
_DEMO_WAITING = (
    "select o.campaign_id, count(*) from campaign_owners o "
    "join payout_batches b on b.campaign_id = o.campaign_id::text "
    "join payout_items i on i.sender_batch_id = b.sender_batch_id "
    "where o.role = 'demo' and i.status = %(unclaimed)s and not exists ("
    "select 1 from audit_log a "
    "join payout_items fi on fi.payout_item_id = a.detail ->> 'payout_item_id' "
    "join payout_batches fb on fb.sender_batch_id = fi.sender_batch_id "
    "where a.action = 'payout_item_cancel_failed' and a.at > now() - %(retry_after)s "
    "and fb.campaign_id = o.campaign_id::text) "
    "group by o.campaign_id "
    "having max(b.created_at) <= now() - %(after)s "
    "order by max(b.created_at), o.campaign_id limit %(most)s"
)

REFRESH_LOCK = 7731300007
REFRESH_AFTER = timedelta(minutes=15)
REFRESH_MAX_ITEMS = 50
REFRESH_ACTOR = "refresh"
# Statuses never read again: the final ones, and SUCCESS, whose one way on (REFUNDED)
# is the shop's own doing. effective() keeps each as it is, so comparing stored text
# with them gives the answer effective() would give, and an unknown status is read.
SETTLED_STATUSES = frozenset(FINAL_STATUSES | {"SUCCESS"})
# Items PayPal may still move, whose batch's payout_batch_id the ledger knows, that
# nothing has touched for REFRESH_AFTER, least recently first.
_REFRESH_DUE = (
    "select i.payout_item_id from payout_items i "
    "join payout_batches b on b.sender_batch_id = i.sender_batch_id "
    "where i.status <> all(%(settled)s) and b.payout_batch_id is not null and i.updated_at <= now() - %(after)s "
    "order by i.updated_at, i.payout_item_id limit %(most)s"
)


def refresh_items() -> dict:
    """Read back from PayPal the payout items whose status PayPal may still move, so the ledger catches up without a webhook (C10).

    Takes up to 50 items whose status is not SUCCESS, FAILED, BLOCKED, RETURNED or
    REFUNDED (an unknown status counts as PENDING, so it is read) and whose row was
    last touched at least 15 minutes ago, least recently first, and reads each with
    campaigns.cancel.read_back: PayPal's answer is recorded through
    record_item_status only when it names the item and the batch the ledger holds.
    Each move writes, in the same transaction, one "payout_item_refreshed" audit row
    (actor "refresh") holding the item id and the statuses from and to. An item
    whose read fails for any
    reason, or whose answer the state machine refuses, has its row touched so it
    goes behind every other item, then the run goes on; any error is logged with
    secrets removed under its own ref with the item id. Holds its own lock, so two
    runs never overlap; ran is False, with nothing read, when another run holds it.

    Returns ran, items (how many were read), and moved, unchanged, refused and failed.

    Not covered: an item whose batch's payout_batch_id the ledger lacks is not read;
    the webhook or reconcile that fills the id in brings it into the next run.
    """

    def work(config: Config, conn: psycopg.Connection) -> dict:
        totals = {"items": 0, "moved": 0, "unchanged": 0, "refused": 0, "failed": 0}
        if not conn.execute("select pg_try_advisory_lock(%s)", (REFRESH_LOCK,)).fetchone()[0]:
            return {"ok": True, "ran": False, **totals}
        try:
            due = [
                payout_item_id
                for (payout_item_id,) in conn.execute(
                    _REFRESH_DUE,
                    {"settled": sorted(SETTLED_STATUSES), "after": REFRESH_AFTER, "most": REFRESH_MAX_ITEMS},
                )
            ]
            if due:
                with tasks._paypal_client(config) as http:
                    for payout_item_id in due:
                        totals["items"] += 1
                        try:
                            # One transaction, so a move is never stored without its audit row.
                            with conn.transaction():
                                change = read_back(conn, http, payout_item_id)
                                if change.decision == "moved":
                                    conn.execute(
                                        "insert into audit_log (actor, action, detail) values (%s, %s, %s)",
                                        (
                                            REFRESH_ACTOR,
                                            "payout_item_refreshed",
                                            Jsonb({"payout_item_id": payout_item_id, "from": change.previous, "to": change.stored}),
                                        ),
                                    )
                        except Exception as exc:
                            totals["failed"] += 1
                            _log_item_failure(config, payout_item_id, exc)
                            _send_to_back(conn, payout_item_id)
                            continue
                        if change.decision == "moved":
                            totals["moved"] += 1
                        elif change.decision == "refused":
                            totals["refused"] += 1
                            _send_to_back(conn, payout_item_id)
                        else:
                            totals["unchanged"] += 1
        finally:
            conn.execute("select pg_advisory_unlock(%s)", (REFRESH_LOCK,))
        return {"ok": True, "ran": True, **totals}

    return tasks._run("refresh_items", work)


def _send_to_back(conn: psycopg.Connection, payout_item_id: str) -> None:
    # record_item_status touches the row on every answer it stores; a failed read or a
    # refused move stores nothing, so without this the same items would lead every run.
    conn.execute("update payout_items set updated_at = now() where payout_item_id = %s", (payout_item_id,))


def _log_item_failure(config: Config, payout_item_id: str, exc: Exception) -> None:
    if isinstance(exc, PayPalError):
        error = "paypal_unavailable"
    elif isinstance(exc, ReadBackRefused):
        error = "not_ours"
    else:
        error = "internal"
    tasks._log(
        {
            "task": "refresh_items",
            "ref": str(uuid.uuid4()),
            "outcome": "failed",
            "error": error,
            "exception": type(exc).__name__,
            "payout_item_id": payout_item_id,
            "detail": tasks._scrub(str(exc), config),
            "trace": tasks._scrub(traceback.format_exc(), config),
        }
    )


def cancel_demo_unclaimed() -> dict:
    """Ask PayPal to return the cashback demo campaigns left unclaimed, so the shared demo pool refills (C20).

    Takes only campaigns a demo session created whose payout batch is at least 10
    minutes old and holds items the ledger has as UNCLAIMED, leaving out any campaign
    with a "payout_item_cancel_failed" audit row in the last hour; a campaign the
    owner created is never touched. Goes oldest batch first, cancelling each campaign
    through campaigns.cancel.cancel_unclaimed, and asks PayPal about at most 50 items
    a run: a campaign with more waiting than the run has room for has as many
    cancelled as fit, and the rest wait for the next run. Any error on one campaign,
    a PayPal error or anything else, is logged with secrets removed under its own ref
    with the campaign id, counted in failed, and the run goes on to the next.
    Holds its own lock, so two runs never overlap; ran is False, with nothing read,
    when another run holds it.

    Returns ran, campaigns (how many were taken), and cancelled, returned_minor and
    not_cancellable summed from their CancelReports, and failed.

    Not covered: a reward PayPal will not cancel stays UNCLAIMED, and counts against
    the demo pool, until PayPal returns it after 30 days or reports it claimed; its
    campaign is asked about again once an hour.
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
                    "retry_after": DEMO_CANCEL_RETRY_AFTER,
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
                        except Exception as exc:
                            totals["failed"] += 1
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
                            continue
                        totals["cancelled"] += report.cancelled
                        totals["returned_minor"] += report.returned_minor
                        totals["not_cancellable"] += report.not_cancellable
        finally:
            conn.execute("select pg_advisory_unlock(%s)", (DEMO_CANCEL_LOCK,))
        return {"ok": True, "ran": True, **totals}

    return tasks._run("cancel_demo_unclaimed", work)


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
