"""The scheduled jobs, run by the mend-jobs cron on Render every 5 minutes.

    python -m mend_engine.jobs all          process_events, then reconcile, then purge
    python -m mend_engine.jobs <job> ...    only the jobs named, in the order given

Each job is the engine task of the same name in tasks.py, called in this process. They
act for the shop itself, with no visitor session: the same work the owner's admin routes
start, which is why these three tasks take no actor. process_events and reconcile each
hold their own database lock while they run, so two runs never act on the same thing
(C20). Prints one JSON line per job with its counts, or its error code and ref. Every
job runs even when an earlier one fails, so a PayPal outage never holds up the 48-hour
purge (C27). Exits 1 when any job did not answer ok, otherwise 0.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable, Sequence

from mend_engine import tasks

JOBS: dict[str, Callable[[], dict]] = {
    "process_events": tasks.process_events,
    "reconcile": tasks.reconcile,
    "purge": tasks.purge,
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
