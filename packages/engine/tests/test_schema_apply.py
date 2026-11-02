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


def test_applying_again_records_the_stand_in_flag_on_older_rows_from_their_member_and_leaves_memberless_rows_unrecorded(
    server_url: str, schema: str
) -> None:
    with psycopg.connect(server_url, autocommit=True, options=f"-c search_path={schema}") as conn:
        apply_schema(conn)
        members = {
            source: conn.execute(
                "insert into members (paypal_email, email_verified, consent_version, consent_text_sha256, client_id, source) "
                "values (%s, true, '2026-10-29.1', %s, 'cid', %s) returning member_id",
                (f"{source}@shop.example", "0" * 64, source),
            ).fetchone()[0]
            for source in ("seed", "paypal_login")
        }
        campaign_id = conn.execute(
            "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
            "values ('Shop', 'goal', '2026-10-16', 1000, 100, 0.5, 'draft') returning campaign_id"
        ).fetchone()[0]
        # Rows as drafted before the flag existed; R3's member had already left.
        for ref, member_id in (("R1", members["seed"]), ("R2", members["paypal_login"]), ("R3", None)):
            conn.execute(
                "insert into campaign_members (campaign_id, ref, member_id, role, rank, score) values (%s, %s, %s, 'holdout', %s, 0.1)",
                (campaign_id, ref, member_id, int(ref[1:])),
            )
        # Sent, so the frozen-rows guard is what the backfill has to get through.
        for status in ("approved", "submitting", "submitted"):
            conn.execute("update campaigns set status = %s where campaign_id = %s", (status, campaign_id))

        flags = "select ref, stand_in from campaign_members order by ref"
        assert conn.execute(flags).fetchall() == [("R1", None), ("R2", None), ("R3", None)]
        apply_schema(conn)
        assert conn.execute(flags).fetchall() == [("R1", True), ("R2", False), ("R3", None)]
        apply_schema(conn)
        assert conn.execute(flags).fetchall() == [("R1", True), ("R2", False), ("R3", None)]


def test_six_applies_to_an_applied_schema_at_once_all_succeed(server_url: str, schema: str) -> None:
    # Before the lock came first, five of six deadlocked here on index and trigger locks.
    with psycopg.connect(server_url, autocommit=True, options=f"-c search_path={schema}") as conn:
        apply_schema(conn)
    for _ in range(3):
        assert apply_at_once(server_url, schema) == ["ok"] * APPLIERS
