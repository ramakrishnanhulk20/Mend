"""The scheduled jobs, run by the mend-jobs cron on Render every 5 minutes.

    python -m mend_engine.jobs all          purge, then process_events, reconcile and cancel_demo_unclaimed
    python -m mend_engine.jobs <job> ...    only the jobs named, in the order given

purge, process_events and reconcile are the engine tasks of the same name in tasks.py,
called in this process; cancel_demo_unclaimed is here because no route starts it. They
act for the shop itself, with no visitor session, which is why none takes an actor.
process_events, reconcile and cancel_demo_unclaimed each hold their own database lock
while they run, so two runs never act on the same thing (C20). Prints one JSON line per
job with its counts, or its error code and ref. purge runs first and every job runs even
when an earlier one fails, so neither a slow nor a failing PayPal holds up the 48-hour
purge (C27). Exits 1 when any job did not answer ok, otherwise 0.
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

from mend_engine import tasks
from mend_engine.campaigns.cancel import UNCLAIMED, cancel_unclaimed
from mend_engine.config import Config
from mend_engine.paypal.http import PayPalError

DEMO_CANCEL_LOCK = 7731300006
DEMO_UNCLAIMED_AFTER = timedelta(minutes=10)
DEMO_CANCEL_MAX_ITEMS = 50
# Demo campaigns with items waiting, oldest batch first, and how many each has. The
# stored status is compared as text: effective() keeps UNCLAIMED as it is, so this is
# the same answer cancel_unclaimed's own read of the ledger gives.
_DEMO_WAITING = (
    "select o.campaign_id, count(*) from campaign_owners o "
    "join payout_batches b on b.campaign_id = o.campaign_id::text "
    "join payout_items i on i.sender_batch_id = b.sender_batch_id "
    "where o.role = 'demo' and i.status = %s "
    "group by o.campaign_id "
    "having max(b.created_at) <= now() - %s and count(*) <= %s "
    "order by max(b.created_at), o.campaign_id limit %s"
)


def cancel_demo_unclaimed() -> dict:
    """Ask PayPal to return the cashback demo campaigns left unclaimed, so the shared demo pool refills (C20).

    Takes only campaigns a demo session created whose payout batch is at least 10
    minutes old and holds items the ledger has as UNCLAIMED; a campaign the owner
    created is never touched. Goes oldest batch first, cancelling each campaign
    through campaigns.cancel.cancel_unclaimed, and stops before the campaign whose
    waiting items would take the run past 50. Any error on one campaign, a PayPal
    error or anything else, is logged with secrets removed under its own ref with
    the campaign id, counted in failed, and the run goes on to the next.
    Holds its own lock, so two runs never overlap; ran is False, with nothing read,
    when another run holds it.

    Returns ran, campaigns (how many were taken), and cancelled, returned_minor and
    not_cancellable summed from their CancelReports, and failed.

    Not covered: a demo campaign with more than 50 items waiting is never taken; its
    creator's own cancel or PayPal's 30-day return brings that money back. The count
    is read just before the cancels, so an item a webhook turns UNCLAIMED in between
    is asked about too and can take a run a few items past 50.
    """

    def work(config: Config, conn: psycopg.Connection) -> dict:
        totals = {"campaigns": 0, "cancelled": 0, "returned_minor": 0, "not_cancellable": 0, "failed": 0}
        if not conn.execute("select pg_try_advisory_lock(%s)", (DEMO_CANCEL_LOCK,)).fetchone()[0]:
            return {"ok": True, "ran": False, **totals}
        try:
            waiting = conn.execute(
                _DEMO_WAITING, (UNCLAIMED, DEMO_UNCLAIMED_AFTER, DEMO_CANCEL_MAX_ITEMS, DEMO_CANCEL_MAX_ITEMS)
            ).fetchall()
            taken: list[uuid.UUID] = []
            room = DEMO_CANCEL_MAX_ITEMS
            for campaign_id, items in waiting:
                if items > room:
                    break
                taken.append(campaign_id)
                room -= items
            if taken:
                with tasks._paypal_client(config) as http:
                    for campaign_id in taken:
                        totals["campaigns"] += 1
                        try:
                            report = cancel_unclaimed(conn, http, campaign_id)
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
