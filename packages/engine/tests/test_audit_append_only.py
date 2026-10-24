# Not covered here: the table owner or a superuser switching the trigger off
# (ALTER TABLE ... DISABLE TRIGGER, session_replication_role), which only a
# separate migration role can prevent (C22, not built yet); and what each module
# writes to the log (their own tests).
import uuid
from collections.abc import Iterator

import pgserver
import psycopg
import pytest
from psycopg import sql
from psycopg.types.json import Jsonb

from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema

REFUSED = psycopg.errors.RaiseException


@pytest.fixture(scope="module")
def server_url() -> Iterator[str]:
    server = pgserver.get_server(PGDATA)
    yield server.get_uri()


@pytest.fixture
def schema(server_url: str) -> Iterator[tuple[psycopg.Connection, str]]:
    name = "m4b_test_" + uuid.uuid4().hex[:12]
    with psycopg.connect(server_url, autocommit=True) as connection:
        connection.execute(sql.SQL("create schema {}").format(sql.Identifier(name)))
        try:
            connection.execute(sql.SQL("set search_path to {}").format(sql.Identifier(name)))
            apply_schema(connection)
            yield connection, name
        finally:
            connection.execute("reset role")
            connection.execute(sql.SQL("drop schema {} cascade").format(sql.Identifier(name)))


def write(conn: psycopg.Connection, n: int) -> None:
    conn.execute("insert into audit_log (actor, action, detail) values ('engine', 'test', %s)", (Jsonb({"n": n}),))


def everything(conn: psycopg.Connection) -> list[tuple]:
    return conn.execute("select * from audit_log order by id").fetchall()


def test_rows_can_be_added_but_never_changed_or_removed(schema: tuple) -> None:
    conn, _name = schema
    write(conn, 1)
    write(conn, 2)
    before = everything(conn)
    for statement in (
        "update audit_log set detail = '{}'",
        "update audit_log set actor = actor",
        "delete from audit_log where id = (select min(id) from audit_log)",
        "truncate audit_log",
    ):
        with pytest.raises(REFUSED, match="audit_log: .* refused"):
            conn.execute(statement)
    assert everything(conn) == before and len(before) == 2


def test_the_trigger_fires_for_a_role_granted_every_privilege_on_the_table(schema: tuple) -> None:
    conn, name = schema
    write(conn, 1)
    role = sql.Identifier("mend_test_role_" + uuid.uuid4().hex[:8])
    conn.execute(sql.SQL("create role {} nologin").format(role))
    try:
        conn.execute(sql.SQL("grant usage on schema {} to {}").format(sql.Identifier(name), role))
        conn.execute(sql.SQL("grant select, insert, update, delete, truncate on audit_log to {}").format(role))
        conn.execute(sql.SQL("grant usage on sequence audit_log_id_seq to {}").format(role))
        conn.execute(sql.SQL("set role {}").format(role))
        write(conn, 2)
        for statement in ("update audit_log set detail = '{}'", "delete from audit_log", "truncate audit_log"):
            with pytest.raises(REFUSED):
                conn.execute(statement)
        conn.execute("reset role")
        assert [r[4] for r in everything(conn)] == [{"n": 1}, {"n": 2}]
    finally:
        conn.execute("reset role")
        conn.execute(sql.SQL("drop owned by {}").format(role))
        conn.execute(sql.SQL("drop role {}").format(role))


def test_applying_the_schema_again_leaves_one_of_each_guard(schema: tuple) -> None:
    conn, _name = schema
    apply_schema(conn)
    apply_schema(conn)
    triggers = conn.execute(
        "select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid "
        "where not t.tgisinternal and c.relnamespace = current_schema()::regnamespace order by 1, 2"
    ).fetchall()
    assert triggers == [
        ("approved_snapshots", "approved_snapshots_append_only"),
        ("approved_snapshots", "approved_snapshots_no_truncate"),
        ("audit_log", "audit_log_append_only"),
        ("audit_log", "audit_log_no_truncate"),
        ("campaign_members", "campaign_members_frozen"),
        ("campaign_members", "campaign_members_no_truncate"),
        ("campaign_owners", "campaign_owners_append_only"),
        ("campaign_status_moves", "campaign_status_moves_append_only"),
        ("campaign_status_moves", "campaign_status_moves_no_truncate"),
        ("campaigns", "campaigns_status_guard"),
        ("campaigns", "campaigns_status_inserted"),
        ("campaigns", "campaigns_status_moved"),
    ]
    write(conn, 1)
    with pytest.raises(REFUSED):
        conn.execute("delete from audit_log")
