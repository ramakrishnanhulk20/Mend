# Not covered here: process_events and reconcile against real PayPal answers (test_events.py,
# test_reconcile.py and prove_m5 cover them), and the cron schedule on Render: the live
# proof (node scripts/deploy/render.mjs prove) checks that mend-jobs has run.
import json
import uuid
from collections.abc import Iterator
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

import pgserver
import psycopg
import pytest
from psycopg import sql

from mend_engine import jobs, tasks
from mend_engine.config import SANDBOX_API_HOST, Config
from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema


def printed(capsys: pytest.CaptureFixture[str]) -> list[dict]:
    return [json.loads(line) for line in capsys.readouterr().out.splitlines()]


@pytest.fixture
def ran(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Replaces the three jobs with stand-ins that record their name and answer ok with a count."""
    order: list[str] = []
    for name in jobs.JOBS:
        monkeypatch.setitem(jobs.JOBS, name, lambda name=name: order.append(name) or {"ok": True, "count": len(order)})
    return order


def test_all_runs_the_three_jobs_once_in_order_and_prints_their_counts(ran: list[str], capsys: pytest.CaptureFixture[str]) -> None:
    assert jobs.main(["all"]) == 0
    assert ran == ["process_events", "reconcile", "purge"]
    assert printed(capsys) == [
        {"job": "process_events", "ok": True, "count": 1},
        {"job": "reconcile", "ok": True, "count": 2},
        {"job": "purge", "ok": True, "count": 3},
    ]


def test_a_failing_job_does_not_stop_the_purge_and_the_run_exits_1(
    ran: list[str], monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    ref = str(uuid.uuid4())
    monkeypatch.setitem(jobs.JOBS, "process_events", lambda: ran.append("process_events") or {"ok": False, "error": "paypal_unavailable", "ref": ref})
    assert jobs.main(["all"]) == 1
    assert ran == ["process_events", "reconcile", "purge"]
    assert printed(capsys)[0] == {"job": "process_events", "ok": False, "error": "paypal_unavailable", "ref": ref}


def test_named_jobs_run_alone_in_the_order_given(ran: list[str]) -> None:
    assert jobs.main(["purge", "process_events"]) == 0
    assert ran == ["purge", "process_events"]


@pytest.mark.parametrize("argv", [[], ["all", "purge"], ["drop_tables"]])
def test_anything_but_all_or_job_names_is_refused_before_a_job_runs(ran: list[str], argv: list[str]) -> None:
    with pytest.raises(SystemExit) as stopped:
        jobs.main(argv)
    assert stopped.value.code == 2 and ran == []


@pytest.fixture
def database(monkeypatch: pytest.MonkeyPatch) -> Iterator[psycopg.Connection]:
    """A throwaway schema on the local pgserver, with every task pointed at it."""
    url = pgserver.get_server(PGDATA).get_uri()
    name = "jobs_" + uuid.uuid4().hex[:12]
    with psycopg.connect(url, autocommit=True) as admin:
        admin.execute(sql.SQL("create schema {}").format(sql.Identifier(name)))
        try:
            with psycopg.connect(url, autocommit=True) as conn:
                conn.execute(sql.SQL("set search_path to {}").format(sql.Identifier(name)))
                apply_schema(conn)
                parts = urlsplit(url)
                query = urlencode([*parse_qsl(parts.query), ("options", f"-c search_path={name}")], quote_via=quote)
                config = Config(
                    paypal_client_id="cid", paypal_client_secret="csecret-for-job-tests", paypal_api_host=SANDBOX_API_HOST,
                    database_url=urlunsplit(parts._replace(query=query)), dev=False, test_receiver=None,
                    item_cap_minor=1000, campaign_cap_minor=10000, daily_cap_minor=20000,
                )
                monkeypatch.setattr(tasks, "_load_config", lambda: config)
                yield conn
        finally:
            admin.execute(sql.SQL("drop schema {} cascade").format(sql.Identifier(name)))


def test_the_purge_job_deletes_payloads_older_than_48_hours_and_keeps_the_rest(
    database: psycopg.Connection, capsys: pytest.CaptureFixture[str]
) -> None:
    for transmission, hours in (("old", 49), ("recent", 47)):
        database.execute(
            "insert into paypal_events (transmission_id, event_id, event_type, received_at, purge_after, raw) "
            "values (%s, %s, 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', now() - make_interval(hours => %s), "
            "now() - make_interval(hours => %s) + interval '48 hours', '{}')",
            (transmission, "WH-" + transmission, hours, hours),
        )
    assert jobs.main(["purge"]) == 0
    assert printed(capsys) == [{"job": "purge", "ok": True, "deleted": 1}]
    assert [row[0] for row in database.execute("select transmission_id from paypal_events")] == ["recent"]
