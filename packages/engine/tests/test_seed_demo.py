# Not covered here: the real UCI import and the real model facts. prove_m2, prove_m4b and
# python -m mend_engine.store_facts run those on the real file; here a small synthetic shop
# and stand-in facts of the stored shape take their place. No PayPal API is involved.
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

from mend_engine import prove_m4a, seed_demo, store_facts
from mend_engine.campaigns.scoring import score_customers
from mend_engine.config import SANDBOX_API_HOST, Config, ConfigError
from mend_engine.data.uci import ZIP_NAME
from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema
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


def test_a_fresh_database_gets_the_shop_the_facts_the_40_demo_members_and_the_test_receiver(
    seeded: tuple, capsys: pytest.CaptureFixture[str]
) -> None:
    conn, config, stand = seeded
    assert seed_demo.run(config) is True
    assert stand.calls == ["orders", "refunds", "cdnow", "uci"]
    assert all(store_facts.read_facts(conn).values())

    scores = score_customers(conn, AS_OF)
    demo = prove_m4a.demo_customers(scores)
    assert len(demo) == 40
    members = dict(conn.execute("select paypal_email, email_verified from members"))
    assert len(members) == 41 and all(members.values())
    demo_emails = {email for (email,) in conn.execute("select email from shop_customers where customer_ref = any(%s)", (demo,))}
    receiver = RECEIVER.lower()
    assert set(members) == demo_emails | {receiver}
    linked = conn.execute("select customer_ref from shop_customers where email = %s", (receiver,)).fetchall()
    assert len(linked) == 1 and linked[0][0] not in demo
    assert conn.execute("select actor from audit_log where action = 'shop_customer_linked_to_sandbox_receiver'").fetchall() == [("seed_demo",)]
    assert receiver not in capsys.readouterr().out.lower()


def test_a_second_run_changes_nothing(seeded: tuple, capsys: pytest.CaptureFixture[str]) -> None:
    conn, config, stand = seeded
    assert seed_demo.run(config) is True
    before = state(conn)
    capsys.readouterr()
    assert seed_demo.run(config) is True
    assert state(conn) == before
    assert stand.calls == ["orders", "refunds", "cdnow", "uci"]
    out = capsys.readouterr().out
    for line in ("orders: already imported", "refunds: already imported", "facts: already stored", "members: 40 demo members (0 new)"):
        assert line in out


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
