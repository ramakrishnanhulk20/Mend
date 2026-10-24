# Not covered here: the BG/NBD fit itself (test_bgnbd.py) and its ranking quality
# (test_backtest.py), the real shop's numbers (prove_m4a runs them), and members
# joining or leaving while the list is being read.
import uuid
from collections.abc import Iterator
from dataclasses import replace
from datetime import date, datetime, timezone

import pgserver
import psycopg
import pytest
from psycopg import sql

from mend_engine.campaigns.eligibility import Candidate, quiet_regular_members
from mend_engine.campaigns.scoring import ScoreSet, paid_net_of_refunds, score_customers
from mend_engine.db.connect import PGDATA, SCHEMA_PATH
from mend_engine.members.consent import DEMO_SHOP_NAME
from mend_engine.members.membership import join_member

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
            connection.execute(SCHEMA_PATH.read_text(encoding="utf-8"))
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
