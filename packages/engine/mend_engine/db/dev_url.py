"""Print a postgresql:// URL for the local dev database (pgserver) that Node clients can use.

    python -m mend_engine.db.dev_url          start or reuse the server, apply the schema,
                                              print the URL and leave the server running
    python -m mend_engine.db.dev_url --hold   the same, then keep a handle on the server
                                              until stdin closes

pgserver stops Postgres when the last process holding it exits. --hold lets the web
tests and the web proof keep it alive while they run, even if an engine test run
finishes meanwhile. Development only: refuses unless MEND_DEV is on. Stdout carries
the URL and nothing else.
"""

from __future__ import annotations

import argparse
import dataclasses
import sys
from pathlib import Path

import pgserver

from mend_engine.config import ConfigError, load_config
from mend_engine.db.connect import PGDATA, connect

ENV_PATH = Path(__file__).resolve().parents[4] / ".env"


def dev_url(*, hold: bool) -> str:
    """Start or reuse the dev pgserver, apply schema.sql, and return its URL.

    Raises ConfigError if the env is invalid or MEND_DEV is off. DATABASE_URL is
    ignored: this is always the local server.
    """
    config = load_config(str(ENV_PATH) if ENV_PATH.is_file() else None)
    if not config.dev:
        raise ConfigError("MEND_DEV must be on to use the local dev database")
    # pgserver keeps one handle per data directory per process, so connect() reuses this
    # one and its cleanup mode. None leaves Postgres running after this process exits.
    server = pgserver.get_server(PGDATA, cleanup_mode="stop" if hold else None)
    conn = connect(dataclasses.replace(config, database_url=None))
    conn.close()
    return server.get_uri()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m mend_engine.db.dev_url",
        description="Print a postgresql:// URL for the local dev database.",
    )
    parser.add_argument("--hold", action="store_true", help="keep the database handle until stdin closes")
    args = parser.parse_args(argv)
    try:
        url = dev_url(hold=args.hold)
    except ConfigError as exc:
        print(f"dev_url: {exc}", file=sys.stderr)
        return 2
    print(url, flush=True)
    if args.hold:
        sys.stdin.read()
    return 0


if __name__ == "__main__":
    sys.exit(main())
