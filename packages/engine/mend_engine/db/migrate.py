"""Applying schema.sql: the one place the engine changes the database's structure (C22).

    python -m mend_engine.db.migrate

Applies schema.sql once to DATABASE_URL or, with MEND_DEV on and no DATABASE_URL, to
the local pgserver database, then prints the file's sha256 and "schema applied". The
file's first statement takes an advisory lock, so two runs at once take turns, and
every statement is idempotent, so a second run changes nothing already in place.
Engine tasks never call this: connect() only checks that the schema is there.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

import psycopg

from mend_engine.config import Config, ConfigError, load_config
from mend_engine.db.connect import SCHEMA_PATH, open_connection

ENV_PATH = Path(__file__).resolve().parents[4] / ".env"


def schema_sha256() -> str:
    """The sha256 of schema.sql as it is on disk, so a deploy log says which version it applied."""
    return hashlib.sha256(SCHEMA_PATH.read_bytes()).hexdigest()


def apply_schema(conn: psycopg.Connection) -> None:
    """Run schema.sql once on conn, in one transaction, so its advisory lock is held until it is all in place."""
    with conn.transaction():
        conn.execute(SCHEMA_PATH.read_text(encoding="utf-8"))


def migrate(config: Config) -> str:
    """Apply schema.sql to the database config points at and return the file's sha256."""
    with open_connection(config) as conn:
        apply_schema(conn)
    return schema_sha256()


def main(argv: list[str] | None = None) -> int:
    argparse.ArgumentParser(prog="python -m mend_engine.db.migrate", description="Apply schema.sql to the configured database.").parse_args(argv)
    try:
        config = load_config(str(ENV_PATH) if ENV_PATH.is_file() else None)
        digest = migrate(config)
    except ConfigError as exc:
        print(f"migrate: {exc}", file=sys.stderr)
        return 2
    except psycopg.Error as exc:
        print(f"migrate: the schema was not applied ({type(exc).__name__})", file=sys.stderr)
        return 1
    print(f"schema sha256 {digest}")
    print("schema applied")
    return 0


if __name__ == "__main__":
    sys.exit(main())
