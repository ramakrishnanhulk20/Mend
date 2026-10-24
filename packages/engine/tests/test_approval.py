# Not covered here: who may approve (the web app's roles, C18) and the same-origin
# and CSRF checks on the approve request; a member leaving at the same instant as
# approval on another connection; the table owner switching the triggers off,
# which only the second check in frozen_snapshot catches (shown below).
import uuid
from collections.abc import Callable, Iterator
from dataclasses import replace
from datetime import timedelta

import pgserver
import psycopg
import pytest
from psycopg import sql

from mend_engine.campaigns.approval import (
    CHANGED_REASON,
    ApprovalRefused,
    EditRefused,
    approve,
    current_snapshot,
    frozen_snapshot,
    remove_recipient,
    review_hash,
    set_amount,
    set_note,
)
from mend_engine.config import SANDBOX_API_HOST, Config
from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema
from mend_engine.members.consent import DEMO_SHOP_NAME
from mend_engine.members.membership import join_member, leave_member
from mend_engine.paypal.payouts import (
    BatchSnapshot,
    PayoutItemSpec,
    SnapshotRefused,
    canonical_json,
    sender_batch_id_for,
    snapshot_hash,
)

CONFIG = Config(
    paypal_client_id="cid",
    paypal_client_secret="csecret",
    paypal_api_host=SANDBOX_API_HOST,
    database_url=None,
    dev=True,
    test_receiver=None,
    item_cap_minor=1000,
    campaign_cap_minor=10000,
    daily_cap_minor=20000,
)
NOTE = "Thank you for being a regular at Wolf and Wren Gifts. Here is a small thank-you from us."


@pytest.fixture(scope="module")
def server_url() -> Iterator[str]:
    server = pgserver.get_server(PGDATA)
    yield server.get_uri()


@pytest.fixture
def conn(server_url: str) -> Iterator[psycopg.Connection]:
    schema = sql.Identifier("m4b_test_" + uuid.uuid4().hex[:12])
    with psycopg.connect(server_url, autocommit=True) as connection:
        connection.execute(sql.SQL("create schema {}").format(schema))
        try:
            connection.execute(sql.SQL("set search_path to {}").format(schema))
            apply_schema(connection)
            yield connection
        finally:
            connection.execute(sql.SQL("drop schema {} cascade").format(schema))


def members(conn: psycopg.Connection, count: int = 3, paid: int = 1000) -> list[uuid.UUID]:
    ids = []
    for n in range(1, count + 1):
        conn.execute("insert into shop_customers values (%s, 'Maya R.', %s, 'UK')", (f"C{n}", f"c{n}@shop.example"))
        conn.execute("insert into shop_orders values (%s, %s, '2026-06-01 12:00+00', %s, 'USD')", (f"o{n}", f"C{n}", paid))
        ids.append(
            join_member(
                conn, paypal_email=f"C{n}@Shop.Example", paypal_payer_id=None, email_verified=True,
                shop_name=DEMO_SHOP_NAME, client_id="cid",
            )
        )
    return ids


def draft(conn: psycopg.Connection, ids: list[uuid.UUID], amounts: list[int], budget: int = 1000) -> uuid.UUID:
    """A draft paying amounts to the first members in ids and holding the last one back."""
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values (%s, 'goal', '2026-10-16', %s, 300, 0.5, 'draft') returning campaign_id",
        (DEMO_SHOP_NAME, budget),
    ).fetchone()[0]
    for rank, member_id in enumerate(ids, start=1):
        paid = rank <= len(amounts)
        conn.execute(
            "insert into campaign_members values (%s, %s, %s, %s, %s, 0.1, %s, %s)",
            (campaign_id, f"R{rank}", member_id, "reward" if paid else "holdout", rank,
             amounts[rank - 1] if paid else None, NOTE if paid else None),
        )
    return campaign_id


def rows(conn: psycopg.Connection, campaign_id: uuid.UUID) -> list[tuple]:
    return conn.execute("select * from campaign_members where campaign_id = %s order by rank", (campaign_id,)).fetchall()


def status(conn: psycopg.Connection, campaign_id: uuid.UUID) -> tuple:
    return conn.execute("select status, void_reason from campaigns where campaign_id = %s", (campaign_id,)).fetchone()


def audit(conn: psycopg.Connection, action: str) -> list[dict]:
    return [r[0] for r in conn.execute("select detail from audit_log where action = %s order by id", (action,))]


def test_approval_freezes_exactly_the_snapshot_the_owner_was_shown(conn: psycopg.Connection) -> None:
    ids = members(conn)
    campaign_id = draft(conn, ids, [250, 300])
    shown = current_snapshot(conn, campaign_id)

    approval = approve(conn, campaign_id, approver="owner", presented_hash=review_hash(conn, campaign_id), config=CONFIG)

    assert approval.snapshot_hash == snapshot_hash(shown) and status(conn, campaign_id) == ("approved", None)
    assert [(i.receiver_email, i.amount_minor, i.sender_item_id) for i in shown.items] == [
        ("c1@shop.example", 250, "R1"),
        ("c2@shop.example", 300, "R2"),
    ]
    assert shown.email_subject == "A thank-you from Wolf and Wren Gifts" and shown.currency == "USD"
    stored = conn.execute("select snapshot_hash, canonical_json, approved_at, approved_by from approved_snapshots").fetchall()
    assert stored == [(approval.snapshot_hash, canonical_json(shown), approval.approved_at, "owner")]
    assert frozen_snapshot(conn, campaign_id) == shown
    assert audit(conn, "campaign_approved") == [
        {"campaign_id": str(campaign_id), "snapshot_hash": approval.snapshot_hash, "recipients": 2, "total_minor": 550}
    ]


def _leave_first(conn: psycopg.Connection, ids: list, _campaign: uuid.UUID) -> None:
    leave_member(conn, ids[0])


def _delete_first(conn: psycopg.Connection, ids: list, _campaign: uuid.UUID) -> None:
    conn.execute("delete from members where member_id = %s", (ids[0],))


def _spend_today(conn: psycopg.Connection, _ids: list, _campaign: uuid.UUID) -> None:
    other = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 10000, 1000, 0.5, 'submitted') returning campaign_id"
    ).fetchone()[0]
    items = tuple(PayoutItemSpec(f"x{n}@shop.example", 1000, "Thanks", f"R{n}") for n in range(1, 21))
    snap = BatchSnapshot(str(other), "USD", "A thank-you", items)
    conn.execute("insert into approved_snapshots values (%s, %s, %s, now(), 'owner')", (other, snapshot_hash(snap), canonical_json(snap)))
    conn.execute(
        "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, status, created_at) "
        "values (%s, %s, %s, 'created', now() - interval '23 hours')",
        (sender_batch_id_for(snap), str(other), snapshot_hash(snap)),
    )


REFUSALS: list[tuple[str, Callable, Config, str]] = [
    ("a recipient who left", _leave_first, CONFIG, "voided"),
    ("a recipient whose member row is gone", _delete_first, CONFIG, "recipient_not_member"),
    ("an unverified recipient", lambda c, i, k: c.execute("update members set email_verified = false where member_id = %s", (i[1],)), CONFIG, "recipient_unverified"),
    ("an amount over the item cap", lambda c, i, k: None, replace(CONFIG, item_cap_minor=299), "amount_over_item_cap"),
    ("an amount over the amount per person", lambda c, i, k: c.execute("update campaigns set per_recipient_minor = 299"), CONFIG, "amount_over_per_recipient"),
    ("a refund since the draft", lambda c, i, k: c.execute("insert into shop_refunds values ('C900000', 'C2', '2026-07-01 12:00+00', 701)"), CONFIG, "amount_over_paid"),
    ("a total over the budget", lambda c, i, k: c.execute("update campaigns set budget_minor = 549"), CONFIG, "over_budget"),
    ("a budget over the campaign cap", lambda c, i, k: None, replace(CONFIG, campaign_cap_minor=999), "budget_over_cap"),
    ("a note the payout rules refuse", lambda c, i, k: c.execute("update campaign_members set note = 'Write to us@shop' where ref = 'R1'"), CONFIG, "snapshot_refused"),
    ("a budget over the daily cap", _spend_today, CONFIG, "over_daily_cap"),
]


@pytest.mark.parametrize(("why", "change", "config", "reason"), REFUSALS, ids=[r[0] for r in REFUSALS])
def test_each_rule_is_rechecked_against_current_data_at_approval(
    conn: psycopg.Connection, why: str, change: Callable, config: Config, reason: str
) -> None:
    ids = members(conn)
    campaign_id = draft(conn, ids, [250, 300])
    change(conn, ids, campaign_id)
    try:
        shown = review_hash(conn, campaign_id)
    except ApprovalRefused:
        shown = "0" * 64
    with pytest.raises(ApprovalRefused) as refused:
        approve(conn, campaign_id, approver="owner", presented_hash=shown, config=config)
    assert refused.value.reason == reason, why
    assert status(conn, campaign_id)[0] in ("draft", "voided")
    assert conn.execute("select count(*) from approved_snapshots where campaign_id = %s", (campaign_id,)).fetchone()[0] == 0
    assert audit(conn, "approval_refused") == [{"campaign_id": str(campaign_id), "reason": reason}]


def test_a_hash_that_is_not_the_one_shown_is_refused_even_after_a_small_edit(conn: psycopg.Connection) -> None:
    ids = members(conn)
    campaign_id = draft(conn, ids, [250, 300])
    shown = review_hash(conn, campaign_id)
    set_note(conn, campaign_id, "R2", "Thanks for coming back to the shop.")
    for presented in (shown, "f" * 64):
        with pytest.raises(ApprovalRefused) as refused:
            approve(conn, campaign_id, approver="owner", presented_hash=presented, config=CONFIG)
        assert refused.value.reason == "hash_mismatch"
    approve(conn, campaign_id, approver="owner", presented_hash=review_hash(conn, campaign_id), config=CONFIG)
    with pytest.raises(ApprovalRefused) as refused:
        approve(conn, campaign_id, approver="owner", presented_hash=review_hash(conn, campaign_id), config=CONFIG)
    assert refused.value.reason == "not_open"
    with pytest.raises(ApprovalRefused) as refused:
        approve(conn, uuid.uuid4(), approver="owner", presented_hash=shown, config=CONFIG)
    assert refused.value.reason == "not_found"


@pytest.mark.parametrize(("approver", "presented"), [("owner@shop.example", "a" * 64), ("", "a" * 64), ("owner", "A" * 64), ("owner", "a" * 63)])
def test_an_approver_or_hash_of_the_wrong_shape_is_refused_before_anything_is_read(
    conn: psycopg.Connection, approver: str, presented: str
) -> None:
    with pytest.raises(ApprovalRefused) as refused:
        approve(conn, uuid.uuid4(), approver=approver, presented_hash=presented, config=CONFIG)
    assert refused.value.reason == "invalid_input"
    assert conn.execute("select count(*) from audit_log").fetchone()[0] == 0


EDITS: list[tuple[str, Callable]] = [
    ("set_amount", lambda c, k: set_amount(c, k, "R1", 100, CONFIG)),
    ("set_note", lambda c, k: set_note(c, k, "R1", "Thanks again.")),
    ("remove_recipient", lambda c, k: remove_recipient(c, k, "R1")),
]


@pytest.mark.parametrize(("action", "edit"), EDITS, ids=[e[0] for e in EDITS])
def test_any_edit_after_approval_voids_the_approval_and_changes_no_row(
    conn: psycopg.Connection, action: str, edit: Callable
) -> None:
    ids = members(conn)
    campaign_id = draft(conn, ids, [250, 300])
    approve(conn, campaign_id, approver="owner", presented_hash=review_hash(conn, campaign_id), config=CONFIG)
    before = rows(conn, campaign_id)

    result = edit(conn, campaign_id)

    assert (result.status, result.applied) == ("voided", False)
    assert status(conn, campaign_id) == ("voided", CHANGED_REASON) and rows(conn, campaign_id) == before
    assert audit(conn, "campaign_voided") == [{"campaign_id": str(campaign_id), "reason": CHANGED_REASON, "edit": action}]
    with pytest.raises(EditRefused) as refused:
        edit(conn, campaign_id)
    assert refused.value.reason == "not_editable"


def test_the_database_refuses_any_direct_change_to_an_approved_campaign(conn: psycopg.Connection) -> None:
    ids = members(conn)
    campaign_id = draft(conn, ids, [250, 300])
    approve(conn, campaign_id, approver="owner", presented_hash=review_hash(conn, campaign_id), config=CONFIG)
    before = rows(conn, campaign_id), conn.execute("select * from approved_snapshots").fetchall()
    attempts = [
        ("update campaign_members set amount_minor = 1000 where ref = 'R1'", "approved and its rows are frozen"),
        ("update campaign_members set member_id = null where ref = 'R1'", "approved and its rows are frozen"),
        ("delete from campaign_members where ref = 'R3'", "approved and its rows are frozen"),
        ("insert into campaign_members select campaign_id, 'R9', null, 'reward', 9, 0, 5, 'x' from campaigns", "approved"),
        ("delete from members where member_id = '%s'" % ids[0], "approved and its rows are frozen"),
        ("truncate campaign_members", "truncate refused"),
        ("update approved_snapshots set canonical_json = '{}'", "approved_snapshots: update refused"),
        ("delete from approved_snapshots", "approved_snapshots: delete refused"),
        ("truncate approved_snapshots cascade", "truncate refused"),
    ]
    for statement, message in attempts:
        with pytest.raises(psycopg.errors.RaiseException, match=message):
            conn.execute(statement)
    assert (rows(conn, campaign_id), conn.execute("select * from approved_snapshots").fetchall()) == before


def test_after_sending_only_a_leaving_members_link_may_be_emptied(conn: psycopg.Connection) -> None:
    ids = members(conn)
    campaign_id = draft(conn, ids, [250, 300])
    approve(conn, campaign_id, approver="owner", presented_hash=review_hash(conn, campaign_id), config=CONFIG)
    # The status guard allows only the product's own moves, so the campaign is sent the way submit() sends it.
    for step in ("submitting", "submitted"):
        conn.execute("update campaigns set status = %s where campaign_id = %s", (step, campaign_id))
    before = rows(conn, campaign_id)

    assert leave_member(conn, ids[0]).voided_campaigns == ()

    after = rows(conn, campaign_id)
    assert after[0] == (*before[0][:2], None, *before[0][3:]) and after[1:] == before[1:]
    with pytest.raises(psycopg.errors.RaiseException, match="has been sent"):
        conn.execute("update campaign_members set amount_minor = 1 where ref = 'R2'")


def test_edits_to_a_draft_hold_to_every_cap(conn: psycopg.Connection) -> None:
    ids = members(conn, count=4, paid=280)
    campaign_id = draft(conn, ids, [250, 250, 250], budget=800)
    assert set_amount(conn, campaign_id, "R1", 280, CONFIG) == set_amount(conn, campaign_id, "R1", 280, CONFIG)
    refusals = [
        (lambda: set_amount(conn, campaign_id, "R1", 281, CONFIG), "amount_over_paid"),
        (lambda: set_amount(conn, campaign_id, "R1", 280, replace(CONFIG, item_cap_minor=279)), "amount_over_item_cap"),
        (lambda: set_amount(conn, campaign_id, "R2", 280, CONFIG), "over_budget"),
        (lambda: set_amount(conn, campaign_id, "R1", 0, CONFIG), "invalid_input"),
        (lambda: set_amount(conn, campaign_id, "R1", True, CONFIG), "invalid_input"),
        (lambda: set_amount(conn, campaign_id, "R4", 100, CONFIG), "holdout_ref"),
        (lambda: set_amount(conn, campaign_id, "R7", 100, CONFIG), "unknown_ref"),
        (lambda: set_note(conn, campaign_id, "R1", "See www.example now"), "note_rejected"),
        (lambda: remove_recipient(conn, campaign_id, "R4"), "holdout_ref"),
        (lambda: remove_recipient(conn, uuid.uuid4(), "R1"), "not_found"),
    ]
    for attempt, reason in refusals:
        with pytest.raises(EditRefused) as refused:
            attempt()
        assert refused.value.reason == reason
    conn.execute("update campaigns set per_recipient_minor = 200")
    with pytest.raises(EditRefused) as refused:
        set_amount(conn, campaign_id, "R2", 201, CONFIG)
    assert refused.value.reason == "amount_over_per_recipient"
    assert remove_recipient(conn, campaign_id, "R3").applied
    assert [(r[1], r[6]) for r in rows(conn, campaign_id)] == [("R1", 280), ("R2", 250), ("R4", None)]
    assert len(audit(conn, "campaign_edited")) == 3


def test_a_frozen_snapshot_altered_behind_the_triggers_back_is_refused(conn: psycopg.Connection) -> None:
    ids = members(conn)
    campaign_id = draft(conn, ids, [250, 300])
    approve(conn, campaign_id, approver="owner", presented_hash=review_hash(conn, campaign_id), config=CONFIG)
    assert frozen_snapshot(conn, uuid.uuid4()) is None
    # Only the table owner can do this; the hash check is what still stops it.
    conn.execute("alter table approved_snapshots disable trigger approved_snapshots_append_only")
    conn.execute("update approved_snapshots set canonical_json = replace(canonical_json, '250', '950')")
    conn.execute("alter table approved_snapshots enable trigger approved_snapshots_append_only")
    with pytest.raises(SnapshotRefused, match="does not match its hash"):
        frozen_snapshot(conn, campaign_id)


def test_the_approval_window_for_the_daily_cap_uses_the_last_24_hours(conn: psycopg.Connection) -> None:
    ids = members(conn)
    campaign_id = draft(conn, ids, [250, 300])
    _spend_today(conn, ids, campaign_id)
    conn.execute("update payout_batches set created_at = created_at - %s", (timedelta(hours=2),))
    approve(conn, campaign_id, approver="owner", presented_hash=review_hash(conn, campaign_id), config=CONFIG)
    assert status(conn, campaign_id) == ("approved", None)
