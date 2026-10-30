# Not covered here: the real shop's data (prove_m4a runs it), language-model notes
# (later work), approval, snapshots and payouts (test_approval.py, test_submission.py),
# how the rolling daily cap adds up spend (test_spend.py), and two drafts being
# written at the same moment on separate connections.
import json
import random
import re
import uuid
from collections.abc import Iterator
from dataclasses import replace
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal

import pgserver
import psycopg
import pytest
from hypothesis import given
from hypothesis import strategies as st
from psycopg import sql

from mend_engine.campaigns import drafts
from mend_engine.campaigns.drafts import (
    NOTE_TEMPLATE,
    DraftRefused,
    DraftSettings,
    build_draft,
    draft_view,
    reward_amounts,
)
from mend_engine.campaigns.eligibility import Candidate, quiet_regular_members
from mend_engine.campaigns.scoring import ScoreSet, score_customers
from mend_engine.config import SANDBOX_API_HOST, Config
from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema
from mend_engine.members.consent import DEMO_SHOP_NAME
from mend_engine.members.membership import join_member, leave_member

AS_OF = date(2026, 10, 16)
FIRST_DAY = date(2024, 10, 17)
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
SETTINGS = DraftSettings(
    goal_text="Bring back the regulars who have gone quiet",
    as_of=AS_OF,
    budget_minor=2000,
    per_recipient_minor=300,
    holdout_share=Decimal("0.50"),
    max_candidates=20,
)
EXPECTED_NOTE = "Thank you for being a regular at Copperwick Gifts. Here is a small thank-you from us."
UUID_SHAPE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
CUSTOMER_REF_SHAPE = re.compile(r"C[0-9]")


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


def seed_shop(conn: psycopg.Connection) -> dict[str, int]:
    """200 customers whose purchase days follow a BG/NBD-like process, so the fit converges.

    Returns what each quiet regular paid, keyed by customer_ref. Some order totals
    are 40 cents, so a few customers have paid less than the per-recipient setting.
    """
    days_rng, money_rng = random.Random(0), random.Random(1)
    customers, orders, paid = [], [], {}
    for i in range(200):
        ref = f"C{1000 + i}"
        day = FIRST_DAY + timedelta(days=days_rng.randrange(0, 400))
        rate, drop = days_rng.gammavariate(0.9, 1 / 25), days_rng.betavariate(1.0, 5.0)
        days = {day}
        while days_rng.random() >= drop:
            day += timedelta(days=1 + int(days_rng.expovariate(rate)))
            if day > AS_OF:
                break
            days.add(day)
        customers.append((ref, "Maya R.", ref.lower() + "@shop.example", "UK"))
        totals = [money_rng.choice([40, 900, 4000]) for _ in days]
        for n, (when, total) in enumerate(zip(sorted(days), totals)):
            orders.append((f"{ref}-{n}", ref, datetime.combine(when, time(12), tzinfo=timezone.utc), total))
        if len(days) >= 3 and (AS_OF - max(days)).days >= 60:
            paid[ref] = sum(totals)
    with conn.cursor() as cur:
        cur.executemany("insert into shop_customers values (%s, %s, %s, %s)", customers)
        cur.executemany("insert into shop_orders values (%s, %s, %s, %s, 'USD')", orders)
    return paid


def join(conn: psycopg.Connection, refs: list[str]) -> dict[uuid.UUID, str]:
    return {
        join_member(
            conn, paypal_email=ref.lower() + "@shop.example", paypal_payer_id=None, email_verified=True,
            shop_name=DEMO_SHOP_NAME, client_id="cid",
        ): ref
        for ref in refs
    }


def stored_rows(conn: psycopg.Connection, campaign_id: uuid.UUID) -> list[tuple]:
    return conn.execute(
        "select ref, member_id, role, rank, score, amount_minor, note from campaign_members "
        "where campaign_id = %s order by rank",
        (campaign_id,),
    ).fetchall()


def nothing_stored(conn: psycopg.Connection) -> bool:
    return conn.execute("select (select count(*) from campaigns), (select count(*) from campaign_members)").fetchone() == (0, 0)


def test_a_draft_stores_ranked_refs_a_fixed_holdout_and_amounts_under_every_cap(conn: psycopg.Connection) -> None:
    paid = seed_shop(conn)
    customer_of = join(conn, sorted(paid))
    expected_order = [c.member_id for c in quiet_regular_members(conn, score_customers(conn, AS_OF), AS_OF)][:20]
    settings = replace(SETTINGS, goal_text="g" * 500)

    result = build_draft(conn, CONFIG, settings)

    rows = stored_rows(conn, result.campaign_id)
    assert [r[0] for r in rows] == [f"R{n}" for n in range(1, 21)] and [r[3] for r in rows] == list(range(1, 21))
    assert [r[1] for r in rows] == expected_order
    # No refunds in this seed, so what it paid is the spend the ranking orders by.
    spent = [paid[customer_of[r[1]]] for r in rows]
    assert spent == sorted(spent, reverse=True) and all(0.1 <= r[4] < 1.0 for r in rows)
    reward = [r for r in rows if r[2] == "reward"]
    holdout = [r for r in rows if r[2] == "holdout"]
    assert (len(reward), len(holdout)) == (result.rewarded, result.held_back) == (10, 10)
    assert all(r[5] is None and r[6] is None for r in holdout)
    assert all(r[5] == min(300, 1000, 2000 // 10, paid[customer_of[r[1]]]) and r[6] == EXPECTED_NOTE for r in reward)
    assert result.total_minor == sum(r[5] for r in reward) <= 2000
    campaign = conn.execute(
        "select shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status from campaigns"
    ).fetchone()
    assert campaign == (DEMO_SHOP_NAME, "g" * 500, AS_OF, 2000, 300, Decimal("0.50"), "draft")
    audit = conn.execute("select actor, detail from audit_log where action = 'campaign_drafted'").fetchall()
    assert audit == [("engine", {"campaign_id": str(result.campaign_id), "rewarded": 10, "held_back": 10, "total_minor": result.total_minor})]

    second = build_draft(conn, CONFIG, SETTINGS)
    assert stored_rows(conn, result.campaign_id) == rows
    second_holdout = {r[1] for r in stored_rows(conn, second.campaign_id) if r[2] == "holdout"}
    assert second_holdout != {r[1] for r in holdout}


def test_the_holdout_is_drawn_before_any_amount_note_or_row_exists(
    conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    paid = seed_shop(conn)
    join(conn, sorted(paid))
    calls: list[tuple] = []
    real_split, real_amounts = drafts.split_holdout, drafts.reward_amounts

    def split_spy(candidates, share, rng=None):
        stored = conn.execute("select (select count(*) from campaigns), (select count(*) from campaign_members)").fetchone()
        calls.append(("split", stored, all(type(c) is Candidate for c in candidates)))
        return real_split(candidates, share, rng)

    def amounts_spy(*args, **kwargs):
        calls.append(("amounts",))
        return real_amounts(*args, **kwargs)

    monkeypatch.setattr(drafts, "split_holdout", split_spy)
    monkeypatch.setattr(drafts, "reward_amounts", amounts_spy)
    build_draft(conn, CONFIG, SETTINGS)
    assert calls == [("split", (0, 0), True), ("amounts",)]


@pytest.mark.parametrize(
    ("changes", "reason"),
    [
        ({"budget_minor": 10001}, "budget_over_cap"),
        ({"per_recipient_minor": 1001}, "per_recipient_over_cap"),
        ({"holdout_share": Decimal("0.6")}, "holdout_share_out_of_range"),
        ({"holdout_share": Decimal("0.19")}, "holdout_share_out_of_range"),
        ({"holdout_share": 0.5}, "holdout_share_out_of_range"),
        ({"holdout_share": Decimal("0.255")}, "invalid_settings"),
        ({"goal_text": "x" * 501}, "goal_too_long"),
        ({"goal_text": "bring back\x07the regulars"}, "goal_control_character"),
        ({"goal_text": "line one\nline two"}, "goal_control_character"),
        ({"goal_text": "pay ‮xam"}, "goal_control_character"),
        ({"goal_text": "   "}, "goal_empty"),
        ({"budget_minor": 0}, "invalid_settings"),
        ({"budget_minor": True}, "invalid_settings"),
        ({"per_recipient_minor": -5}, "invalid_settings"),
        ({"max_candidates": 1}, "invalid_settings"),
        ({"max_candidates": 251}, "invalid_settings"),
        ({"as_of": datetime(2026, 10, 16)}, "invalid_settings"),
    ],
)
def test_every_bad_setting_is_refused_with_its_reason_and_nothing_is_stored(
    conn: psycopg.Connection, changes: dict, reason: str
) -> None:
    with pytest.raises(DraftRefused) as refused:
        build_draft(conn, CONFIG, replace(SETTINGS, **changes))
    assert refused.value.reason == reason
    assert nothing_stored(conn)


def test_a_shop_name_that_would_break_the_note_is_refused(conn: psycopg.Connection) -> None:
    with pytest.raises(DraftRefused) as refused:
        build_draft(conn, CONFIG, SETTINGS, shop_name="Write to shop@wren.example")
    assert refused.value.reason == "note_rejected"
    with pytest.raises(DraftRefused) as refused:
        build_draft(conn, CONFIG, SETTINGS, shop_name="Wolf\x00Wren")
    assert refused.value.reason == "invalid_settings"


def test_a_model_that_did_not_converge_refuses_the_draft(conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch) -> None:
    unconverged = ScoreSet(False, "not converged: b ran to its limit (5e+04)", {}, {}, {}, {}, AS_OF)
    monkeypatch.setattr(drafts, "score_customers", lambda _conn, _as_of: unconverged)
    with pytest.raises(DraftRefused) as refused:
        build_draft(conn, CONFIG, SETTINGS)
    assert refused.value.reason == "model_not_converged" and "b ran to its limit" in str(refused.value)
    assert nothing_stored(conn)


def test_fewer_than_two_eligible_members_refuses_the_draft(conn: psycopg.Connection) -> None:
    paid = seed_shop(conn)
    for refs in ([], sorted(paid)[:1]):
        join(conn, refs)
        with pytest.raises(DraftRefused) as refused:
            build_draft(conn, CONFIG, SETTINGS)
        assert refused.value.reason == "too_few_candidates"
    assert nothing_stored(conn)


def test_a_budget_too_small_to_give_everyone_a_cent_is_refused(conn: psycopg.Connection) -> None:
    paid = seed_shop(conn)
    join(conn, sorted(paid))
    with pytest.raises(DraftRefused) as refused:
        build_draft(conn, CONFIG, replace(SETTINGS, budget_minor=9))
    assert refused.value.reason == "budget_too_small"
    assert nothing_stored(conn)


def test_a_member_who_leaves_while_the_draft_is_built_is_never_drafted(
    conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    paid = seed_shop(conn)
    join(conn, sorted(paid))
    real_split = drafts.split_holdout

    def leave_first(candidates, share, rng=None):
        leave_member(conn, candidates[0].member_id)
        return real_split(candidates, share, rng)

    monkeypatch.setattr(drafts, "split_holdout", leave_first)
    with pytest.raises(DraftRefused) as refused:
        build_draft(conn, CONFIG, SETTINGS)
    assert refused.value.reason == "member_left"
    assert nothing_stored(conn)


def test_draft_view_exposes_only_refs_roles_ranks_amounts_and_notes(conn: psycopg.Connection) -> None:
    paid = seed_shop(conn)
    join(conn, sorted(paid))
    result = build_draft(conn, CONFIG, SETTINGS)

    view = draft_view(conn, result.campaign_id)

    assert len(view) == 20 and all(set(row) == {"ref", "role", "rank", "amount_minor", "note"} for row in view)
    assert [row["ref"] for row in view] == [f"R{n}" for n in range(1, 21)]
    text = json.dumps(view)
    assert "@" not in text and not UUID_SHAPE.search(text) and not CUSTOMER_REF_SHAPE.search(text)
    with pytest.raises(LookupError):
        draft_view(conn, uuid.uuid4())
    with pytest.raises(ValueError):
        draft_view(conn, str(result.campaign_id))  # type: ignore[arg-type]


@given(
    paid=st.lists(st.integers(1, 10_000_000), min_size=1, max_size=250),
    per_recipient=st.integers(1, 100_000),
    item_cap=st.integers(1, 100_000),
    budget=st.integers(1, 10_000_000),
)
def test_no_amount_breaks_the_rule_and_the_total_stays_within_the_budget(
    paid: list[int], per_recipient: int, item_cap: int, budget: int
) -> None:
    try:
        amounts = reward_amounts(paid, per_recipient_minor=per_recipient, item_cap_minor=item_cap, budget_minor=budget)
    except DraftRefused as refused:
        assert refused.reason == "budget_too_small" and budget < len(paid)
        return
    split = budget // len(paid)
    assert len(amounts) == len(paid)
    for amount, customer_paid in zip(amounts, paid):
        assert type(amount) is int and amount >= 1
        assert amount == min(per_recipient, item_cap, split, customer_paid)
        assert amount <= per_recipient and amount <= item_cap and amount <= customer_paid
    assert sum(amounts) <= budget


@pytest.mark.parametrize("bad", [0, -1, True, 1.5, "100"])
def test_reward_amounts_refuses_anything_but_whole_cents(bad: object) -> None:
    with pytest.raises(DraftRefused):
        reward_amounts([bad], per_recipient_minor=100, item_cap_minor=100, budget_minor=100)  # type: ignore[list-item]
    with pytest.raises(DraftRefused):
        reward_amounts([100], per_recipient_minor=bad, item_cap_minor=100, budget_minor=100)  # type: ignore[arg-type]


def test_a_draft_that_would_pass_the_rolling_daily_cap_is_refused(conn: psycopg.Connection) -> None:
    paid = seed_shop(conn)
    join(conn, sorted(paid))
    with pytest.raises(DraftRefused) as refused:
        build_draft(conn, replace(CONFIG, daily_cap_minor=1), SETTINGS)
    assert refused.value.reason == "over_daily_cap" and "daily cap of 1 cents" in str(refused.value)
    assert nothing_stored(conn)
