"""Applying schema.sql and the services' database roles: the one place the engine changes the database's structure (C22).

    python -m mend_engine.db.migrate [--drop-legacy-role]

Applies schema.sql once to DATABASE_URL or, with MEND_DEV on and no DATABASE_URL, to
the local pgserver database, then makes sure the two login roles the deployed services use
exist with exactly the rights each needs, and prints the file's sha256, "schema applied"
and what happened to each role. The file's first statement takes an advisory lock, so two
runs at once take turns, and every statement is idempotent, so a second run changes
nothing already in place. Engine tasks never call this: connect() only checks the schema.

mend_engine (mend-engine and mend-jobs) may read and write rows and nothing more: SELECT,
INSERT, UPDATE and DELETE on every table except audit_log, where it may only SELECT and
INSERT (C23); USAGE and SELECT on sequences; default privileges give it the same on tables
a later schema.sql adds.

mend_web (mend-web) holds only what the website's own SQL needs, table by table (the lists
below): it can never read or write the payout ledger, members, campaigns or the model's
facts, and a table a later schema.sql adds is closed to it until it is named here.

Neither role owns anything, so neither can alter or drop a table or disable a trigger, and
neither holds CREATE, TRUNCATE, REFERENCES or TRIGGER. Every run revokes whatever a role
holds and grants its set again, so the result is the same however often it runs.

Passwords come from MEND_ENGINE_DB_PASSWORD and MEND_WEB_DB_PASSWORD in the process
environment. A password is needed to create its role and, when set, also resets it. It is
turned into a SCRAM verifier here, so the plain password never reaches the server's SQL or
logs. The local development database needs no roles: there, with no password and no role,
the role step is skipped. Anywhere else a missing role with no password is refused before
anything changes.

mend_app, the single role every service used to share, is dropped by --drop-legacy-role
once no service uses it: never while a connection as mend_app is open.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

import psycopg
from psycopg import sql

from mend_engine.config import Config, ConfigError, load_config
from mend_engine.db.connect import SCHEMA_PATH, open_connection

ENV_PATH = Path(__file__).resolve().parents[4] / ".env"
ENGINE_ROLE = "mend_engine"
WEB_ROLE = "mend_web"
LEGACY_ROLE = "mend_app"
ENGINE_PASSWORD_ENV = "MEND_ENGINE_DB_PASSWORD"
WEB_PASSWORD_ENV = "MEND_WEB_DB_PASSWORD"
MIN_PASSWORD_CHARS = 32
# Rows here are permanent: the engine role may add to them, never change or remove them.
APPEND_ONLY_TABLES = ("audit_log",)
# The lock schema.sql's own blocks take, so a grant run and a schema apply take turns.
SCHEMA_LOCK = 7731300001

# Every table mend-web's SQL names, from packages/web/src/server (audit.ts, ratelimit.ts,
# runs.ts, sessions.ts, webhook-signature.ts and webhooks.ts, read 2026-10-27), plus
# claude_usage, where the website counts its Claude calls.
WEB_INSERT_ONLY = ("audit_log",)
# The webhook's replay check reads which transmission ids the engine already decided (C9).
WEB_READ_ONLY = ("event_outcomes",)
WEB_READ_AND_INSERT = ("paypal_events",)
WEB_WRITES = ("sessions", "run_owners", "rate_limit_hits", "paypal_certs", "claude_usage")
# Money, members and campaigns change only through the engine's own checks.
NEVER_WEB_WRITES = (
    "payout_batches",
    "payout_items",
    "members",
    "campaigns",
    "campaign_members",
    "event_outcomes",
    "model_facts",
    "approved_snapshots",
)

_WEB_TABLES = WEB_INSERT_ONLY + WEB_READ_ONLY + WEB_READ_AND_INSERT + WEB_WRITES
if set(WEB_INSERT_ONLY + WEB_READ_AND_INSERT + WEB_WRITES) & set(NEVER_WEB_WRITES):
    raise RuntimeError("a table mend-web must never write is in its grant lists")

_PASSWORD_SHAPE = re.compile(r"[\x21-\x7e]+", re.ASCII)

# In this order, in one transaction: everything the role holds is taken back. PUBLIC has no
# CREATE on a new schema from Postgres 15 on; the revoke keeps it so wherever that differs.
_RESET = (
    "revoke all on database {database} from {role}",
    "grant connect on database {database} to {role}",
    "revoke all on schema {schema} from {role}",
    "grant usage on schema {schema} to {role}",
    "revoke create on schema {schema} from public",
    "revoke all on all tables in schema {schema} from {role}",
    "revoke all on all sequences in schema {schema} from {role}",
    "alter default privileges in schema {schema} revoke all on tables from {role}",
    "alter default privileges in schema {schema} revoke all on sequences from {role}",
)
_ENGINE_GRANTS = (
    "grant select, insert, update, delete on all tables in schema {schema} to {role}",
    "grant usage, select on all sequences in schema {schema} to {role}",
    "alter default privileges in schema {schema} grant select, insert, update, delete on tables to {role}",
    "alter default privileges in schema {schema} grant usage, select on sequences to {role}",
)
_DROP = (
    "revoke all on database {database} from {role}",
    "revoke all on schema {schema} from {role}",
    "revoke all on all tables in schema {schema} from {role}",
    "revoke all on all sequences in schema {schema} from {role}",
    "alter default privileges in schema {schema} revoke all on tables from {role}",
    "alter default privileges in schema {schema} revoke all on sequences from {role}",
    "drop role {role}",
)
# Sequences behind the columns of the tables the website inserts into, found from the
# catalog so a serial column added later is covered without a list to keep.
_OWNED_SEQUENCES = (
    "select seq.relname from pg_class seq "
    "join pg_depend d on d.objid = seq.oid and d.classid = 'pg_class'::regclass "
    "and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i') "
    "join pg_class t on t.oid = d.refobjid "
    "where seq.relkind = 'S' and seq.relnamespace = %s::regnamespace and t.relname = any(%s) order by 1"
)


@dataclass(frozen=True)
class Migrated:
    """sha256 is schema.sql's. roles maps each role to "created", "password set", "kept" or
    "skipped"; legacy is "dropped", "absent", "left" or "in use (N open connections)"."""

    sha256: str
    roles: dict[str, str] = field(default_factory=dict)
    legacy: str = "absent"


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


def checked_password(password: str | None, setting: str) -> str | None:
    """password if it is usable for a role, None if not given. Raises ConfigError naming the setting, never the value."""
    if password is None:
        return None
    if len(password) < MIN_PASSWORD_CHARS or not _PASSWORD_SHAPE.fullmatch(password):
        raise ConfigError(f"{setting} must be at least {MIN_PASSWORD_CHARS} printable characters with no spaces")
    return password


def _role_exists(conn: psycopg.Connection, role: str) -> bool:
    return conn.execute("select 1 from pg_roles where rolname = %s", (role,)).fetchone() is not None


def _login_role(conn: psycopg.Connection, role: str, password: str | None, setting: str) -> str:
    """Create or re-password the login role inside the caller's transaction; "created", "password set" or "kept".

    The role is created with Postgres's defaults: no superuser, no CREATEDB, no CREATEROLE,
    no replication, no BYPASSRLS. Raises ConfigError when it does not exist and password is None.
    """
    exists = _role_exists(conn, role)
    if password is None and not exists:
        raise ConfigError(f"{setting} must be set to create the {role} role")
    if password is None:
        return "kept"
    verifier = sql.Literal(conn.pgconn.encrypt_password(password.encode(), role.encode(), b"scram-sha-256").decode("ascii"))
    statement = "alter role {} with login password {}" if exists else "create role {} with login password {}"
    conn.execute(sql.SQL(statement).format(sql.Identifier(role), verifier))
    return "password set" if exists else "created"


def _names(conn: psycopg.Connection, role: str) -> dict[str, sql.Identifier]:
    schema, database = conn.execute("select current_schema(), current_database()").fetchone()
    return {"role": sql.Identifier(role), "schema": sql.Identifier(schema), "database": sql.Identifier(database), "_schema": schema}


def _run(conn: psycopg.Connection, statements: Sequence[str], names: dict) -> None:
    identifiers = {key: value for key, value in names.items() if not key.startswith("_")}
    for statement in statements:
        conn.execute(sql.SQL(statement).format(**identifiers))


def grant_engine_role(conn: psycopg.Connection, password: str | None, role: str = ENGINE_ROLE) -> str:
    """Create or re-password the engine's login role and give it exactly its rights on conn's current schema.

    Returns "created", "password set" or "kept". Raises ConfigError, with nothing changed,
    when the role does not exist and password is None.
    """
    password = checked_password(password, ENGINE_PASSWORD_ENV)
    with conn.transaction():
        conn.execute("select pg_advisory_xact_lock(%s)", (SCHEMA_LOCK,))
        outcome = _login_role(conn, role, password, ENGINE_PASSWORD_ENV)
        names = _names(conn, role)
        _run(conn, _RESET + _ENGINE_GRANTS, names)
        for table in APPEND_ONLY_TABLES:
            conn.execute(sql.SQL("revoke update, delete on table {}.{} from {}").format(names["schema"], sql.Identifier(table), names["role"]))
    return outcome


def grant_web_role(conn: psycopg.Connection, password: str | None, role: str = WEB_ROLE) -> str:
    """Create or re-password the website's login role and give it exactly its table list on conn's current schema.

    Returns "created", "password set" or "kept". Raises ConfigError, with nothing changed,
    when the role does not exist and password is None, or when a listed table is missing
    from the schema (the list and schema.sql have drifted apart).
    """
    password = checked_password(password, WEB_PASSWORD_ENV)
    with conn.transaction():
        conn.execute("select pg_advisory_xact_lock(%s)", (SCHEMA_LOCK,))
        names = _names(conn, role)
        missing = [table for table in _WEB_TABLES if conn.execute("select to_regclass(%s)", (f"{names['_schema']}.{table}",)).fetchone()[0] is None]
        if missing:
            raise ConfigError(f"{role}'s table list names {', '.join(missing)}, which the schema does not have")
        outcome = _login_role(conn, role, password, WEB_PASSWORD_ENV)
        _run(conn, _RESET, names)
        grants = [(WEB_INSERT_ONLY, "insert"), (WEB_READ_ONLY, "select"), (WEB_READ_AND_INSERT, "select, insert"), (WEB_WRITES, "select, insert, update, delete")]
        for tables, rights in grants:
            for table in tables:
                conn.execute(sql.SQL("grant {} on table {}.{} to {}").format(sql.SQL(rights), names["schema"], sql.Identifier(table), names["role"]))
        for (sequence,) in conn.execute(_OWNED_SEQUENCES, (names["_schema"], list(WEB_INSERT_ONLY + WEB_READ_AND_INSERT + WEB_WRITES))).fetchall():
            conn.execute(sql.SQL("grant usage on sequence {}.{} to {}").format(names["schema"], sql.Identifier(sequence), names["role"]))
    return outcome


def drop_legacy_role(conn: psycopg.Connection, role: str = LEGACY_ROLE) -> str:
    """Drop the old shared role once no one is connected as it: "dropped", "absent" or "in use (N open connections)".

    Its grants on conn's current schema and database, and its default privileges there, are
    revoked first, so the drop needs no superuser.
    """
    with conn.transaction():
        conn.execute("select pg_advisory_xact_lock(%s)", (SCHEMA_LOCK,))
        if not _role_exists(conn, role):
            return "absent"
        connected = conn.execute("select count(*) from pg_stat_activity where usename = %s", (role,)).fetchone()[0]
        if connected:
            return f"in use ({connected} open connections)"
        _run(conn, _DROP, _names(conn, role))
    return "dropped"


def migrate(
    config: Config,
    engine_password: str | None = None,
    web_password: str | None = None,
    *,
    engine_role: str = ENGINE_ROLE,
    web_role: str = WEB_ROLE,
    legacy_role: str = LEGACY_ROLE,
    drop_legacy: bool = False,
) -> Migrated:
    """Apply schema.sql to the database config points at, then give each service's role its rights.

    Refuses with ConfigError, before anything changes, for a password that is too short,
    or when a role does not exist, its password is not given and this is not the local
    development database. On the local development database the missing roles are skipped.
    With drop_legacy, mend_app is dropped afterwards unless a connection as it is open.
    """
    wanted = {engine_role: checked_password(engine_password, ENGINE_PASSWORD_ENV), web_role: checked_password(web_password, WEB_PASSWORD_ENV)}
    settings = {engine_role: ENGINE_PASSWORD_ENV, web_role: WEB_PASSWORD_ENV}
    with open_connection(config) as conn:
        absent = [role for role, password in wanted.items() if password is None and not _role_exists(conn, role)]
        if absent and not is_local_development(config):
            raise ConfigError(f"{settings[absent[0]]} must be set to create the {absent[0]} role")
        apply_schema(conn)
        if absent:
            return Migrated(schema_sha256(), {role: "skipped" for role in wanted}, "absent")
        roles = {engine_role: grant_engine_role(conn, wanted[engine_role], engine_role), web_role: grant_web_role(conn, wanted[web_role], web_role)}
        if drop_legacy:
            legacy = drop_legacy_role(conn, legacy_role)
        else:
            legacy = "left" if _role_exists(conn, legacy_role) else "absent"
    return Migrated(schema_sha256(), roles, legacy)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m mend_engine.db.migrate", description="Apply schema.sql and the services' roles to the configured database.")
    parser.add_argument("--drop-legacy-role", action="store_true", help=f"drop the {LEGACY_ROLE} role, unless a connection as it is open")
    args = parser.parse_args(argv)
    try:
        config = load_config(str(ENV_PATH) if ENV_PATH.is_file() else None)
        result = migrate(
            config,
            os.environ.get(ENGINE_PASSWORD_ENV) or None,
            os.environ.get(WEB_PASSWORD_ENV) or None,
            drop_legacy=args.drop_legacy_role,
        )
    except ConfigError as exc:
        print(f"migrate: {exc}", file=sys.stderr)
        return 2
    except psycopg.Error as exc:
        print(f"migrate: the schema was not applied ({type(exc).__name__})", file=sys.stderr)
        return 1
    print(f"schema sha256 {result.sha256}")
    print("schema applied")
    for role, outcome in result.roles.items():
        print(f"db role {role}: {outcome}")
    print(f"db role {LEGACY_ROLE}: {result.legacy}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
