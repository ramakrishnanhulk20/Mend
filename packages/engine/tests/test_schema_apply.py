# Not covered here: applying the schema while other connections hold long transactions
# on its tables (the apply then waits for them, by design), and the web app's own
# appliers (they send the same file, so they take the same first lock).
import threading
import uuid
from collections.abc import Iterator

import pgserver
import psycopg
import pytest
from psycopg import sql

from mend_engine.db.connect import PGDATA, SCHEMA_PATH
from mend_engine.db.migrate import apply_schema

APPLIERS = 6


@pytest.fixture(scope="module")
def server_url() -> Iterator[str]:
    server = pgserver.get_server(PGDATA)
    yield server.get_uri()


@pytest.fixture
def schema(server_url: str) -> Iterator[str]:
    name = "schema_apply_" + uuid.uuid4().hex[:12]
    with psycopg.connect(server_url, autocommit=True) as admin:
        admin.execute(sql.SQL("create schema {}").format(sql.Identifier(name)))
        try:
            yield name
        finally:
            admin.execute(sql.SQL("drop schema {} cascade").format(sql.Identifier(name)))


def apply_at_once(server_url: str, schema: str) -> list[str]:
    """Six connections apply schema.sql through apply_schema, released together; returns each outcome."""
    gate = threading.Barrier(APPLIERS)
    outcomes: list[str] = []
    lock = threading.Lock()

    def apply() -> None:
        with psycopg.connect(server_url, autocommit=True, options=f"-c search_path={schema}") as conn:
            gate.wait()
            try:
                apply_schema(conn)
                outcome = "ok"
            except psycopg.Error as exc:
                outcome = type(exc).__name__
            with lock:
                outcomes.append(outcome)

    workers = [threading.Thread(target=apply) for _ in range(APPLIERS)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=120)
    return outcomes


def test_the_schema_lock_is_the_first_statement() -> None:
    statements = [line for line in SCHEMA_PATH.read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("--")]
    assert statements[0] == "select pg_advisory_xact_lock(7731300001);"


def test_six_applies_to_an_empty_schema_at_once_all_succeed(server_url: str, schema: str) -> None:
    # Before the lock came first, five of six failed here creating the same tables.
    assert apply_at_once(server_url, schema) == ["ok"] * APPLIERS


def test_six_applies_to_an_applied_schema_at_once_all_succeed(server_url: str, schema: str) -> None:
    # Before the lock came first, five of six deadlocked here on index and trigger locks.
    with psycopg.connect(server_url, autocommit=True, options=f"-c search_path={schema}") as conn:
        apply_schema(conn)
    for _ in range(3):
        assert apply_at_once(server_url, schema) == ["ok"] * APPLIERS
