# Not covered here: the table owner switching the guard off (ALTER TABLE ... DISABLE
# TRIGGER), which only a separate migration role can prevent (C22, a deploy-gate
# item); and which module makes each move (their own tests).
import itertools
import uuid
from collections.abc import Iterator

import pgserver
import psycopg
import pytest
from psycopg import sql

from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema

STATUSES = (
    "draft", "awaiting_approval", "approved", "submitting", "submitted",
    "submission_unknown", "exists_unresolved", "completed", "voided",
)
ALLOWED = {
    ("draft", "awaiting_approval"), ("draft", "approved"), ("draft", "voided"),
    ("awaiting_approval", "approved"), ("awaiting_approval", "voided"),
    ("approved", "submitting"), ("approved", "voided"),
    ("submitting", "submitted"), ("submitting", "submission_unknown"),
    ("submitting", "exists_unresolved"), ("submitting", "voided"),
    ("submission_unknown", "submitting"), ("submission_unknown", "submitted"),
    ("submission_unknown", "exists_unresolved"),
    ("exists_unresolved", "submitted"),
    ("submitted", "completed"),
}
REFUSED = psycopg.errors.RaiseException


@pytest.fixture(scope="module")
def server_url() -> Iterator[str]:
    server = pgserver.get_server(PGDATA)
    yield server.get_uri()


@pytest.fixture
def conn(server_url: str) -> Iterator[psycopg.Connection]:
    name = sql.Identifier("m5_guard_" + uuid.uuid4().hex[:12])
    with psycopg.connect(server_url, autocommit=True) as connection:
        connection.execute(sql.SQL("create schema {}").format(name))
        try:
            connection.execute(sql.SQL("set search_path to {}").format(name))
            apply_schema(connection)
            yield connection
        finally:
            connection.execute(sql.SQL("drop schema {} cascade").format(name))


def campaign(conn: psycopg.Connection, status: str) -> uuid.UUID:
    return conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 1000, 100, 0.5, %s) returning campaign_id",
        (status,),
    ).fetchone()[0]


def moves(conn: psycopg.Connection, campaign_id: uuid.UUID) -> list[tuple]:
    return conn.execute(
        "select from_status, to_status from campaign_status_moves where campaign_id = %s order by moved_at, ctid",
        (campaign_id,),
    ).fetchall()


def status_of(conn: psycopg.Connection, campaign_id: uuid.UUID) -> str:
    return conn.execute("select status from campaigns where campaign_id = %s", (campaign_id,)).fetchone()[0]


def test_every_listed_move_is_allowed_and_recorded(conn: psycopg.Connection) -> None:
    for old, new in sorted(ALLOWED):
        campaign_id = campaign(conn, old)
        conn.execute("update campaigns set status = %s where campaign_id = %s", (new, campaign_id))
        assert status_of(conn, campaign_id) == new
        assert moves(conn, campaign_id) == [(None, old), (old, new)]


def test_every_other_move_is_refused_and_leaves_no_trace(conn: psycopg.Connection) -> None:
    refused = [(old, new) for old, new in itertools.permutations(STATUSES, 2) if (old, new) not in ALLOWED]
    assert len(refused) == 72 - len(ALLOWED)
    for old, new in refused:
        campaign_id = campaign(conn, old)
        with pytest.raises(REFUSED, match=f"status {old} to {new} refused"):
            conn.execute("update campaigns set status = %s where campaign_id = %s", (new, campaign_id))
        assert status_of(conn, campaign_id) == old
        assert moves(conn, campaign_id) == [(None, old)]


def test_a_walk_through_the_product_path_records_each_move_in_order(conn: psycopg.Connection) -> None:
    campaign_id = campaign(conn, "draft")
    path = ["approved", "submitting", "submission_unknown", "submitting", "exists_unresolved", "submitted", "completed"]
    for new in path:
        conn.execute("update campaigns set status = %s where campaign_id = %s", (new, campaign_id))
    assert [to for _from, to in moves(conn, campaign_id)] == ["draft", *path]
    with pytest.raises(REFUSED):
        conn.execute("update campaigns set status = 'submitted' where campaign_id = %s", (campaign_id,))


def test_setting_the_same_status_or_another_column_moves_nothing(conn: psycopg.Connection) -> None:
    campaign_id = campaign(conn, "voided")
    conn.execute("update campaigns set status = 'voided', void_reason = 'again' where campaign_id = %s", (campaign_id,))
    conn.execute("update campaigns set goal_text = 'other' where campaign_id = %s", (campaign_id,))
    assert moves(conn, campaign_id) == [(None, "voided")]


def test_one_statement_moving_many_rows_is_refused_whole_if_one_move_is_not_allowed(conn: psycopg.Connection) -> None:
    ok, bad = campaign(conn, "draft"), campaign(conn, "voided")
    with pytest.raises(REFUSED):
        conn.execute("update campaigns set status = 'approved' where campaign_id = any(%s)", ([ok, bad],))
    assert (status_of(conn, ok), status_of(conn, bad)) == ("draft", "voided")
    assert moves(conn, ok) == [(None, "draft")]


def test_the_record_of_moves_can_be_added_to_but_never_changed(conn: psycopg.Connection) -> None:
    campaign_id = campaign(conn, "draft")
    conn.execute("update campaigns set status = 'approved' where campaign_id = %s", (campaign_id,))
    before = moves(conn, campaign_id)
    for statement in (
        "update campaign_status_moves set to_status = 'submitted'",
        "update campaign_status_moves set moved_at = moved_at - interval '40 days'",
        "delete from campaign_status_moves",
        "truncate campaign_status_moves",
    ):
        with pytest.raises(REFUSED, match="campaign_status_moves: .* refused"):
            conn.execute(statement)
    assert moves(conn, campaign_id) == before


FROZEN = {"approved": ("approved",), "sent": ("approved", "submitting", "submitted")}


def member(conn: psycopg.Connection, email: str) -> uuid.UUID:
    return conn.execute(
        "insert into members (paypal_email, email_verified, consent_version, consent_text_sha256, client_id, source) "
        "values (%s, true, '2026-10-29.1', %s, 'cid', 'seed') returning member_id",
        (email, "0" * 64),
    ).fetchone()[0]


def one_row(conn: psycopg.Connection, moves: tuple[str, ...], stand_in: bool | None = None) -> uuid.UUID:
    """A campaign holding one member's row R1, written as a draft, then moved along the guard's own arrows."""
    campaign_id = campaign(conn, "draft")
    conn.execute(
        "insert into campaign_members (campaign_id, ref, member_id, role, rank, score, amount_minor, note, stand_in) "
        "values (%s, 'R1', %s, 'reward', 1, 0.1, 100, 'Thanks', %s)",
        (campaign_id, member(conn, f"{uuid.uuid4().hex[:12]}@shop.example"), stand_in),
    )
    for status in moves:
        conn.execute("update campaigns set status = %s where campaign_id = %s", (status, campaign_id))
    return campaign_id


def flag(conn: psycopg.Connection, campaign_id: uuid.UUID) -> tuple:
    return conn.execute("select member_id is not null, stand_in from campaign_members where campaign_id = %s", (campaign_id,)).fetchone()


@pytest.mark.parametrize("frozen", sorted(FROZEN))
def test_a_frozen_row_may_record_its_stand_in_flag_once_and_nothing_else_with_it(conn: psycopg.Connection, frozen: str) -> None:
    campaign_id = one_row(conn, FROZEN[frozen])
    other = member(conn, "other@shop.example")
    for change, args in (
        ("stand_in = true, amount_minor = 99", ()),
        ("stand_in = true, note = 'Other'", ()),
        ("stand_in = true, rank = 2", ()),
        ("stand_in = true, member_id = %s", (other,)),
    ):
        with pytest.raises(REFUSED, match="rows are frozen"):
            conn.execute(f"update campaign_members set {change} where campaign_id = %s", (*args, campaign_id))
    assert flag(conn, campaign_id) == (True, None)

    conn.execute("update campaign_members set stand_in = true where campaign_id = %s", (campaign_id,))
    assert flag(conn, campaign_id) == (True, True)

    for change in ("stand_in = false", "stand_in = null"):
        with pytest.raises(REFUSED, match="rows are frozen"):
            conn.execute(f"update campaign_members set {change} where campaign_id = %s", (campaign_id,))
    assert flag(conn, campaign_id) == (True, True)


def test_a_sent_row_losing_its_member_may_record_a_missing_flag_in_the_same_change_but_never_flip_one(conn: psycopg.Connection) -> None:
    unrecorded = one_row(conn, FROZEN["sent"])
    conn.execute("update campaign_members set member_id = null, stand_in = true where campaign_id = %s", (unrecorded,))
    assert flag(conn, unrecorded) == (False, True)

    recorded = one_row(conn, FROZEN["sent"], stand_in=True)
    with pytest.raises(REFUSED, match="sent and its rows are frozen"):
        conn.execute("update campaign_members set member_id = null, stand_in = false where campaign_id = %s", (recorded,))
    conn.execute("update campaign_members set member_id = null where campaign_id = %s", (recorded,))
    assert flag(conn, recorded) == (False, True)

    approved = one_row(conn, FROZEN["approved"])
    with pytest.raises(REFUSED, match="approved and its rows are frozen"):
        conn.execute("update campaign_members set member_id = null, stand_in = true where campaign_id = %s", (approved,))
    assert flag(conn, approved) == (True, None)


def test_applying_the_schema_again_keeps_one_guard_and_one_record_per_move(conn: psycopg.Connection) -> None:
    apply_schema(conn)
    apply_schema(conn)
    triggers = conn.execute(
        "select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid "
        "where not t.tgisinternal and c.relnamespace = current_schema()::regnamespace "
        "and c.relname in ('campaigns', 'campaign_status_moves') order by 1, 2"
    ).fetchall()
    assert triggers == [
        ("campaign_status_moves", "campaign_status_moves_append_only"),
        ("campaign_status_moves", "campaign_status_moves_no_truncate"),
        ("campaigns", "campaigns_status_guard"),
        ("campaigns", "campaigns_status_inserted"),
        ("campaigns", "campaigns_status_moved"),
    ]
    campaign_id = campaign(conn, "draft")
    conn.execute("update campaigns set status = 'voided' where campaign_id = %s", (campaign_id,))
    assert moves(conn, campaign_id) == [(None, "draft"), ("draft", "voided")]
    with pytest.raises(REFUSED):
        conn.execute("update campaigns set status = 'approved' where campaign_id = %s", (campaign_id,))
