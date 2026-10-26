# Not covered here: process_events and reconcile against real PayPal answers (test_events.py,
# test_reconcile.py and prove_m5 cover them), the cancel job against PayPal's real cancel
# answer (the M7e-1 live probe covers the call), an item a webhook turns UNCLAIMED between
# the job's count and its cancel, and the cron schedule on Render: the live proof
# (node scripts/deploy/render.mjs prove) checks that mend-jobs has run.
import json
import uuid
from collections.abc import Iterator
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

import httpx
import pgserver
import psycopg
import pytest
from psycopg import sql

from mend_engine import jobs, tasks
from mend_engine.config import SANDBOX_API_HOST, Config
from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema
from mend_engine.paypal.http import PayPalHttp
from mend_engine.paypal.payouts import BatchSnapshot, PayoutItemSpec, canonical_json, sender_batch_id_for, snapshot_hash

JOB_ORDER = ["purge", "process_events", "reconcile", "cancel_demo_unclaimed"]


def printed(capsys: pytest.CaptureFixture[str]) -> list[dict]:
    return [json.loads(line) for line in capsys.readouterr().out.splitlines()]


@pytest.fixture
def ran(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Replaces every job with a stand-in that records its name and answers ok with a count."""
    order: list[str] = []
    for name in jobs.JOBS:
        monkeypatch.setitem(jobs.JOBS, name, lambda name=name: order.append(name) or {"ok": True, "count": len(order)})
    return order


def test_all_runs_every_job_once_purge_first_and_prints_their_counts(ran: list[str], capsys: pytest.CaptureFixture[str]) -> None:
    assert jobs.main(["all"]) == 0
    assert ran == JOB_ORDER
    assert printed(capsys) == [{"job": name, "ok": True, "count": n} for n, name in enumerate(JOB_ORDER, start=1)]


def test_a_failing_job_does_not_stop_the_jobs_after_it_and_the_run_exits_1(
    ran: list[str], monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    ref = str(uuid.uuid4())
    monkeypatch.setitem(jobs.JOBS, "process_events", lambda: ran.append("process_events") or {"ok": False, "error": "paypal_unavailable", "ref": ref})
    assert jobs.main(["all"]) == 1
    assert ran == JOB_ORDER
    assert printed(capsys)[1] == {"job": "process_events", "ok": False, "error": "paypal_unavailable", "ref": ref}


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


class CancelPayPal:
    """Answers each item cancel RETURNED, or with the HTTP status failing holds for that item, and records the item ids asked about."""

    def __init__(self) -> None:
        self.asked: list[str] = []
        self.failing: dict[str, int] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 32000})
        assert request.method == "POST" and request.url.path.endswith("/cancel"), "the cancel job only ever cancels"
        item_id = request.url.path.split("/")[-2]
        self.asked.append(item_id)
        if item_id in self.failing:
            return httpx.Response(self.failing[item_id], json={"name": "INTERNAL_SERVER_ERROR"})
        return httpx.Response(200, json={"payout_item_id": item_id, "transaction_status": "RETURNED"})


@pytest.fixture
def paypal(database: psycopg.Connection, monkeypatch: pytest.MonkeyPatch) -> CancelPayPal:
    fake = CancelPayPal()
    monkeypatch.setattr(tasks, "_paypal", lambda cfg: PayPalHttp(cfg, transport=httpx.MockTransport(fake)))
    return fake


def sent_campaign(conn: psycopg.Connection, role: str, minutes_ago: int, waiting: int) -> tuple[uuid.UUID, list[str]]:
    """A campaign a session of role created, its batch written minutes_ago, with waiting 100-cent items PayPal holds as UNCLAIMED.

    Returns the campaign id and its item ids, in the order a cancel run asks about them.
    """
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 1000, 100, 0.5, 'submitted') returning campaign_id"
    ).fetchone()[0]
    items = tuple(PayoutItemSpec(f"m{n}@shop.example", 100, "Thanks", f"R{n}") for n in range(1, waiting + 1))
    snap = BatchSnapshot(str(campaign_id), "USD", "A thank-you", items)
    conn.execute("insert into approved_snapshots values (%s, %s, %s, now(), 'owner')", (campaign_id, snapshot_hash(snap), canonical_json(snap)))
    conn.execute(
        "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, status, created_at) "
        "values (%s, %s, %s, 'created', now() - make_interval(mins => %s))",
        (sender_batch_id_for(snap), str(campaign_id), snapshot_hash(snap), minutes_ago),
    )
    conn.execute("insert into campaign_owners values (%s, %s, %s)", (campaign_id, role, "e" * 64))
    ids = [f"{campaign_id.hex[:12].upper()}N{n}" for n in range(1, waiting + 1)]
    for n, item_id in enumerate(ids, start=1):
        conn.execute(
            "insert into payout_items (payout_item_id, sender_batch_id, sender_item_id, status) values (%s, %s, %s, 'UNCLAIMED')",
            (item_id, sender_batch_id_for(snap), f"R{n}"),
        )
    return campaign_id, ids


def statuses(conn: psycopg.Connection, ids: list[str]) -> set[str]:
    return {row[0] for row in conn.execute("select status from payout_items where payout_item_id = any(%s)", (ids,))}


def answer(**counts: object) -> dict:
    """The cancel job's printed line: every count 0 unless given."""
    zero = {"campaigns": 0, "cancelled": 0, "returned_minor": 0, "not_cancellable": 0, "failed": 0}
    return {"job": "cancel_demo_unclaimed", "ok": True, "ran": True, **zero, **counts}


def test_the_cancel_job_returns_demo_items_unclaimed_for_10_minutes_and_frees_the_demo_pool(
    database: psycopg.Connection, paypal: CancelPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    _, old = sent_campaign(database, "demo", 11, 4)
    _, young = sent_campaign(database, "demo", 9, 4)
    _, owners = sent_campaign(database, "owner", 60, 4)
    assert tasks.demo_spent_last_24h_minor(database) == 800

    assert jobs.main(["cancel_demo_unclaimed"]) == 0

    assert printed(capsys) == [answer(campaigns=1, cancelled=4, returned_minor=400)]
    assert paypal.asked == old
    assert (statuses(database, old), statuses(database, young), statuses(database, owners)) == ({"RETURNED"}, {"UNCLAIMED"}, {"UNCLAIMED"})
    assert tasks.demo_spent_last_24h_minor(database) == 400


def test_the_cancel_job_asks_about_at_most_50_items_a_run_oldest_batches_first(
    database: psycopg.Connection, paypal: CancelPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    # 3 + 9 x 5 = 48 items; the tenth campaign of 5 would take the run to 53.
    oldest = sent_campaign(database, "demo", 120, 3)[1]
    rest = [sent_campaign(database, "demo", 100 - n, 5)[1] for n in range(10)]

    assert jobs.main(["cancel_demo_unclaimed"]) == 0
    assert paypal.asked == oldest + [item for ids in rest[:9] for item in ids]
    assert statuses(database, rest[9]) == {"UNCLAIMED"}

    assert jobs.main(["cancel_demo_unclaimed"]) == 0
    assert paypal.asked[48:] == rest[9]
    assert printed(capsys) == [answer(campaigns=10, cancelled=48, returned_minor=4800), answer(campaigns=1, cancelled=5, returned_minor=500)]


def test_a_paypal_error_on_one_campaign_is_logged_and_the_cancel_job_goes_on_to_the_next(
    database: psycopg.Connection, paypal: CancelPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    broken_id, broken = sent_campaign(database, "demo", 30, 2)
    _, fine = sent_campaign(database, "demo", 20, 2)
    paypal.failing[broken[0]] = 500

    assert jobs.main(["cancel_demo_unclaimed"]) == 0

    out, err = capsys.readouterr()
    assert [json.loads(line) for line in out.splitlines()] == [answer(campaigns=2, cancelled=2, returned_minor=200, failed=1)]
    assert paypal.asked == [broken[0], *fine]
    assert (statuses(database, broken), statuses(database, fine)) == ({"UNCLAIMED"}, {"RETURNED"})
    logged = [json.loads(line) for line in err.splitlines() if line.startswith("{")]
    assert [(entry["error"], entry["campaign_id"]) for entry in logged if entry.get("outcome") == "failed"] == [
        ("paypal_unavailable", str(broken_id))
    ]


def test_any_error_on_one_campaign_is_logged_scrubbed_and_the_cancel_job_goes_on_to_the_next(
    database: psycopg.Connection, paypal: CancelPayPal, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    broken_id, _ = sent_campaign(database, "demo", 30, 2)
    _, fine = sent_campaign(database, "demo", 20, 2)
    real_cancel = jobs.cancel_unclaimed

    def cancel(conn: psycopg.Connection, http: PayPalHttp, campaign_id: uuid.UUID) -> object:
        if campaign_id == broken_id:
            raise RuntimeError("ledger read failed for m1@shop.example using csecret-for-job-tests")
        return real_cancel(conn, http, campaign_id)

    monkeypatch.setattr(jobs, "cancel_unclaimed", cancel)

    assert jobs.main(["cancel_demo_unclaimed"]) == 0

    out, err = capsys.readouterr()
    assert [json.loads(line) for line in out.splitlines()] == [answer(campaigns=2, cancelled=2, returned_minor=200, failed=1)]
    assert paypal.asked == fine
    logged = [json.loads(line) for line in err.splitlines() if line.startswith("{")]
    [entry] = [entry for entry in logged if entry.get("outcome") == "failed"]
    assert (entry["error"], entry["exception"], entry["campaign_id"]) == ("internal", "RuntimeError", str(broken_id))
    assert "ledger read failed" in entry["detail"] and "csecret-for-job-tests" not in err and "m1@shop.example" not in err


def test_the_cancel_job_does_nothing_while_another_run_holds_its_lock(
    database: psycopg.Connection, paypal: CancelPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    _, waiting = sent_campaign(database, "demo", 30, 2)
    database.execute("select pg_advisory_lock(%s)", (jobs.DEMO_CANCEL_LOCK,))
    try:
        assert jobs.main(["cancel_demo_unclaimed"]) == 0
    finally:
        database.execute("select pg_advisory_unlock(%s)", (jobs.DEMO_CANCEL_LOCK,))
    assert printed(capsys) == [answer(ran=False)]
    assert paypal.asked == [] and statuses(database, waiting) == {"UNCLAIMED"}
