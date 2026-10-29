# Not covered here: the BG/NBD fit itself (test_bgnbd.py) and its ranking quality
# (test_backtest.py), the real shop's numbers (prove_m4a runs them), members
# joining or leaving while the list is being read, two drafts racing for the same
# members (tasks.draft_campaign serialises them with a lock, test_tasks.py), and two
# threads missing the score cache at once.
import uuid
from collections.abc import Iterator
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone

import pgserver
import psycopg
import pytest
from psycopg import sql
from test_membership import CONSENT_2026_10_27

from mend_engine.campaigns.eligibility import Candidate, quiet_regular_members
from mend_engine.campaigns.scoring import ScoreSet, paid_net_of_refunds, score_customers
from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema
from mend_engine.members.consent import DEMO_SHOP_NAME, consent_hash
from mend_engine.members.membership import join_member
from mend_engine.paypal.payouts import BatchSnapshot, PayoutItemSpec, canonical_json, sender_batch_id_for, snapshot_hash

AS_OF = date(2026, 10, 16)


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


def customer(conn: psycopg.Connection, ref: str) -> None:
    conn.execute(
        "insert into shop_customers (customer_ref, display_name, email, country) values (%s, 'Maya R.', %s, 'UK')",
        (ref, ref.lower() + "@shop.example"),
    )


def member(conn: psycopg.Connection, email: str) -> uuid.UUID:
    return join_member(
        conn, paypal_email=email, paypal_payer_id=None, email_verified=True, shop_name=DEMO_SHOP_NAME, client_id="cid"
    )


def scores(rows: dict[str, tuple[float, int, int]]) -> ScoreSet:
    """rows maps customer_ref to (score, purchase days, days silent)."""
    return ScoreSet(
        converged=True,
        message="converged",
        scores={ref: row[0] for ref, row in rows.items()},
        purchase_days={ref: row[1] for ref, row in rows.items()},
        days_silent={ref: row[2] for ref, row in rows.items()},
        paid_minor={ref: 1000 + i for i, ref in enumerate(rows)},
        as_of=AS_OF,
    )


def test_only_members_who_are_quiet_regulars_are_eligible(conn: psycopg.Connection) -> None:
    rows = {
        "C1": (0.30, 3, 60),  # exactly at both limits: eligible
        "C2": (0.10, 2, 400),  # only two purchase days
        "C3": (0.10, 9, 59),  # one day short of quiet
        "C4": (0.20, 9, 200),  # quiet regular who never joined
        "C5": (0.05, 12, 90),
    }
    for ref in rows:
        customer(conn, ref)
    ids = {ref: member(conn, ref.lower() + "@shop.example") for ref in ("C1", "C2", "C3", "C5")}
    member(conn, "outsider@mend.example")

    found = quiet_regular_members(conn, scores(rows), AS_OF)

    assert found == [
        Candidate(ids["C5"], "C5", 0.05, 1004),
        Candidate(ids["C1"], "C1", 0.30, 1000),
    ]


def test_a_customer_with_no_score_is_not_eligible(conn: psycopg.Connection) -> None:
    customer(conn, "C7")
    member(conn, "c7@shop.example")
    assert quiet_regular_members(conn, scores({}), AS_OF) == []


def test_most_at_risk_come_first_and_ties_follow_the_customer_ref(conn: psycopg.Connection) -> None:
    rows = {"C40": (0.5, 5, 100), "C10": (0.0, 5, 100), "C30": (0.2, 5, 100), "C20": (0.0, 5, 100)}
    for ref in rows:
        customer(conn, ref)
        member(conn, ref.lower() + "@shop.example")
    found = quiet_regular_members(conn, scores(rows), AS_OF)
    assert [c.customer_ref for c in found] == ["C10", "C20", "C30", "C40"]


def test_scores_that_did_not_converge_rank_nobody(conn: psycopg.Connection) -> None:
    unconverged = ScoreSet(False, "not converged: a ran to its limit", {}, {}, {}, {}, AS_OF)
    with pytest.raises(ValueError):
        quiet_regular_members(conn, unconverged, AS_OF)
    with pytest.raises(ValueError):
        quiet_regular_members(conn, scores({}), datetime(2026, 10, 16))  # type: ignore[arg-type]


def test_scores_from_another_day_are_refused(conn: psycopg.Connection) -> None:
    customer(conn, "C1")
    member(conn, "c1@shop.example")
    with pytest.raises(ValueError, match="different day"):
        quiet_regular_members(conn, scores({"C1": (0.1, 5, 100)}), date(2026, 10, 15))
    assert score_customers(conn, AS_OF).as_of == AS_OF


def test_purchase_days_are_london_days_up_to_as_of(conn: psycopg.Connection) -> None:
    customer(conn, "C1")
    orders = [
        ("o1", datetime(2026, 6, 1, 9, 0, tzinfo=timezone.utc), 500),
        ("o2", datetime(2026, 6, 1, 22, 30, tzinfo=timezone.utc), 700),  # 23:30 in London, same day
        ("o3", datetime(2026, 8, 3, 23, 30, tzinfo=timezone.utc), 900),  # 00:30 on 4 Aug in London
        ("o4", datetime(2026, 10, 16, 22, 59, tzinfo=timezone.utc), 100),  # 23:59 on as_of in London
        ("o5", datetime(2026, 10, 16, 23, 0, tzinfo=timezone.utc), 5000),  # 00:00 the next day in London
    ]
    conn.cursor().executemany(
        "insert into shop_orders (order_ref, customer_ref, ordered_at, total_minor, currency) values (%s, 'C1', %s, %s, 'USD')",
        orders,
    )
    result = score_customers(conn, AS_OF)
    assert (result.purchase_days, result.days_silent, result.paid_minor) == ({"C1": 3}, {"C1": 0}, {"C1": 2200})

    nobody = score_customers(conn, date(2026, 5, 31))
    assert not nobody.converged and nobody.scores == {} and "nobody had bought" in nobody.message


def test_a_member_whose_email_paypal_has_not_verified_is_never_eligible(conn: psycopg.Connection) -> None:
    rows = {"C1": (0.1, 5, 100), "C2": (0.2, 5, 100)}
    for ref in rows:
        customer(conn, ref)
    verified = member(conn, "c1@shop.example")
    join_member(
        conn, paypal_email="c2@shop.example", paypal_payer_id=None, email_verified=False,
        shop_name=DEMO_SHOP_NAME, client_id="cid",
    )
    assert [c.member_id for c in quiet_regular_members(conn, scores(rows), AS_OF)] == [verified]


def test_paid_amounts_net_out_refunds_up_to_as_of_and_never_go_below_zero(conn: psycopg.Connection) -> None:
    for ref in ("C1", "C2"):
        customer(conn, ref)
    conn.cursor().executemany(
        "insert into shop_orders (order_ref, customer_ref, ordered_at, total_minor, currency) values (%s, %s, %s, %s, 'USD')",
        [
            ("o1", "C1", datetime(2026, 6, 1, 12, tzinfo=timezone.utc), 1000),
            ("o2", "C1", datetime(2026, 7, 1, 12, tzinfo=timezone.utc), 500),
            ("o3", "C2", datetime(2026, 6, 1, 12, tzinfo=timezone.utc), 300),
        ],
    )
    conn.cursor().executemany(
        "insert into shop_refunds (refund_ref, customer_ref, refunded_at, amount_minor) values (%s, %s, %s, %s)",
        [
            ("C1", "C1", datetime(2026, 6, 10, 12, tzinfo=timezone.utc), 400),
            ("C2", "C1", datetime(2026, 10, 16, 23, 0, tzinfo=timezone.utc), 900),  # 00:00 the next day in London
            ("C3", "C2", datetime(2026, 6, 5, 12, tzinfo=timezone.utc), 500),
        ],
    )
    assert score_customers(conn, AS_OF).paid_minor == {"C1": 1100, "C2": 0}
    assert paid_net_of_refunds(conn, date(2026, 10, 17)) == {"C1": 200, "C2": 0}
    assert paid_net_of_refunds(conn, AS_OF, ["C2"]) == {"C2": 0}


def test_a_member_whose_refunds_cancel_what_they_paid_is_not_eligible(conn: psycopg.Connection) -> None:
    rows = {"C1": (0.1, 5, 100), "C2": (0.2, 5, 100)}
    for ref in rows:
        customer(conn, ref)
    ids = {ref: member(conn, ref.lower() + "@shop.example") for ref in rows}
    refunded = replace(scores(rows), paid_minor={"C1": 0, "C2": 1})
    assert [c.member_id for c in quiet_regular_members(conn, refunded, AS_OF)] == [ids["C2"]]


def test_a_member_who_agreed_only_to_an_earlier_wording_is_not_eligible(conn: psycopg.Connection) -> None:
    rows = {"C1": (0.1, 5, 100), "C2": (0.2, 5, 100)}
    for ref in rows:
        customer(conn, ref)
    ids = {ref: member(conn, ref.lower() + "@shop.example") for ref in rows}
    conn.execute("update members set consent_version = '2026-10-20.1' where member_id = %s", (ids["C2"],))
    assert [c.member_id for c in quiet_regular_members(conn, scores(rows), AS_OF)] == [ids["C1"]]


def test_a_member_who_agreed_under_the_shops_earlier_made_up_name_stays_eligible(conn: psycopg.Connection) -> None:
    rows = {"C1": (0.1, 5, 100), "C2": (0.2, 5, 100)}
    for ref in rows:
        customer(conn, ref)
    ids = {ref: member(conn, ref.lower() + "@shop.example") for ref in rows}
    # The row exactly as a join before the rename wrote it: that version, and the hash of the words that member saw.
    conn.execute(
        "update members set consent_version = '2026-10-27.1', consent_text_sha256 = %s where member_id = %s",
        (consent_hash(CONSENT_2026_10_27), ids["C2"]),
    )
    assert [c.member_id for c in quiet_regular_members(conn, scores(rows), AS_OF)] == [ids["C1"], ids["C2"]]


ROUTE = {
    "draft": (),
    "awaiting_approval": ("awaiting_approval",),
    "approved": ("approved",),
    "submitted": ("approved", "submitting", "submitted"),
    "submission_unknown": ("approved", "submitting", "submission_unknown"),
    "voided": ("voided",),
}


def campaign_holding(
    conn: psycopg.Connection, holding: dict[uuid.UUID, str], status: str, *, session: str | None = None, sent_days_ago: int | None = None
) -> uuid.UUID:
    """A campaign holding these members in these roles, moved along the status guard's own arrows.

    session None records it as the owner's; a session id records it as that demo session's.
    sent_days_ago dates its first move to submitted that many days back.
    """
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 1000, 100, 0.5, 'draft') returning campaign_id"
    ).fetchone()[0]
    for rank, (member_id, role) in enumerate(holding.items(), start=1):
        conn.execute(
            "insert into campaign_members (campaign_id, ref, member_id, role, rank, score, amount_minor, note) values (%s, %s, %s, %s, %s, 0.1, %s, %s)",
            (campaign_id, f"R{rank}", member_id, role, rank, 100 if role == "reward" else None, "Thanks" if role == "reward" else None),
        )
    for step in ROUTE[status]:
        conn.execute("update campaigns set status = %s where campaign_id = %s", (step, campaign_id))
    conn.execute(
        "insert into campaign_owners values (%s, %s, %s)", (campaign_id, "demo" if session else "owner", session or "0" * 64)
    )
    if sent_days_ago is not None:
        conn.execute(
            "insert into campaign_status_moves (campaign_id, from_status, to_status, moved_at) "
            "values (%s, 'submitting', 'submitted', now() - make_interval(days => %s))",
            (campaign_id, sent_days_ago),
        )
    return campaign_id


def test_a_member_in_a_running_measurement_of_the_same_scope_is_not_eligible_and_a_draft_holds_nobody(conn: psycopg.Connection) -> None:
    from mend_engine.campaigns.eligibility import DraftScope, drafting_for

    rows = {f"C{n}": (0.01 * n, 5, 100) for n in range(1, 11)}
    for ref in rows:
        customer(conn, ref)
    ids = {ref: member(conn, ref.lower() + "@shop.example") for ref in rows}
    session, other_session = "d" * 64, "e" * 64
    # A measurement starts at approval, so a draft or one awaiting approval holds nobody.
    campaign_holding(conn, {ids["C1"]: "holdout"}, "draft")
    campaign_holding(conn, {ids["C2"]: "reward"}, "awaiting_approval")
    campaign_holding(conn, {ids["C3"]: "reward"}, "submitted")  # sent just now: its 30-day window is open
    campaign_holding(conn, {ids["C4"]: "reward"}, "submitted", sent_days_ago=31)  # its window closed
    campaign_holding(conn, {ids["C5"]: "reward"}, "voided")
    campaign_holding(conn, {ids["C6"]: "reward"}, "approved", session=session)
    campaign_holding(conn, {ids["C7"]: "holdout"}, "submitted", session=other_session)
    campaign_holding(conn, {ids["C9"]: "reward"}, "draft", session=session)
    campaign_holding(conn, {ids["C10"]: "holdout"}, "submission_unknown")
    # An operator script's approved campaign has no owner row; it is the owner's.
    unowned = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 1000, 100, 0.5, 'draft') returning campaign_id"
    ).fetchone()[0]
    conn.execute(
        "insert into campaign_members (campaign_id, ref, member_id, role, rank, score) values (%s, 'R1', %s, 'holdout', 1, 0.1)",
        (unowned, ids["C8"]),
    )
    conn.execute("update campaigns set status = 'approved' where campaign_id = %s", (unowned,))

    def eligible(scope: object = None) -> list[str]:
        found = quiet_regular_members(conn, scores(rows), AS_OF) if scope is None else quiet_regular_members(conn, scores(rows), AS_OF, scope)
        return [c.customer_ref for c in found]

    assert eligible() == ["C1", "C2", "C4", "C5", "C6", "C7", "C9"]
    demo = eligible(DraftScope("demo", session))
    assert demo == ["C1", "C2", "C3", "C4", "C5", "C7", "C8", "C9", "C10"]
    with drafting_for(DraftScope("demo", session)):
        assert eligible() == demo
    assert eligible() == ["C1", "C2", "C4", "C5", "C6", "C7", "C9"]
    with pytest.raises(ValueError):
        DraftScope("demo", None)


def test_a_campaign_with_no_recorded_send_counts_from_its_first_batch_row_and_with_neither_holds_until_voided(
    conn: psycopg.Connection,
) -> None:
    rows = {f"C{n}": (0.01 * n, 5, 100) for n in range(1, 5)}
    for ref in rows:
        customer(conn, ref)
    ids = {ref: member(conn, ref.lower() + "@shop.example") for ref in rows}
    # Campaigns sent before campaign_status_moves existed carry no recorded move to submitted.
    conn.execute("alter table campaigns disable trigger campaigns_status_moved")
    old = campaign_holding(conn, {ids["C1"]: "reward"}, "submitted")
    recent = campaign_holding(conn, {ids["C2"]: "reward"}, "submitted")
    campaign_holding(conn, {ids["C3"]: "holdout"}, "submitted")
    conn.execute("alter table campaigns enable trigger campaigns_status_moved")
    for campaign_id, days in ((old, 31), (old, 2), (recent, 5)):
        conn.execute(
            "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, status, created_at) "
            "values (%s, %s, %s, 'created', now() - make_interval(days => %s))",
            (f"MEND-{uuid.uuid4().hex}", str(campaign_id), "0" * 64, days),
        )
    assert conn.execute("select count(*) from campaign_status_moves where to_status = 'submitted'").fetchone()[0] == 0

    assert [c.customer_ref for c in quiet_regular_members(conn, scores(rows), AS_OF)] == ["C1", "C4"]


def sent_reward(conn: psycopg.Connection, receiver: str, amount_minor: int, days_ago: int, status: str | None = None) -> None:
    """One reward that left the shop days_ago, through a campaign holding no member rows, so only the money is on record."""
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 5000, 5000, 0.5, 'submitted') returning campaign_id"
    ).fetchone()[0]
    snap = BatchSnapshot(str(campaign_id), "USD", "A thank-you", (PayoutItemSpec(receiver, amount_minor, "Thanks", "R1"),))
    conn.execute("insert into approved_snapshots values (%s, %s, %s, now(), 'owner')", (campaign_id, snapshot_hash(snap), canonical_json(snap)))
    conn.execute(
        "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, status, created_at) "
        "values (%s, %s, %s, 'created', now() - make_interval(days => %s))",
        (sender_batch_id_for(snap), str(campaign_id), snapshot_hash(snap), days_ago),
    )
    if status is not None:
        conn.execute(
            "insert into payout_items (payout_item_id, sender_batch_id, sender_item_id, status) values (%s, %s, 'R1', %s)",
            ("ITEM" + uuid.uuid4().hex[:8], sender_batch_id_for(snap), status),
        )


def test_owner_rewards_from_the_last_365_days_plus_the_new_one_never_pass_what_a_member_paid(conn: psycopg.Connection) -> None:
    from mend_engine.campaigns.eligibility import DraftScope

    rows = {f"C{n}": (0.1 * n, 5, 100) for n in range(1, 5)}
    for ref in rows:
        customer(conn, ref)
        member(conn, ref.lower() + "@shop.example")
    paid = scores(rows)  # C1 paid 1000, C2 1001, C3 1002, C4 1003
    sent_reward(conn, "C1@Shop.Example", 900, days_ago=100)
    sent_reward(conn, "c2@shop.example", 600, days_ago=10)
    sent_reward(conn, "c2@shop.example", 401, days_ago=200)  # with the 600, C2 is at the line
    sent_reward(conn, "c3@shop.example", 1002, days_ago=366)  # outside the 365 days
    sent_reward(conn, "c4@shop.example", 1003, days_ago=5, status="RETURNED")  # the money came back

    owner = {c.customer_ref: c.paid_minor for c in quiet_regular_members(conn, paid, AS_OF)}
    demo = {c.customer_ref: c.paid_minor for c in quiet_regular_members(conn, paid, AS_OF, DraftScope("demo", "d" * 64))}

    assert owner == {"C1": 100, "C3": 1002, "C4": 1003}
    assert demo == {"C1": 1000, "C2": 1001, "C3": 1002, "C4": 1003}


def test_refunds_recorded_after_the_scoring_day_still_come_off_what_a_member_paid(conn: psycopg.Connection) -> None:
    rows = {"C1": (0.1, 5, 100), "C2": (0.2, 5, 100), "C3": (0.3, 5, 100)}
    for ref in rows:
        customer(conn, ref)
        member(conn, ref.lower() + "@shop.example")
    paid = replace(scores(rows), paid_minor={"C1": 3000, "C2": 3000, "C3": 3000})
    conn.cursor().executemany(
        "insert into shop_refunds (refund_ref, customer_ref, refunded_at, amount_minor) values (%s, %s, %s, %s)",
        [
            ("X1", "C1", datetime(2026, 10, 20, 12, tzinfo=timezone.utc), 2500),
            ("X2", "C2", datetime(2026, 10, 16, 23, 0, tzinfo=timezone.utc), 3000),  # 00:00 the day after as_of in London
            # Inside as_of, so already netted in the scores; it must not come off twice.
            ("X3", "C3", datetime(2026, 10, 16, 22, 59, tzinfo=timezone.utc), 1000),
        ],
    )
    assert {c.customer_ref: c.paid_minor for c in quiet_regular_members(conn, paid, AS_OF)} == {"C1": 500, "C3": 3000}


def a_small_shop(conn: psycopg.Connection) -> None:
    """Ten customers with a few orders each, enough for the model to be fitted."""
    for n in range(1, 11):
        customer(conn, f"C{n}")
        for k in range(n % 4 + 1):
            conn.execute(
                "insert into shop_orders values (%s, %s, %s, 500, 'USD')",
                (f"o{n}-{k}", f"C{n}", datetime(2026, 1, 5, 12, tzinfo=timezone.utc) + timedelta(days=k * 37 + n)),
            )


def test_scores_are_fitted_once_per_day_and_data_version_and_at_most_four_are_kept(
    conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    from mend_engine.campaigns import scoring

    fits: list[int] = []
    real_fit = scoring.fit
    monkeypatch.setattr(scoring, "fit", lambda *args: fits.append(1) or real_fit(*args))
    a_small_shop(conn)

    first = score_customers(conn, AS_OF)
    kept = replace(first, scores=dict(first.scores), paid_minor=dict(first.paid_minor))
    first.paid_minor.clear()
    again = score_customers(conn, AS_OF)
    assert len(fits) == 1 and again == kept

    conn.execute("insert into shop_orders values ('o-new', 'C1', '2026-09-01 12:00+00', 700, 'USD')")
    assert score_customers(conn, AS_OF).paid_minor["C1"] == kept.paid_minor["C1"] + 700 and len(fits) == 2
    conn.execute("insert into shop_refunds values ('r-new', 'C2', '2026-09-02 12:00+00', 100)")
    assert score_customers(conn, AS_OF).paid_minor["C2"] == kept.paid_minor["C2"] - 100 and len(fits) == 3
    score_customers(conn, AS_OF)
    assert len(fits) == 3

    for day in (date(2026, 10, 12), date(2026, 10, 13), date(2026, 10, 14), date(2026, 10, 15)):
        score_customers(conn, day)
    assert len(fits) == 7
    score_customers(conn, date(2026, 10, 15))
    assert len(fits) == 7
    score_customers(conn, AS_OF)  # pushed out by the four days scored after it
    assert len(fits) == 8
