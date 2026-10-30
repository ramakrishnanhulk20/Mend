# Not covered here: the real UCI import and the real model facts. prove_m2, prove_m4b and
# python -m mend_engine.store_facts run those on the real file; here a small synthetic shop
# and stand-in facts of the stored shape take their place. No PayPal API is involved, and
# two seeds running at once against one database are not exercised.
import json
import random
import uuid
from collections.abc import Iterator
from dataclasses import replace
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

import pgserver
import psycopg
import pytest
from psycopg import sql
from psycopg.types.json import Jsonb

from mend_engine import prove_m4a, seed_demo, store_facts
from mend_engine.campaigns.eligibility import (
    LIKELY_BACK,
    LIKELY_BACK_FROM,
    LIKELY_GONE,
    LIKELY_GONE_BELOW,
    REGULAR_MIN_DAYS,
    SILENT_MIN_DAYS,
    WORTH_A_NUDGE,
    forecast_group,
    quiet_regular_members,
    worth_a_nudge_refs,
)
from mend_engine.campaigns.scoring import HORIZON_WEEKS, score_customers
from mend_engine.config import SANDBOX_API_HOST, Config, ConfigError
from mend_engine.data.uci import ZIP_NAME
from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema
from mend_engine.members.consent import CONSENT_VERSION, DEMO_SHOP_NAME
from mend_engine.members.membership import LEFT_REASON, join_member
from mend_engine.paypal.payouts import normalise_email
from mend_engine.shop.identities import synthetic_email
from mend_engine.shop.import_orders import REFUNDS_SOURCE_SUFFIX

RECEIVER = "Mend-Receiver@Personal.Example"
AS_OF = date(2026, 10, 16)
FIRST_DAY = date(2024, 10, 17)
PARAMETERS = {"r": 0.24, "alpha": 4.41, "a": 0.79, "b": 2.43, "log_likelihood": -9582.4}
CDNOW = {"source": store_facts.CDNOW_SOURCE, "customers": 2357, "fitted": PARAMETERS, "published": PARAMETERS, "passed": True}
UCI = {
    "source": store_facts.UCI_SOURCE,
    "holdout_days": 91,
    "cutoffs": [{"cutoff": "2026-07-17", "customers": 400, "converged": True, "auc_model": 0.71, "auc_recency": 0.66}],
    "converged": 1,
    "model_wins": 1,
    "mean_auc_gain": 0.05,
    "decile_cutoff": "2026-07-17",
    "deciles": [{"decile": 1, "customers": 40, "returned_share": 0.6}],
    "passed": True,
}
GROUP_CUTOFFS = [{"cutoff": "2026-07-17", "customers": 400, "returned": 100, "auc_model": 0.71, "auc_recency": 0.66, "difference": 0.05, "interval_low": 0.01, "interval_high": 0.09}]
GROUP = {"confidence": store_facts.CONFIDENCE, "resamples": store_facts.RESAMPLES, "valid_cutoffs": 1, "model_wins": 1, "mean_auc_difference": 0.05, "interval_low": 0.01, "interval_high": 0.09, "cutoffs": GROUP_CUTOFFS}
UCI["headline"] = {**GROUP, "group": store_facts.LIVE_SEGMENT, "regular_min_days": REGULAR_MIN_DAYS, "silent_min_days": SILENT_MIN_DAYS}
UCI["all_customers"] = {**GROUP, "group": store_facts.ALL_CUSTOMERS, "regular_min_days": None, "silent_min_days": None}
BAND_COUNTS = {
    LIKELY_GONE: {"customers": 200, "returned": 20},
    WORTH_A_NUDGE: {"customers": 150, "returned": 45},
    LIKELY_BACK: {"customers": 50, "returned": 30},
}
UCI[store_facts.UCI_BANDS_KEY] = {
    "likely_gone_below": LIKELY_GONE_BELOW,
    "likely_back_from": LIKELY_BACK_FROM,
    "regular_min_days": REGULAR_MIN_DAYS,
    "silent_min_days": SILENT_MIN_DAYS,
    "horizon_weeks": HORIZON_WEEKS,
    "cutoffs": [{"cutoff": "2026-07-17", "converged": True, **BAND_COUNTS}],
    "pooled": BAND_COUNTS,
    "rising": True,
}
# The lines the operator scripts read. The order and refund counts are the stand-in importers' own.
FRESH_LINES = [
    "orders: imported 1 orders from 600 customers",
    "refunds: imported 0 cancellation records",
    "facts: stored cdnow_benchmark, uci_backtest",
    "members: 40 demo members (40 new)",
    "receiver: MEND_TEST_RECEIVER is a verified member linked to one quiet regular",
    "receiver: already first",
]
SECOND_RUN_LINES = [
    "orders: already imported",
    "refunds: already imported",
    "facts: already stored",
    "members: 40 demo members (0 new)",
    "receiver: MEND_TEST_RECEIVER is a verified member already linked",
    "receiver: already first",
]


def synthetic_shop(conn: psycopg.Connection) -> None:
    """600 customers whose purchase days follow a BG/NBD-like process, as the importer would store them."""
    rng = random.Random(7)
    customers, orders = [], []
    for i in range(600):
        ref = f"C{2000 + i}"
        day = FIRST_DAY + timedelta(days=rng.randrange(0, 400))
        rate, drop = rng.gammavariate(0.9, 1 / 25), rng.betavariate(1.0, 5.0)
        days = {day}
        while rng.random() >= drop:
            day += timedelta(days=1 + int(rng.expovariate(rate)))
            if day > AS_OF:
                break
            days.add(day)
        customers.append((ref, "Sam K.", ref.lower() + "@shop.example", "UK"))
        orders += [(f"{ref}-{n}", ref, datetime.combine(when, time(12), tzinfo=timezone.utc), 900) for n, when in enumerate(sorted(days))]
    with conn.cursor() as cur:
        cur.executemany("insert into shop_customers values (%s, %s, %s, %s)", customers)
        cur.executemany("insert into shop_orders values (%s, %s, %s, %s, 'USD')", orders)


class Stand:
    """Stand-ins for the importers and the fact computations, counting their calls."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def import_uci(self, conn: psycopg.Connection, path: Path) -> object:
        self.calls.append("orders")
        synthetic_shop(conn)
        conn.execute("insert into import_runs (source, source_bytes, lines_read, lines_kept, week_shift) values (%s, 1, 1, 1, 0)", (ZIP_NAME,))
        return type("Result", (), {"orders": 1, "customers": 600})()

    def import_refunds(self, conn: psycopg.Connection, path: Path) -> object:
        self.calls.append("refunds")
        conn.execute(
            "insert into import_runs (source, source_bytes, lines_read, lines_kept, week_shift) values (%s, 1, 0, 0, 0)",
            (ZIP_NAME + REFUNDS_SOURCE_SUFFIX,),
        )
        return type("Result", (), {"refunds": 0})()

    def fact(self, key: str, value: dict):
        return lambda: self.calls.append(key) or value


@pytest.fixture
def schema_url() -> Iterator[tuple[str, str]]:
    url = pgserver.get_server(PGDATA).get_uri()
    name = "seed_" + uuid.uuid4().hex[:12]
    with psycopg.connect(url, autocommit=True) as admin:
        admin.execute(sql.SQL("create schema {}").format(sql.Identifier(name)))
        try:
            yield url, name
        finally:
            admin.execute(sql.SQL("drop schema {} cascade").format(sql.Identifier(name)))


def config_for(url: str, schema: str, receiver: str | None = RECEIVER) -> Config:
    parts = urlsplit(url)
    query = urlencode([*parse_qsl(parts.query), ("options", f"-c search_path={schema}")], quote_via=quote)
    return Config(
        paypal_client_id="cid", paypal_client_secret="csecret-for-seed-tests", paypal_api_host=SANDBOX_API_HOST,
        database_url=urlunsplit(parts._replace(query=query)), dev=False, test_receiver=receiver,
        item_cap_minor=1000, campaign_cap_minor=10000, daily_cap_minor=20000,
    )


@pytest.fixture
def seeded(schema_url: tuple[str, str], monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[psycopg.Connection, Config, Stand]]:
    url, schema = schema_url
    stand = Stand()
    monkeypatch.setattr(seed_demo, "ensure_source", lambda cache: Path("unused.zip"))
    monkeypatch.setattr(seed_demo, "import_uci", stand.import_uci)
    monkeypatch.setattr(seed_demo, "import_refunds", stand.import_refunds)
    monkeypatch.setattr(store_facts, "cdnow_fact", stand.fact("cdnow", CDNOW))
    monkeypatch.setattr(store_facts, "uci_fact", stand.fact("uci", UCI))
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(sql.SQL("set search_path to {}").format(sql.Identifier(schema)))
        apply_schema(conn)
        yield conn, config_for(url, schema), stand


def state(conn: psycopg.Connection) -> tuple:
    return conn.execute(
        "select (select array_agg(member_id order by member_id) from members), "
        "(select count(*) from audit_log), (select count(*) from import_runs), "
        "(select array_agg(computed_at order by key) from model_facts), "
        "(select md5(string_agg(customer_ref || email, ',' order by customer_ref)) from shop_customers)"
    ).fetchone()


def member_matches(conn: psycopg.Connection) -> dict[uuid.UUID, list[str]]:
    """Every member, with the shop customers its PayPal email matches through the one email normaliser."""
    by_email: dict[str, list[str]] = {}
    for ref, email in conn.execute("select customer_ref, email from shop_customers"):
        by_email.setdefault(normalise_email(email), []).append(ref)
    return {member_id: by_email.get(normalise_email(email), []) for member_id, email in conn.execute("select member_id, paypal_email from members")}


def receiver_member(conn: psycopg.Connection) -> uuid.UUID:
    return conn.execute("select member_id from members where paypal_email = %s", (normalise_email(RECEIVER),)).fetchone()[0]


def seed_up_to_the_receiver(conn: psycopg.Connection, config: Config):
    seed_demo.seed_orders(conn)
    seed_demo.seed_refunds(conn)
    scores = seed_demo.shop_scores(conn)
    seed_demo.seed_members(conn, config, scores)
    seed_demo.seed_receiver(conn, config, scores)
    return scores


def audit_rows(conn: psycopg.Connection) -> int:
    return conn.execute("select count(*) from audit_log").fetchone()[0]


def trade_emails(conn: psycopg.Connection, a: str, b: str) -> None:
    """Swap two shop customers' emails, as the earlier rule's move first did; email is unique, so one row waits on a placeholder."""
    emails = dict(conn.execute("select customer_ref, email from shop_customers where customer_ref = any(%s)", ([a, b],)))
    with conn.transaction():
        conn.execute("update shop_customers set email = 'trading' where customer_ref = %s", (a,))
        conn.execute("update shop_customers set email = %s where customer_ref = %s", (emails[a], b))
        conn.execute("update shop_customers set email = %s where customer_ref = %s", (emails[b], a))


def campaign_holding(conn: psycopg.Connection, member_id: uuid.UUID, *moves: str) -> uuid.UUID:
    """An owner campaign rewarding this one member, moved along the status guard's own arrows."""
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 1000, 100, 0.5, 'draft') returning campaign_id"
    ).fetchone()[0]
    conn.execute(
        "insert into campaign_members (campaign_id, ref, member_id, role, rank, score, amount_minor, note) "
        "values (%s, 'R1', %s, 'reward', 1, 0.1, 100, 'Thanks')",
        (campaign_id, member_id),
    )
    for status in moves:
        conn.execute("update campaigns set status = %s where campaign_id = %s", (status, campaign_id))
    return campaign_id


def test_a_fresh_database_gets_the_shop_the_facts_the_40_demo_members_and_the_test_receiver_at_rank_1(
    seeded: tuple, capsys: pytest.CaptureFixture[str]
) -> None:
    conn, config, stand = seeded
    assert seed_demo.run(config) is True
    assert stand.calls == ["orders", "refunds", "cdnow", "uci"]
    assert all(store_facts.read_facts(conn).values())
    out = capsys.readouterr().out
    assert out.splitlines() == FRESH_LINES
    assert RECEIVER.lower() not in out.lower()

    scores = score_customers(conn, AS_OF)
    group = worth_a_nudge_refs(scores)
    assert len(group) > 41 and prove_m4a.demo_customers(scores) == group[1:41]
    members = dict(conn.execute("select paypal_email, email_verified from members"))
    assert len(members) == 41 and all(members.values())
    # One shop customer each: the receiver holds rank 1 of the worth-a-nudge group, the stand-ins ranks 2 to 41.
    receiver = receiver_member(conn)
    matched = member_matches(conn)
    assert matched.pop(receiver) == [group[0]]
    assert sorted(matched.values()) == sorted([ref] for ref in group[1:41])
    ranked = quiet_regular_members(conn, scores, AS_OF)
    assert ranked[0].member_id == receiver and {c.member_id for c in ranked} == {receiver, *matched}
    actions = conn.execute("select action, actor from audit_log where action <> 'member_joined' order by id").fetchall()
    assert actions == [("shop_customer_linked_to_sandbox_receiver", "seed_demo")]
    # Every member here was joined by the seed, the receiver too, so each is a labelled stand-in under the seed's name.
    assert conn.execute("select actor, count(*) from audit_log where action = 'member_joined' group by actor").fetchall() == [("seed_demo", 41)]
    assert conn.execute("select source, consent_version, count(*) from members group by 1, 2").fetchall() == [("seed", CONSENT_VERSION, 41)]


def test_a_second_run_changes_nothing(seeded: tuple, capsys: pytest.CaptureFixture[str]) -> None:
    conn, config, stand = seeded
    assert seed_demo.run(config) is True
    before = state(conn)
    capsys.readouterr()
    assert seed_demo.run(config) is True
    assert state(conn) == before
    assert stand.calls == ["orders", "refunds", "cdnow", "uci"]
    assert capsys.readouterr().out.splitlines() == SECOND_RUN_LINES


@pytest.mark.parametrize(
    "dropped",
    [store_facts.UCI_GROUP_KEYS | {store_facts.UCI_BANDS_KEY}, {store_facts.UCI_BANDS_KEY}],
    ids=["before the segment headline", "before the forecast bands"],
)
def test_a_backtest_stored_before_the_segment_headline_or_the_forecast_bands_is_computed_again(
    seeded: tuple, capsys: pytest.CaptureFixture[str], dropped: frozenset[str]
) -> None:
    conn, config, stand = seeded
    assert seed_demo.run(config) is True
    old_shape = conn.execute("select value from model_facts where key = %s", (store_facts.UCI_KEY,)).fetchone()[0]
    for key in dropped:
        del old_shape[key]
    with conn.transaction():
        conn.execute("update model_facts set value = %s where key = %s", (Jsonb(old_shape), store_facts.UCI_KEY))
    # Both earlier shapes still read, so only their age can make the seed compute them again.
    assert store_facts.read_facts(conn)[store_facts.UCI_KEY] is not None
    capsys.readouterr()

    assert seed_demo.run(config) is True

    assert stand.calls == ["orders", "refunds", "cdnow", "uci", "uci"]
    assert "facts: stored uci_backtest" in capsys.readouterr().out.splitlines()
    stored = conn.execute("select value from model_facts where key = %s", (store_facts.UCI_KEY,)).fetchone()[0]
    assert store_facts.UCI_GROUP_KEYS | {store_facts.UCI_BANDS_KEY} <= stored.keys()


def test_a_receiver_linked_to_another_worth_a_nudge_row_moves_to_rank_1_and_no_member_is_displaced(seeded: tuple) -> None:
    conn, config, stand = seeded
    scores = seed_up_to_the_receiver(conn, config)
    group = worth_a_nudge_refs(scores)
    # Rank 42 is the first worth-a-nudge customer no stand-in holds, so rank 1 is left matching nobody.
    trade_emails(conn, group[0], group[41])
    receiver = receiver_member(conn)
    before = quiet_regular_members(conn, scores, AS_OF)
    was_rank = [candidate.member_id for candidate in before].index(receiver) + 1
    matched_before = member_matches(conn)
    audit_before = audit_rows(conn)
    assert matched_before[receiver] == [group[41]] and was_rank == 41

    assert seed_demo.seed_receiver_first(conn, config, scores) == f"receiver: moved to rank 1 (was rank {was_rank})"

    after = quiet_regular_members(conn, scores, AS_OF)
    matched = member_matches(conn)
    assert after[0].member_id == receiver and after[0].customer_ref == group[0]
    # The same 41 members, every one still a candidate, and only the receiver matches another customer.
    assert sorted(c.member_id for c in after) == sorted(c.member_id for c in before) == sorted(matched)
    assert matched[receiver] == [group[0]]
    assert {m: r for m, r in matched.items() if m != receiver} == {m: r for m, r in matched_before.items() if m != receiver}
    rank_42 = conn.execute("select email from shop_customers where customer_ref = %s", (group[41],)).fetchone()[0]
    assert rank_42 == synthetic_email(group[41])
    [(actor, detail)] = conn.execute("select actor, detail from audit_log where action = 'sandbox_receiver_moved_first'").fetchall()
    assert actor == "seed_demo" and audit_rows(conn) == audit_before + 1
    assert detail == {"from_customer_ref": group[41], "to_customer_ref": group[0], "was_rank": was_rank}
    assert "@" not in json.dumps(detail)

    assert seed_demo.seed_receiver_first(conn, config, scores) == "receiver: already first"
    assert audit_rows(conn) == audit_before + 1 and member_matches(conn) == matched


def test_moving_first_is_refused_and_changes_nothing_when_a_member_matches_rank_1(seeded: tuple) -> None:
    conn, config, stand = seeded
    scores = seed_up_to_the_receiver(conn, config)
    group = worth_a_nudge_refs(scores)
    # Rank 1's row now holds the rank 2 stand-in's address, so moving the receiver there would push that stand-in off.
    trade_emails(conn, group[0], group[1])
    before = state(conn)

    with pytest.raises(LookupError, match="would displace them"):
        seed_demo.seed_receiver_first(conn, config, scores)

    assert state(conn) == before


def test_a_database_seeded_under_the_most_at_risk_rule_is_repaired_by_seeding_again(
    seeded: tuple, capsys: pytest.CaptureFixture[str]
) -> None:
    conn, config, stand = seeded
    assert seed_demo.run(config) is True
    scores = score_customers(conn, AS_OF)
    group = worth_a_nudge_refs(scores)
    quiet = [ref for ref in scores.scores if scores.purchase_days[ref] >= REGULAR_MIN_DAYS and scores.days_silent[ref] >= SILENT_MIN_DAYS]
    # The earlier rule's stand-ins: the 40 quiet regulars most at risk, every one of them likely gone.
    gone = sorted(quiet, key=lambda ref: (scores.scores[ref], ref))[:40]
    assert all(forecast_group(scores.scores[ref]) == LIKELY_GONE for ref in gone)
    old = {
        ref: join_member(
            conn, paypal_email=synthetic_email(ref), paypal_payer_id=None, email_verified=True,
            shop_name=DEMO_SHOP_NAME, client_id="cid", actor="seed_demo",
        )
        for ref in gone
    }
    # Its move put the receiver on a likely-gone row, and that row's stand-in on the receiver's row.
    trade_emails(conn, group[0], gone[0])
    approved = campaign_holding(conn, old[gone[1]], "approved")
    sent = campaign_holding(conn, old[gone[2]], "approved", "submitting", "submitted")
    receiver = receiver_member(conn)
    assert receiver not in {c.member_id for c in quiet_regular_members(conn, scores, AS_OF)}
    capsys.readouterr()

    assert seed_demo.run(config) is True

    out = capsys.readouterr().out.splitlines()
    assert "members: 40 demo members (0 new), 40 stand-ins outside the group left" in out
    assert "receiver: moved to rank 1 (was outside the worth-a-nudge group)" in out
    assert conn.execute("select count(*) from members where member_id = any(%s)", (list(old.values()),)).fetchone()[0] == 0
    assert conn.execute("select count(*) from audit_log where action = 'member_left'").fetchone()[0] == 40
    assert conn.execute("select status, void_reason from campaigns where campaign_id = %s", (approved,)).fetchone() == ("voided", LEFT_REASON)
    assert conn.execute("select count(*) from campaign_members where campaign_id = %s", (approved,)).fetchone()[0] == 0
    kept = conn.execute(
        "select c.status, m.ref, m.member_id, m.amount_minor from campaigns c join campaign_members m using (campaign_id) where campaign_id = %s",
        (sent,),
    ).fetchall()
    assert kept == [("submitted", "R1", None, 100)]
    stand_ins = [email for (email,) in conn.execute("select paypal_email from members where source = 'seed' and member_id <> %s", (receiver,))]
    assert sorted(stand_ins) == sorted(synthetic_email(ref) for ref in group[1:41])
    assert conn.execute("select count(*) from members").fetchone()[0] == 41
    assert member_matches(conn)[receiver] == [group[0]]
    ranked = quiet_regular_members(conn, scores, AS_OF)
    assert ranked[0].member_id == receiver and len(ranked) == 41
    [detail] = [row[0] for row in conn.execute("select detail from audit_log where action = 'sandbox_receiver_moved_first'")]
    assert detail == {"from_customer_ref": gone[0], "to_customer_ref": group[0], "was_rank": None}
    # Every shop customer but rank 1 holds its own synthetic address again.
    moved = conn.execute("select customer_ref from shop_customers where email <> lower(customer_ref) || '@shop.example'").fetchall()
    assert moved == [(group[0],)]


def test_the_stand_ins_are_labelled_and_re_consented_and_the_receivers_real_row_is_left_as_it_is(seeded: tuple) -> None:
    conn, config, stand = seeded
    # The live database: the test receiver joined through Log in with PayPal, then the seed
    # ran while members had no source and the wording was the earlier one.
    seed_demo.seed_orders(conn)
    seed_demo.seed_refunds(conn)
    scores = seed_demo.shop_scores(conn)
    real = join_member(
        conn, paypal_email=RECEIVER, paypal_payer_id="PAYERRECEIVE1", email_verified=True, shop_name=DEMO_SHOP_NAME, client_id="cid"
    )
    seed_demo.seed_members(conn, config, scores)
    seed_demo.seed_receiver(conn, config, scores)
    seed_demo.seed_receiver_first(conn, config, scores)
    conn.execute("update members set source = 'paypal_login', consent_version = '2026-10-20.1', consent_text_sha256 = %s", ("0" * 64,))
    receiver_before = conn.execute("select xmin::text, m.* from members m where member_id = %s", (real,)).fetchone()
    audit_before = audit_rows(conn)

    assert seed_demo.seed_members(conn, config, scores) == "members: 40 demo members (0 new), 40 labelled as demo stand-ins"
    seed_demo.seed_receiver(conn, config, scores)

    stand_ins = conn.execute("select member_id, source, consent_version from members where member_id <> %s", (real,)).fetchall()
    assert len(stand_ins) == 40 and all(row[1:] == ("seed", CONSENT_VERSION) for row in stand_ins)
    assert conn.execute("select xmin::text, m.* from members m where member_id = %s", (real,)).fetchone() == receiver_before
    new = conn.execute("select actor, action, detail from audit_log order by id").fetchall()[audit_before:]
    assert new[0] == ("seed_demo", "members_labelled_seed", {"member_ids": sorted(str(row[0]) for row in stand_ins)})
    assert [action for _actor, action, _detail in new[1:]] == ["member_reconsented"] * 40
    assert {actor for actor, _action, _detail in new} == {"seed_demo"} and "@" not in json.dumps([d for *_, d in new])
    assert seed_demo.seed_members(conn, config, scores) == "members: 40 demo members (0 new)" and audit_rows(conn) == audit_before + 41


def test_moving_first_waits_while_the_receivers_real_row_is_on_an_earlier_consent(seeded: tuple) -> None:
    conn, config, stand = seeded
    seed_demo.seed_orders(conn)
    seed_demo.seed_refunds(conn)
    scores = seed_demo.shop_scores(conn)
    join_member(
        conn, paypal_email=RECEIVER, paypal_payer_id="PAYERRECEIVE1", email_verified=True, shop_name=DEMO_SHOP_NAME, client_id="cid"
    )
    seed_demo.seed_members(conn, config, scores)
    seed_demo.seed_receiver(conn, config, scores)
    changed = conn.execute("update members set consent_version = '2026-10-20.1' where source = 'paypal_login'").rowcount
    assert changed == 1
    before = state(conn)
    assert seed_demo.seed_receiver_first(conn, config, scores) == "receiver: waiting for the test customer to join again under the current consent"
    assert state(conn) == before


def test_moving_first_says_the_receiver_is_held_while_a_running_measurement_holds_it(seeded: tuple) -> None:
    conn, config, stand = seeded
    scores = seed_up_to_the_receiver(conn, config)
    running = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 1000, 100, 0.5, 'draft') returning campaign_id"
    ).fetchone()[0]
    conn.execute(
        "insert into campaign_members (campaign_id, ref, member_id, role, rank, score) values (%s, 'R1', %s, 'holdout', 1, 0.1)",
        (running, receiver_member(conn)),
    )
    # A measurement starts at approval; a draft holds nobody.
    conn.execute("update campaigns set status = 'approved' where campaign_id = %s", (running,))
    before = state(conn)

    assert seed_demo.seed_receiver_first(conn, config, scores) == "receiver: held by a running measurement"
    assert state(conn) == before


def test_moving_first_is_refused_and_changes_nothing_while_the_receiver_cannot_be_first(seeded: tuple) -> None:
    conn, config, stand = seeded
    seed_demo.seed_orders(conn)
    seed_demo.seed_refunds(conn)
    scores = seed_demo.shop_scores(conn)
    before = state(conn)
    all_gone = replace(scores, scores={ref: 0.01 for ref in scores.scores})
    with pytest.raises(LookupError, match="no customer is worth a nudge"):
        seed_demo.seed_receiver_first(conn, config, all_gone)
    with pytest.raises(LookupError, match="linked to no shop customer"):
        seed_demo.seed_receiver_first(conn, config, scores)
    assert state(conn) == before

    seed_demo.seed_members(conn, config, scores)
    seed_demo.seed_receiver(conn, config, scores)
    # A stand-in on an earlier wording is not eligible, and no person can agree again for it.
    conn.execute("update members set consent_version = '2026-10-20.1' where paypal_email = %s", (normalise_email(RECEIVER),))
    before = state(conn)
    with pytest.raises(LookupError, match="not an eligible member"):
        seed_demo.seed_receiver_first(conn, config, scores)
    assert state(conn) == before


def test_a_database_without_the_schema_is_refused_and_left_without_it(schema_url: tuple[str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    url, schema = schema_url
    config = config_for(url, schema)
    with pytest.raises(ConfigError):
        seed_demo.run(config)
    monkeypatch.setattr(seed_demo, "load_config", lambda _path: config)
    assert seed_demo.main() == 2
    with psycopg.connect(url) as conn:
        assert conn.execute("select count(*) from pg_tables where schemaname = %s", (schema,)).fetchone()[0] == 0


def test_without_a_test_receiver_nothing_is_written(seeded: tuple) -> None:
    conn, config, stand = seeded
    with pytest.raises(seed_demo.SeedRefused):
        seed_demo.run(replace(config, test_receiver=None))
    assert stand.calls == [] and conn.execute("select count(*) from shop_customers").fetchone()[0] == 0
