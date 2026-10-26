"""Applying schema.sql and the services' limited role: the one place the engine changes the database's structure (C22).

    python -m mend_engine.db.migrate

Applies schema.sql once to DATABASE_URL or, with MEND_DEV on and no DATABASE_URL, to
the local pgserver database, then makes sure the login role mend_app exists with exactly
the rights the deployed services need, and prints the file's sha256, "schema applied" and
what happened to the role. The file's first statement takes an advisory lock, so two runs
at once take turns, and every statement is idempotent, so a second run changes nothing
already in place. Engine tasks never call this: connect() only checks that the schema is there.

mend_app may read and write rows and nothing more: SELECT, INSERT, UPDATE and DELETE on
every table except audit_log, where it may only SELECT and INSERT (C23); USAGE and SELECT on
sequences; USAGE on the schema; CONNECT on the database. It owns nothing, so it can never
alter or drop a table or disable a trigger, and it holds no CREATE, TRUNCATE, REFERENCES or
TRIGGER right. Every run revokes whatever the role holds and grants that set again, so the
result is the same however often it runs, and default privileges give tables a later
schema.sql adds the same row rights.

The role's password comes from MEND_APP_DB_PASSWORD in the process environment. It is
needed to create the role, and when it is set it also resets the password. It is turned
into a SCRAM verifier here, so the plain password never reaches the server's SQL or logs.
The local development database needs no role: there, with no password and no role, the
role step is skipped. Anywhere else a missing role and no password is refused before
anything changes.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import psycopg
from psycopg import sql

from mend_engine.config import Config, ConfigError, load_config
from mend_engine.db.connect import SCHEMA_PATH, open_connection

ENV_PATH = Path(__file__).resolve().parents[4] / ".env"
APP_ROLE = "mend_app"
APP_PASSWORD_ENV = "MEND_APP_DB_PASSWORD"
MIN_PASSWORD_CHARS = 32
# Rows here are permanent: the app role may add to them, never change or remove them.
APPEND_ONLY_TABLES = ("audit_log",)
# The lock schema.sql's own blocks take, so a grant run and a schema apply take turns.
SCHEMA_LOCK = 7731300001

_PASSWORD_SHAPE = re.compile(r"[\x21-\x7e]+", re.ASCII)

# In this order, in one transaction: everything the role holds is taken back, then exactly
# the services' rights are given. PUBLIC has no CREATE on a new schema from Postgres 15 on;
# the revoke keeps it so wherever that default differs.
_GRANTS = (
    "revoke all on database {database} from {role}",
    "grant connect on database {database} to {role}",
    "revoke all on schema {schema} from {role}",
    "grant usage on schema {schema} to {role}",
    "revoke create on schema {schema} from public",
    "revoke all on all tables in schema {schema} from {role}",
    "grant select, insert, update, delete on all tables in schema {schema} to {role}",
    "revoke all on all sequences in schema {schema} from {role}",
    "grant usage, select on all sequences in schema {schema} to {role}",
    "alter default privileges in schema {schema} grant select, insert, update, delete on tables to {role}",
    "alter default privileges in schema {schema} grant usage, select on sequences to {role}",
)


@dataclass(frozen=True)
class Migrated:
    """sha256 is schema.sql's; app_role is "created", "password set", "kept" or "skipped"."""

    sha256: str
    app_role: str


def schema_sha256() -> str:
    """The sha256 of schema.sql as it is on disk, so a deploy log says which version it applied."""
    return hashlib.sha256(SCHEMA_PATH.read_bytes()).hexdigest()


def apply_schema(conn: psycopg.Connection) -> None:
    """Run schema.sql once on conn, in one transaction, so its advisory lock is held until it is all in place."""
    with conn.transaction():
        conn.execute(SCHEMA_PATH.read_text(encoding="utf-8"))


def is_local_development(config: Config) -> bool:
    """True for the bundled pgserver database: MEND_DEV on and no DATABASE_URL."""
    return config.dev and not config.database_url


def checked_password(password: str | None) -> str | None:
    """password if it is usable for the role, None if not given. Raises ConfigError naming the setting, never the value."""
    if password is None:
        return None
    if len(password) < MIN_PASSWORD_CHARS or not _PASSWORD_SHAPE.fullmatch(password):
        raise ConfigError(f"{APP_PASSWORD_ENV} must be at least {MIN_PASSWORD_CHARS} printable characters with no spaces")
    return password


def _role_exists(conn: psycopg.Connection, role: str) -> bool:
    return conn.execute("select 1 from pg_roles where rolname = %s", (role,)).fetchone() is not None


def grant_app_role(conn: psycopg.Connection, password: str | None, role: str = APP_ROLE) -> str:
    """Create or re-password the login role and give it exactly the services' rights on conn's current schema.

    Returns "created", "password set" (it existed and password was given) or "kept". The
    role is created with Postgres's defaults: no superuser, no CREATEDB, no CREATEROLE, no
    replication, no BYPASSRLS. Raises ConfigError, with nothing changed, when the role does
    not exist and password is None.
    """
    password = checked_password(password)
    name = sql.Identifier(role)
    with conn.transaction():
        conn.execute("select pg_advisory_xact_lock(%s)", (SCHEMA_LOCK,))
        exists = _role_exists(conn, role)
        if password is None and not exists:
            raise ConfigError(f"{APP_PASSWORD_ENV} must be set to create the {role} role")
        if password is None:
            outcome = "kept"
        else:
            verifier = sql.Literal(conn.pgconn.encrypt_password(password.encode(), role.encode(), b"scram-sha-256").decode("ascii"))
            statement = "alter role {} with login password {}" if exists else "create role {} with login password {}"
            conn.execute(sql.SQL(statement).format(name, verifier))
            outcome = "password set" if exists else "created"
        schema, database = conn.execute("select current_schema(), current_database()").fetchone()
        names = {"role": name, "schema": sql.Identifier(schema), "database": sql.Identifier(database)}
        for grant in _GRANTS:
            conn.execute(sql.SQL(grant).format(**names))
        for table in APPEND_ONLY_TABLES:
            conn.execute(sql.SQL("revoke update, delete on table {}.{} from {}").format(sql.Identifier(schema), sql.Identifier(table), name))
    return outcome


def migrate(config: Config, app_password: str | None = None, *, role: str = APP_ROLE) -> Migrated:
    """Apply schema.sql to the database config points at, then give the app role its rights.

    Refuses with ConfigError, before anything changes, for a password that is too short, or
    when the role does not exist, no password is given and this is not the local
    development database. On the local development database with neither, the role step
    is skipped.
    """
    password = checked_password(app_password)
    with open_connection(config) as conn:
        if password is None and not _role_exists(conn, role):
            if not is_local_development(config):
                raise ConfigError(f"{APP_PASSWORD_ENV} must be set to create the {role} role")
            apply_schema(conn)
            return Migrated(schema_sha256(), "skipped")
        apply_schema(conn)
        outcome = grant_app_role(conn, password, role)
    return Migrated(schema_sha256(), outcome)


def main(argv: list[str] | None = None) -> int:
    argparse.ArgumentParser(prog="python -m mend_engine.db.migrate", description="Apply schema.sql and the app role to the configured database.").parse_args(argv)
    try:
        config = load_config(str(ENV_PATH) if ENV_PATH.is_file() else None)
        result = migrate(config, os.environ.get(APP_PASSWORD_ENV) or None)
    except ConfigError as exc:
        print(f"migrate: {exc}", file=sys.stderr)
        return 2
    except psycopg.Error as exc:
        print(f"migrate: the schema was not applied ({type(exc).__name__})", file=sys.stderr)
        return 1
    print(f"schema sha256 {result.sha256}")
    print("schema applied")
    print(f"app role {APP_ROLE}: {result.app_role}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
