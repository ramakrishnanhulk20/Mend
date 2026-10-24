# Not covered here: Log in with PayPal itself (the web app's join callback), two
# joins or a join and a leave racing on separate connections, and the app's
# database role (not created yet).
import uuid
from collections.abc import Iterator

import pgserver
import psycopg
import pytest
from psycopg import sql

from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema
from mend_engine.members.consent import CONSENT_VERSION, DEMO_SHOP_NAME, consent_hash, consent_text_for
from mend_engine.members.membership import (
    LEFT_REASON,
    MembershipRefused,
    join_member,
    leave_member,
    match_member_to_customer,
)

CLIENT_ID = "AbC-123_test"
ROUTE_FROM_DRAFT = {
    "draft": (),
    "awaiting_approval": ("awaiting_approval",),
    "approved": ("approved",),
    "submitted": ("approved", "submitting", "submitted"),
}


@pytest.fixture(scope="module")
def server_url() -> Iterator[str]:
    server = pgserver.get_server(PGDATA)
    yield server.get_uri()


@pytest.fixture
def conn(server_url: str) -> Iterator[psycopg.Connection]:
    schema = sql.Identifier("m4a_test_" + uuid.uuid4().hex[:12])
    with psycopg.connect(server_url, autocommit=True) as connection:
        connection.execute(sql.SQL("create schema {}").format(schema))
        try:
            connection.execute(sql.SQL("set search_path to {}").format(schema))
            apply_schema(connection)
            yield connection
        finally:
            connection.execute(sql.SQL("drop schema {} cascade").format(schema))


def join(conn: psycopg.Connection, email: str, payer_id: str | None = None, **changes: object) -> uuid.UUID:
    args = dict(paypal_email=email, paypal_payer_id=payer_id, email_verified=True, shop_name=DEMO_SHOP_NAME, client_id=CLIENT_ID)
    args.update(changes)
    return join_member(conn, **args)  # type: ignore[arg-type]


def campaign(conn: psycopg.Connection, status: str, *member_ids: uuid.UUID) -> uuid.UUID:
    # Rows go in while it is a draft; from approval on the database refuses them.
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values (%s, 'goal', '2026-10-16', 1000, 100, 0.5, 'draft') returning campaign_id",
        (DEMO_SHOP_NAME,),
    ).fetchone()[0]
    for rank, member_id in enumerate(member_ids, start=1):
        conn.execute(
            "insert into campaign_members (campaign_id, ref, member_id, role, rank, score, amount_minor, note) "
            "values (%s, %s, %s, 'reward', %s, 0.1, 100, 'Thanks')",
            (campaign_id, f"R{rank}", member_id, rank),
        )
    # The status guard allows only the product's own moves, so each status is reached along them.
    for step in ROUTE_FROM_DRAFT[status]:
        conn.execute("update campaigns set status = %s where campaign_id = %s", (step, campaign_id))
    return campaign_id


def statuses(conn: psycopg.Connection) -> dict[uuid.UUID, tuple[str, str | None]]:
    return {row[0]: (row[1], row[2]) for row in conn.execute("select campaign_id, status, void_reason from campaigns")}


def test_joining_records_the_consent_and_twice_returns_the_same_member(conn: psycopg.Connection) -> None:
    first = join(conn, "  Maya.R@Shop.Example ")
    before = conn.execute("select xmin::text, m.* from members m").fetchall()
    again = join(conn, "maya.r@shop.example", email_verified=False, client_id="other-client")
    assert again == first
    assert conn.execute("select xmin::text, m.* from members m").fetchall() == before
    email, version, digest, client, verified = conn.execute(
        "select paypal_email, consent_version, consent_text_sha256, client_id, email_verified from members"
    ).fetchone()
    assert (email, version, client, verified) == ("maya.r@shop.example", CONSENT_VERSION, CLIENT_ID, True)
    assert digest == consent_hash(consent_text_for(DEMO_SHOP_NAME))
    assert consent_text_for(DEMO_SHOP_NAME).startswith("Wolf and Wren Gifts may look at your past orders")
    joined = conn.execute("select detail from audit_log where action = 'member_joined'").fetchall()
    assert joined == [({"member_id": str(first), "consent_version": CONSENT_VERSION},)]


def test_an_account_is_never_moved_to_another_email_or_the_reverse(conn: psycopg.Connection) -> None:
    join(conn, "a@shop.example", "PAYERAAAA")
    join(conn, "b@shop.example")
    with pytest.raises(MembershipRefused):
        join(conn, "new@shop.example", "PAYERAAAA")
    with pytest.raises(MembershipRefused):
        join(conn, "a@shop.example", "PAYERBBBB")
    assert join(conn, "a@shop.example", "PAYERAAAA") == join(conn, "a@shop.example")
    assert conn.execute("select count(*) from members").fetchone()[0] == 2


@pytest.mark.parametrize(
    "changes",
    [
        {"paypal_email": "not an email"},
        {"paypal_email": "x@y"},
        {"paypal_email": None},
        {"paypal_email": "a" * 120 + "@shop.example"},
        {"paypal_payer_id": "PAYER 1"},
        {"paypal_payer_id": "P" * 65},
        {"email_verified": 1},
        {"client_id": ""},
        {"client_id": "id with space"},
        {"shop_name": " Wolf"},
        {"shop_name": "Wolf‮Wren"},
    ],
)
def test_bad_join_inputs_are_refused_before_anything_is_written(conn: psycopg.Connection, changes: dict) -> None:
    with pytest.raises(MembershipRefused):
        join(conn, "ok@shop.example", **changes)
    assert conn.execute("select (select count(*) from members), (select count(*) from audit_log)").fetchone() == (0, 0)


def test_leaving_voids_unsent_campaigns_and_keeps_sent_ones_with_no_member(conn: psycopg.Connection) -> None:
    leaver = join(conn, "leaver@shop.example")
    stayer = join(conn, "stayer@shop.example")
    draft = campaign(conn, "draft", leaver, stayer)
    awaiting = campaign(conn, "awaiting_approval", leaver)
    approved = campaign(conn, "approved", stayer, leaver)
    submitted = campaign(conn, "submitted", leaver, stayer)
    untouched = campaign(conn, "draft", stayer)

    result = leave_member(conn, leaver)

    assert result.removed and set(result.voided_campaigns) == {draft, awaiting, approved}
    assert statuses(conn) == {
        draft: ("voided", LEFT_REASON),
        awaiting: ("voided", LEFT_REASON),
        approved: ("voided", LEFT_REASON),
        submitted: ("submitted", None),
        untouched: ("draft", None),
    }
    rows = conn.execute("select campaign_id, ref, member_id from campaign_members order by campaign_id, ref").fetchall()
    assert {(c, ref, m) for c, ref, m in rows if c in (draft, approved)} == {(draft, "R2", stayer), (approved, "R1", stayer)}
    assert not [row for row in rows if row[0] == awaiting]
    assert {(ref, m) for c, ref, m in rows if c == submitted} == {("R1", None), ("R2", stayer)}
    assert conn.execute("select count(*) from members where member_id = %s", (leaver,)).fetchone()[0] == 0
    assert match_member_to_customer(conn, leaver) is None


def test_the_leave_audit_row_holds_only_the_member_id(conn: psycopg.Connection) -> None:
    leaver = join(conn, "leaver@shop.example", "PAYERLEAVE")
    voided = campaign(conn, "draft", leaver)
    leave_member(conn, leaver)
    rows = conn.execute("select action, detail from audit_log where action <> 'member_joined' order by id").fetchall()
    assert rows == [
        ("member_left", {"member_id": str(leaver)}),
        ("campaign_voided", {"campaign_id": str(voided), "reason": LEFT_REASON}),
    ]
    everything = conn.execute("select string_agg(detail::text, ' ') from audit_log").fetchone()[0]
    assert "@" not in everything and "PAYERLEAVE" not in everything


def test_leaving_twice_is_harmless(conn: psycopg.Connection) -> None:
    member = join(conn, "twice@shop.example")
    assert leave_member(conn, member).removed
    assert leave_member(conn, member) == leave_member(conn, uuid.uuid4())
    assert not leave_member(conn, member).removed
    with pytest.raises(ValueError):
        leave_member(conn, str(member))  # type: ignore[arg-type]


def test_a_member_matches_a_customer_by_normalised_email_only(conn: psycopg.Connection) -> None:
    conn.execute(
        "insert into shop_customers (customer_ref, display_name, email, country) values "
        "('C1', 'Maya R.', 'c1@shop.example', 'UK'), ('C2', 'Maya R.', 'C2@Shop.example', 'UK'), "
        "('C3', 'Lena A.', 'twin@shop.example', 'UK'), ('C4', 'Omar B.', 'TWIN@shop.example', 'UK')"
    )
    assert match_member_to_customer(conn, join(conn, "C1@SHOP.EXAMPLE")) == "C1"
    assert match_member_to_customer(conn, join(conn, "c2@shop.example")) == "C2"
    assert match_member_to_customer(conn, join(conn, "twin@shop.example")) is None
    assert match_member_to_customer(conn, join(conn, "maya@outside.example")) is None


def test_a_shop_record_with_another_email_never_becomes_the_receiver(conn: psycopg.Connection) -> None:
    conn.execute("insert into shop_customers values ('C9', 'Ivy E.', 'c9@shop.example', 'UK')")
    member = join(conn, "c9@shop.example")
    conn.execute("update shop_customers set email = 'evil@example.com' where customer_ref = 'C9'")
    assert conn.execute("select paypal_email from members where member_id = %s", (member,)).fetchone()[0] == "c9@shop.example"
    assert match_member_to_customer(conn, member) is None


def test_an_unverified_email_links_to_no_shop_history(conn: psycopg.Connection) -> None:
    conn.execute("insert into shop_customers values ('C5', 'Rosa T.', 'c5@shop.example', 'UK')")
    unverified = join(conn, "c5@shop.example", email_verified=False)
    assert match_member_to_customer(conn, unverified) is None
    leave_member(conn, unverified)
    assert match_member_to_customer(conn, join(conn, "c5@shop.example")) == "C5"
