# Not covered here: process_events and reconcile against real PayPal answers (test_events.py,
# test_reconcile.py and prove_m5 cover them), the cancel job and the refresh job against
# PayPal's real cancel, item, batch and order answers (the M7e-1 live probe covers the
# cancel call; the batch and order shapes follow PayPal's published samples, which
# test_events.py and prove_m5 read live through the same get_batch and read_order), a
# failure row older than an hour (the audit log cannot be backdated), and the cron
# schedule on Render: the live proof (node scripts/deploy/render.mjs prove) checks that
# mend-jobs has run.
import json
import uuid
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

import httpx
import pgserver
import psycopg
import pytest
from psycopg import sql
from psycopg.types.json import Jsonb

from mend_engine import jobs, tasks
from mend_engine.config import SANDBOX_API_HOST, Config
from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema
from mend_engine.paypal.http import PayPalHttp
from mend_engine.campaigns.simulate import ORDERS_PATH
from mend_engine.paypal.payouts import (
    PAYOUT_ITEM_PATH,
    PAYOUTS_PATH,
    BatchSnapshot,
    PayoutItemSpec,
    canonical_json,
    sender_batch_id_for,
    snapshot_hash,
)

JOB_ORDER = ["purge", "process_events", "reconcile", "refresh_items", "cancel_demo_unclaimed"]


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


class JobsPayPal:
    """Answers the jobs' PayPal calls from the ledger and records the item ids each call names.

    A cancel is answered RETURNED, or with the HTTP status failing holds for that item.
    A read of one item names the item's batch and sender_item_id as the ledger holds
    them, and the status reads holds for it: the ledger's own status when it holds
    none, an HTTP error when it holds a number. An item in elsewhere is placed in
    another batch. A read of a batch or an order is answered from batches or orders
    by its id: PayPal's answer, or an HTTP error when it is a number.
    """

    def __init__(self, conn: psycopg.Connection) -> None:
        self.conn = conn
        self.asked: list[str] = []
        self.read: list[str] = []
        self.failing: dict[str, int] = {}
        self.reads: dict[str, str | int] = {}
        self.elsewhere: set[str] = set()
        self.batches: dict[str, dict | int] = {}
        self.batch_reads: list[str] = []
        self.orders: dict[str, dict | int] = {}
        self.order_reads: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 32000})
        if request.method == "POST" and path.endswith("/cancel"):
            item_id = path.split("/")[-2]
            self.asked.append(item_id)
            if item_id in self.failing:
                return httpx.Response(self.failing[item_id], json={"name": "ITEM_INCORRECT_STATUS"})
            return httpx.Response(200, json={"payout_item_id": item_id, "transaction_status": "RETURNED"})
        for prefix, answers, seen in ((PAYOUTS_PATH, self.batches, self.batch_reads), (ORDERS_PATH, self.orders, self.order_reads)):
            if request.method == "GET" and path.startswith(prefix + "/"):
                seen.append(path.split("/")[-1])
                found = answers[seen[-1]]
                if isinstance(found, int):
                    return httpx.Response(found, json={"name": "INTERNAL_SERVER_ERROR"})
                return httpx.Response(200, json=found)
        assert request.method == "GET" and path.startswith(PAYOUT_ITEM_PATH + "/"), "the jobs only cancel and read items, batches and orders"
        item_id = path.split("/")[-1]
        self.read.append(item_id)
        status = self.reads.get(item_id)
        if isinstance(status, int):
            return httpx.Response(status, json={"name": "RESOURCE_NOT_FOUND"})
        sender_batch_id, payout_batch_id, sender_item_id, stored = self.conn.execute(
            "select i.sender_batch_id, b.payout_batch_id, i.sender_item_id, i.status from payout_items i "
            "join payout_batches b on b.sender_batch_id = i.sender_batch_id where i.payout_item_id = %s",
            (item_id,),
        ).fetchone()
        return httpx.Response(
            200,
            json={
                "payout_item_id": item_id,
                "payout_batch_id": payout_batch_id,
                "sender_batch_id": "mend-elsewhere" if item_id in self.elsewhere else sender_batch_id,
                "transaction_status": status or stored,
                "payout_item_fee": {"currency": "USD", "value": "0.25"},
                "payout_item": {"sender_item_id": sender_item_id, "receiver": "m1@shop.example"},
            },
        )


@pytest.fixture
def paypal(database: psycopg.Connection, monkeypatch: pytest.MonkeyPatch) -> JobsPayPal:
    fake = JobsPayPal(database)
    monkeypatch.setattr(tasks, "_paypal", lambda cfg: PayPalHttp(cfg, transport=httpx.MockTransport(fake)))
    return fake


def sent_campaign(conn: psycopg.Connection, role: str, minutes_ago: int, waiting: int) -> tuple[uuid.UUID, list[str]]:
    """A campaign a session of role created, its batch written minutes_ago, with waiting 100-cent items PayPal holds as UNCLAIMED.

    Returns the campaign id and its item ids, N1 first.
    """
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 1000, 100, 0.5, 'submitted') returning campaign_id"
    ).fetchone()[0]
    items = tuple(PayoutItemSpec(f"m{n}@shop.example", 100, "Thanks", f"R{n}") for n in range(1, waiting + 1))
    snap = BatchSnapshot(str(campaign_id), "USD", "A thank-you", items)
    conn.execute("insert into approved_snapshots values (%s, %s, %s, now(), 'owner')", (campaign_id, snapshot_hash(snap), canonical_json(snap)))
    conn.execute(
        "insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, payout_batch_id, status, created_at) "
        "values (%s, %s, %s, %s, 'created', now() - make_interval(mins => %s))",
        (sender_batch_id_for(snap), str(campaign_id), snapshot_hash(snap), "B" + campaign_id.hex[:12].upper(), minutes_ago),
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


def failure_rows(conn: psycopg.Connection) -> int:
    return conn.execute("select count(*) from audit_log where action = 'payout_item_cancel_failed'").fetchone()[0]


def test_the_cancel_job_returns_demo_items_unclaimed_for_10_minutes_and_frees_the_demo_pool(
    database: psycopg.Connection, paypal: JobsPayPal, capsys: pytest.CaptureFixture[str]
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
    database: psycopg.Connection, paypal: JobsPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    # 3 + 9 x 5 = 48 items, so 2 of the tenth campaign's 5 fit in the run and 3 wait for the next.
    oldest = sent_campaign(database, "demo", 120, 3)[1]
    rest = [sent_campaign(database, "demo", 100 - n, 5)[1] for n in range(10)]

    assert jobs.main(["cancel_demo_unclaimed"]) == 0
    assert paypal.asked == oldest + [item for ids in rest[:9] for item in ids] + rest[9][:2]
    assert statuses(database, rest[9][2:]) == {"UNCLAIMED"}

    assert jobs.main(["cancel_demo_unclaimed"]) == 0
    assert paypal.asked[50:] == rest[9][2:]
    assert printed(capsys) == [answer(campaigns=11, cancelled=50, returned_minor=5000), answer(campaigns=1, cancelled=3, returned_minor=300)]


def test_items_paypal_will_not_cancel_rest_for_an_hour_and_never_block_a_newer_one(
    database: psycopg.Connection, paypal: JobsPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    # The reviewer's repro: 48 rewards PayPal refuses to cancel and still reports UNCLAIMED fill
    # all but 2 places of every run, ahead of a newer campaign of 5.
    stuck = [item for n in range(3) for item in sent_campaign(database, "demo", 60 - 10 * n, 16)[1]]
    _, newer = sent_campaign(database, "demo", 20, 5)
    paypal.failing.update({item_id: 422 for item_id in stuck})

    for _ in range(3):
        assert jobs.main(["cancel_demo_unclaimed"]) == 0

    assert printed(capsys) == [
        answer(campaigns=4, cancelled=2, returned_minor=200, not_cancellable=48),
        answer(campaigns=1, cancelled=3, returned_minor=300),
        answer(),
    ]
    assert statuses(database, newer) == {"RETURNED"} and statuses(database, stuck) == {"UNCLAIMED"}
    assert failure_rows(database) == 48
    # Each refused cancel was followed by one read of the item, and nothing was asked twice.
    assert sorted(paypal.read) == sorted(stuck) and sorted(paypal.asked) == sorted(stuck + newer)


def test_an_item_paypal_cannot_answer_for_is_logged_holds_up_nothing_and_is_not_asked_again_within_the_hour(
    database: psycopg.Connection, paypal: JobsPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    # The reviewer's repro: N1 answers 500 to every cancel, as UML2RFT82W3HL does live.
    broken_id, broken = sent_campaign(database, "demo", 30, 2)
    _, fine = sent_campaign(database, "demo", 20, 2)
    paypal.failing[broken[0]] = 500

    assert jobs.main(["cancel_demo_unclaimed"]) == 0
    assert jobs.main(["cancel_demo_unclaimed"]) == 0

    out, err = capsys.readouterr()
    assert [json.loads(line) for line in out.splitlines()] == [answer(campaigns=2, cancelled=3, returned_minor=300, failed=1), answer()]
    assert paypal.asked == [*broken, *fine]
    assert (statuses(database, broken[:1]), statuses(database, broken[1:] + fine)) == ({"UNCLAIMED"}, {"RETURNED"})
    logged = [json.loads(line) for line in err.splitlines() if line.startswith("{")]
    assert [(entry["error"], entry["campaign_id"]) for entry in logged if entry.get("outcome") == "failed"] == [
        ("paypal_unavailable", str(broken_id))
    ]


def test_an_item_paypal_will_not_cancel_rests_alone_and_the_rest_of_its_campaign_is_asked_the_next_run(
    database: psycopg.Connection, paypal: JobsPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    _, ids = sent_campaign(database, "demo", 30, 55)
    in_order = sorted(ids)
    paypal.failing[in_order[0]] = 422

    assert jobs.main(["cancel_demo_unclaimed"]) == 0
    assert jobs.main(["cancel_demo_unclaimed"]) == 0

    assert paypal.asked == in_order
    assert printed(capsys) == [answer(campaigns=1, cancelled=49, returned_minor=4900, not_cancellable=1), answer(campaigns=1, cancelled=5, returned_minor=500)]


def test_any_error_on_one_campaign_is_logged_scrubbed_and_the_cancel_job_goes_on_to_the_next(
    database: psycopg.Connection, paypal: JobsPayPal, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    broken_id, _ = sent_campaign(database, "demo", 30, 2)
    _, fine = sent_campaign(database, "demo", 20, 2)
    real_cancel = jobs.cancel_unclaimed

    def cancel(conn: psycopg.Connection, http: PayPalHttp, campaign_id: uuid.UUID, *, limit: int) -> object:
        if campaign_id == broken_id:
            raise RuntimeError("ledger read failed for m1@shop.example using csecret-for-job-tests")
        return real_cancel(conn, http, campaign_id, limit=limit)

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
    database: psycopg.Connection, paypal: JobsPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    _, waiting = sent_campaign(database, "demo", 30, 2)
    database.execute("select pg_advisory_lock(%s)", (jobs.DEMO_CANCEL_LOCK,))
    try:
        assert jobs.main(["cancel_demo_unclaimed"]) == 0
    finally:
        database.execute("select pg_advisory_unlock(%s)", (jobs.DEMO_CANCEL_LOCK,))
    assert printed(capsys) == [answer(ran=False)]
    assert paypal.asked == [] and statuses(database, waiting) == {"UNCLAIMED"}


def left_alone(conn: psycopg.Connection, ids: list[str], minutes: int) -> None:
    """The ledger last heard about these items minutes ago."""
    conn.execute(
        "update payout_items set updated_at = now() - make_interval(mins => %s) where payout_item_id = any(%s)", (minutes, ids)
    )


def set_status(conn: psycopg.Connection, item_id: str, status: str) -> None:
    conn.execute("update payout_items set status = %s where payout_item_id = %s", (status, item_id))


def refreshed(**counts: object) -> dict:
    """The refresh job's printed line: every count 0 unless given."""
    zero = {
        "items": 0, "moved": 0, "unchanged": 0, "refused": 0, "failed": 0,
        "batches": 0, "restored": 0, "skipped": 0, "orders": 0, "purchases": 0,
    }
    return {"job": "refresh_items", "ok": True, "ran": True, **zero, **counts}


def test_the_refresh_job_rereads_unsettled_items_left_alone_15_minutes_and_records_paypals_answer(
    database: psycopg.Connection, paypal: JobsPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    _, ids = sent_campaign(database, "owner", 60, 8)
    stored = ["PENDING", "ONHOLD", "UNCLAIMED", "PROCESSING_LATER", "SUCCESS", "FAILED", "RETURNED", "PENDING"]
    for item_id, status in zip(ids, stored):
        set_status(database, item_id, status)
    left_alone(database, ids[:7], 20)
    left_alone(database, ids[7:], 14)
    # The fourth is unknown to the state machine, so it counts as PENDING and is read too.
    paypal.reads.update({ids[0]: "SUCCESS", ids[1]: "UNCLAIMED", ids[3]: "FAILED"})

    assert jobs.main(["refresh_items"]) == 0
    assert jobs.main(["refresh_items"]) == 0

    assert printed(capsys) == [refreshed(items=4, moved=3, unchanged=1), refreshed()]
    assert paypal.read == ids[:4] and paypal.asked == []
    assert [database.execute("select status from payout_items where payout_item_id = %s", (i,)).fetchone()[0] for i in ids] == [
        "SUCCESS", "UNCLAIMED", "UNCLAIMED", "FAILED", "SUCCESS", "FAILED", "RETURNED", "PENDING",
    ]
    assert database.execute("select array_agg(distinct fee_minor) from payout_items where payout_item_id = any(%s)", (ids[:4],)).fetchone() == ([25],)
    assert database.execute("select actor, detail from audit_log order by id").fetchall() == [
        ("refresh", {"payout_item_id": ids[0], "from": "PENDING", "to": "SUCCESS"}),
        ("refresh", {"payout_item_id": ids[1], "from": "ONHOLD", "to": "UNCLAIMED"}),
        ("refresh", {"payout_item_id": ids[3], "from": "PROCESSING_LATER", "to": "FAILED"}),
    ]


def test_a_reversed_item_is_settled_and_never_read_again(
    database: psycopg.Connection, paypal: JobsPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    _, ids = sent_campaign(database, "owner", 60, 2)
    set_status(database, ids[0], "REVERSED")
    set_status(database, ids[1], "PENDING")
    left_alone(database, ids, 20)

    assert jobs.main(["refresh_items"]) == 0

    assert paypal.read == ids[1:] and printed(capsys) == [refreshed(items=1, unchanged=1)]


def test_the_refresh_job_reads_at_most_50_items_a_run_least_recently_heard_of_first(
    database: psycopg.Connection, paypal: JobsPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    _, ids = sent_campaign(database, "owner", 120, 55)
    for minutes, item_id in enumerate(ids):
        left_alone(database, [item_id], 100 - minutes)

    assert jobs.main(["refresh_items"]) == 0
    assert paypal.read == ids[:50]
    assert jobs.main(["refresh_items"]) == 0
    assert paypal.read[50:] == ids[50:]
    assert printed(capsys) == [refreshed(items=50, unchanged=50), refreshed(items=5, unchanged=5)]


def test_items_paypal_cannot_answer_for_or_that_the_state_machine_refuses_go_to_the_back_and_block_nothing(
    database: psycopg.Connection, paypal: JobsPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    _, stuck = sent_campaign(database, "owner", 120, 50)
    _, waiting = sent_campaign(database, "owner", 60, 1)
    left_alone(database, stuck, 60)
    left_alone(database, waiting, 20)
    # PayPal cannot find half the stuck items and reports the rest PENDING, a move back from UNCLAIMED.
    paypal.reads.update({item_id: 404 for item_id in stuck[:25]})
    paypal.reads.update({item_id: "PENDING" for item_id in stuck[25:]})

    assert jobs.main(["refresh_items"]) == 0
    assert jobs.main(["refresh_items"]) == 0

    assert sorted(paypal.read[:50]) == sorted(stuck) and paypal.read[50:] == waiting
    assert printed(capsys) == [refreshed(items=50, refused=25, failed=25), refreshed(items=1, unchanged=1)]
    assert statuses(database, stuck) == {"UNCLAIMED"}


def test_an_error_on_one_item_is_logged_scrubbed_and_the_refresh_job_goes_on(
    database: psycopg.Connection, paypal: JobsPayPal, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _, ids = sent_campaign(database, "owner", 60, 4)
    for minutes, item_id in enumerate(ids):
        left_alone(database, [item_id], 40 - minutes)
    paypal.reads.update({ids[0]: 500, ids[3]: "SUCCESS"})
    paypal.elsewhere.add(ids[1])
    real_read_back = jobs.read_back

    def read_back(conn: psycopg.Connection, http: PayPalHttp, payout_item_id: str) -> object:
        if payout_item_id == ids[2]:
            raise RuntimeError("ledger read failed for m1@shop.example using csecret-for-job-tests")
        return real_read_back(conn, http, payout_item_id)

    monkeypatch.setattr(jobs, "read_back", read_back)

    assert jobs.main(["refresh_items"]) == 0

    out, err = capsys.readouterr()
    assert [json.loads(line) for line in out.splitlines()] == [refreshed(items=4, moved=1, failed=3)]
    assert statuses(database, ids[:3]) == {"UNCLAIMED"} and statuses(database, ids[3:]) == {"SUCCESS"}
    logged = [json.loads(line) for line in err.splitlines() if line.startswith("{")]
    failed = [entry for entry in logged if entry.get("outcome") == "failed"]
    assert [(entry["error"], entry["payout_item_id"]) for entry in failed] == [
        ("paypal_unavailable", ids[0]), ("not_ours", ids[1]), ("internal", ids[2]),
    ]
    assert "ledger read failed" in failed[2]["detail"] and "csecret-for-job-tests" not in err and "m1@shop.example" not in err


def test_the_refresh_job_does_nothing_while_another_run_holds_its_lock(
    database: psycopg.Connection, paypal: JobsPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    _, ids = sent_campaign(database, "owner", 60, 2)
    left_alone(database, ids, 20)
    database.execute("select pg_advisory_lock(%s)", (jobs.REFRESH_LOCK,))
    try:
        assert jobs.main(["refresh_items"]) == 0
    finally:
        database.execute("select pg_advisory_unlock(%s)", (jobs.REFRESH_LOCK,))
    assert printed(capsys) == [refreshed(ran=False)]
    assert paypal.read == []


def lost_rows(conn: psycopg.Connection, ids: list[str]) -> None:
    """The ledger never got these items' rows: the webhook that would have written them was lost."""
    conn.execute("delete from payout_items where payout_item_id = any(%s)", (ids,))


def held_batch(conn: psycopg.Connection, paypal: JobsPayPal, campaign_id: uuid.UUID, ids: list[str]) -> tuple[str, dict]:
    """PayPal holds the campaign's batch with ids as its items, R1 first, all UNCLAIMED. Returns the payout_batch_id and the answer."""
    sender_batch_id, payout_batch_id = conn.execute(
        "select sender_batch_id, payout_batch_id from payout_batches where campaign_id = %s", (str(campaign_id),)
    ).fetchone()
    held = {
        "batch_header": {"payout_batch_id": payout_batch_id, "batch_status": "SUCCESS", "sender_batch_header": {"sender_batch_id": sender_batch_id}},
        "items": [
            {
                "payout_item_id": item_id,
                "transaction_status": "UNCLAIMED",
                "payout_batch_id": payout_batch_id,
                "payout_item_fee": {"currency": "USD", "value": "0.25"},
                "payout_item": {"sender_item_id": f"R{n}", "receiver": f"m{n}@shop.example"},
            }
            for n, item_id in enumerate(ids, start=1)
        ],
    }
    paypal.batches[payout_batch_id] = held
    return payout_batch_id, held


def logged(err: str, outcome: str) -> list[dict]:
    return [entry for entry in (json.loads(line) for line in err.splitlines() if line.startswith("{")) if entry.get("outcome") == outcome]


def test_a_batch_whose_item_rows_were_lost_is_read_back_and_its_unclaimed_rewards_are_then_cancelled(
    database: psycopg.Connection, paypal: JobsPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    # The reviewer's repro: only a webhook would have written these rows, and it never came.
    campaign_id, ids = sent_campaign(database, "demo", 60, 3)
    sender_batch_id = database.execute("select sender_batch_id from payout_batches where campaign_id = %s", (str(campaign_id),)).fetchone()[0]
    lost_rows(database, ids)
    payout_batch_id, _ = held_batch(database, paypal, campaign_id, ids)

    assert jobs.main(["refresh_items"]) == 0
    assert database.execute(
        "select payout_item_id, sender_item_id, status, fee_minor from payout_items order by payout_item_id"
    ).fetchall() == [(item_id, f"R{n}", "UNCLAIMED", 25) for n, item_id in enumerate(ids, start=1)]
    assert jobs.main(["cancel_demo_unclaimed"]) == 0

    assert printed(capsys) == [refreshed(batches=1, restored=3), answer(campaigns=1, cancelled=3, returned_minor=300)]
    assert paypal.batch_reads == [payout_batch_id] and paypal.asked == ids and statuses(database, ids) == {"RETURNED"}
    assert database.execute("select action, detail from audit_log where actor = 'refresh' order by id").fetchall() == [
        *[("payout_item_restored", {"payout_item_id": item_id, "sender_batch_id": sender_batch_id, "status": "UNCLAIMED"}) for item_id in ids],
        ("payout_batch_reread", {"sender_batch_id": sender_batch_id, "outcome": "read", "restored": 3, "moved": 0, "skipped": 0}),
    ]


def test_a_batch_read_records_only_items_of_our_batch_that_the_frozen_snapshot_names(
    database: psycopg.Connection, paypal: JobsPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    campaign_id, ids = sent_campaign(database, "owner", 60, 6)
    _, stored_elsewhere = sent_campaign(database, "owner", 60, 1)
    wrong_id, wrong_ids = sent_campaign(database, "owner", 50, 2)
    lost_rows(database, ids + wrong_ids)
    _, held = held_batch(database, paypal, campaign_id, ids)
    entries = held["items"]
    # PayPal's own sample leaves payout_batch_id off some items, so its absence is not a refusal.
    del entries[0]["payout_batch_id"]
    entries[1]["payout_batch_id"] = "BSOMEONEELSE"
    entries[2]["payout_item"]["sender_item_id"] = "R99"
    entries[4]["payout_item"]["sender_item_id"] = "R4"
    entries[5]["payout_item_id"] = stored_elsewhere[0]
    entries.append({**entries[0], "payout_item_id": "not-an-id", "payout_item": {"sender_item_id": "R5"}})
    _, wrong = held_batch(database, paypal, wrong_id, wrong_ids)
    wrong["batch_header"]["sender_batch_header"]["sender_batch_id"] = "mend-someone-else"

    assert jobs.main(["refresh_items"]) == 0

    assert [row[0] for row in database.execute("select payout_item_id from payout_items order by payout_item_id")] == sorted(
        [ids[0], stored_elsewhere[0]]
    )
    out, err = capsys.readouterr()
    assert [json.loads(line) for line in out.splitlines()] == [refreshed(batches=2, restored=1, skipped=6, failed=1)]
    assert [(entry["payout_item_id"], entry["reason"]) for entry in logged(err, "skipped")] == [
        (ids[1], "the item names another batch"),
        (ids[2], "the sender_item_id is not in the frozen snapshot"),
        (ids[3], "the sender_item_id appears more than once in PayPal's answer"),
        (ids[4], "the sender_item_id appears more than once in PayPal's answer"),
        (stored_elsewhere[0], "the item is stored under another batch"),
        (None, "the payout_item_id is malformed"),
    ]
    [failed] = logged(err, "failed")
    wrong_sender = database.execute("select sender_batch_id from payout_batches where campaign_id = %s", (str(wrong_id),)).fetchone()[0]
    assert (failed["error"], failed["sender_batch_id"]) == ("not_ours", wrong_sender)
    assert database.execute("select count(*) from payout_items i join payout_batches b using (sender_batch_id) where b.campaign_id = %s", (str(wrong_id),)).fetchone()[0] == 0


def test_batch_reads_take_at_most_10_a_run_oldest_first_and_one_paypal_cannot_answer_goes_to_the_back(
    database: psycopg.Connection, paypal: JobsPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    held = []
    for n in range(12):
        campaign_id, ids = sent_campaign(database, "owner", 100 - n, 1)
        lost_rows(database, ids)
        held.append(held_batch(database, paypal, campaign_id, ids)[0])
    young_id, young = sent_campaign(database, "owner", 14, 1)
    lost_rows(database, young)
    held_batch(database, paypal, young_id, young)
    paypal.batches[held[0]] = 500

    assert jobs.main(["refresh_items"]) == 0
    assert paypal.batch_reads == held[:10]
    assert jobs.main(["refresh_items"]) == 0
    assert paypal.batch_reads[10:] == held[10:]
    assert printed(capsys) == [refreshed(batches=10, restored=9, failed=1), refreshed(batches=2, restored=2)]


def test_a_batch_read_that_answers_denied_records_every_snapshot_item_as_failed(
    database: psycopg.Connection, paypal: JobsPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    listed_id, listed = sent_campaign(database, "owner", 60, 3)
    unlisted_id, unlisted = sent_campaign(database, "owner", 50, 2)
    set_status(database, listed[0], "PENDING")
    lost_rows(database, listed[1:] + unlisted)
    _, empty = held_batch(database, paypal, listed_id, [])
    _, bare = held_batch(database, paypal, unlisted_id, [])
    del bare["items"]
    for answer_body in (empty, bare):
        answer_body["batch_header"]["batch_status"] = "DENIED"

    assert jobs.main(["refresh_items"]) == 0

    assert printed(capsys) == [refreshed(batches=2)]
    for campaign_id, count in ((listed_id, 3), (unlisted_id, 2)):
        rows = database.execute(
            "select i.sender_item_id, i.status from payout_items i join payout_batches b using (sender_batch_id) "
            "where b.campaign_id = %s order by i.sender_item_id",
            (str(campaign_id),),
        ).fetchall()
        assert rows == [(f"R{n}", "FAILED") for n in range(1, count + 1)]
    assert database.execute("select status from payout_items where payout_item_id = %s", (listed[0],)).fetchone() == ("FAILED",)
    rereads = [row[0] for row in database.execute("select detail from audit_log where action = 'payout_batch_reread' order by id")]
    assert [(r["outcome"], r["items_failed"]) for r in rereads] == [("denied", 3), ("denied", 2)]
    assert jobs.main(["refresh_items"]) == 0 and len(paypal.batch_reads) == 2


def local_config(**changes: object) -> Config:
    """The Config a jobs run under dev:console loads: MEND_DEV on and no DATABASE_URL, unless changed."""
    settings: dict = {
        "paypal_client_id": "cid", "paypal_client_secret": "csecret-for-job-tests", "paypal_api_host": SANDBOX_API_HOST,
        "database_url": None, "dev": True, "test_receiver": None,
        "item_cap_minor": 1000, "campaign_cap_minor": 10000, "daily_cap_minor": 20000,
    }
    return Config(**{**settings, **changes})


DEV_WAIT_ENV = {"PAYPAL_ENV": "sandbox", "MEND_DEV_REFRESH_AFTER_SECONDS": "45"}


@pytest.mark.parametrize(
    ("changes", "env"),
    [
        ({"dev": False}, {}),
        ({"database_url": "postgresql://mend@db.internal/mend"}, {}),
        ({}, {"PAYPAL_ENV": "live"}),
        ({}, {"MEND_DEV_REFRESH_AFTER_SECONDS": ""}),
        ({}, {"MEND_DEV_REFRESH_AFTER_SECONDS": "29"}),
        ({}, {"MEND_DEV_REFRESH_AFTER_SECONDS": "901"}),
        ({}, {"MEND_DEV_REFRESH_AFTER_SECONDS": "abc"}),
        ({}, {"MEND_DEV_REFRESH_AFTER_SECONDS": "60.5"}),
    ],
    ids=["mend_dev_off", "database_url_set", "paypal_env_live", "empty", "29", "901", "abc", "60.5"],
)
def test_the_dev_wait_is_ignored_off_a_local_machine_and_for_anything_but_30_to_900_whole_seconds(changes: dict, env: dict) -> None:
    assert jobs.dev_refresh_after(local_config(**changes), {**DEV_WAIT_ENV, **env}) is None


@pytest.mark.parametrize("raw", ["30", "45", "900"])
def test_the_dev_wait_is_honoured_on_a_local_machine_from_30_to_900_seconds(raw: str) -> None:
    assert jobs.dev_refresh_after(local_config(), {**DEV_WAIT_ENV, "MEND_DEV_REFRESH_AFTER_SECONDS": raw}) == timedelta(seconds=int(raw))


def read_seconds_ago(conn: psycopg.Connection, campaign_id: uuid.UUID, seconds: int) -> None:
    """The refresh job last read this campaign's batch seconds ago."""
    sender_batch_id = conn.execute("select sender_batch_id from payout_batches where campaign_id = %s", (str(campaign_id),)).fetchone()[0]
    conn.execute(
        "insert into audit_log (at, actor, action, detail) values (now() - make_interval(secs => %s), 'refresh', 'payout_batch_reread', %s)",
        (seconds, Jsonb({"sender_batch_id": sender_batch_id, "outcome": "read", "restored": 0, "moved": 0, "skipped": 0})),
    )


def test_on_a_local_machine_a_45_second_wait_reads_a_short_batch_read_50_seconds_ago_and_not_one_read_40_seconds_ago(
    database: psycopg.Connection, paypal: JobsPayPal, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    due_id, due = sent_campaign(database, "owner", 30, 2)
    recent_id, recent = sent_campaign(database, "owner", 30, 2)
    lost_rows(database, due + recent)
    due_batch, _ = held_batch(database, paypal, due_id, due)
    held_batch(database, paypal, recent_id, recent)
    read_seconds_ago(database, due_id, 50)
    read_seconds_ago(database, recent_id, 40)
    monkeypatch.setenv("PAYPAL_ENV", "sandbox")
    monkeypatch.setenv("MEND_DEV_REFRESH_AFTER_SECONDS", "45")

    # The fixture's Config has the deployed shape, MEND_DEV off and DATABASE_URL set, so the setting is ignored.
    assert jobs.main(["refresh_items"]) == 0
    assert paypal.batch_reads == []

    # As dev:console runs the jobs: no DATABASE_URL, so the bundled pgserver, with PGOPTIONS naming the schema.
    monkeypatch.setenv("PGOPTIONS", f"-c search_path={database.execute('select current_schema()').fetchone()[0]}")
    monkeypatch.setattr(tasks, "_load_config", local_config)
    assert jobs.main(["refresh_items"]) == 0

    assert paypal.batch_reads == [due_batch] and statuses(database, due) == {"UNCLAIMED"}
    assert printed(capsys) == [refreshed(), refreshed(batches=1, restored=2, after=45)]


def sent_with_member(conn: psycopg.Connection) -> uuid.UUID:
    """A campaign whose rewarded member is R1, sent a day ago, so a purchase an hour ago is in its window."""
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values ('Shop', 'goal', '2026-10-16', 1000, 100, 0.5, 'draft') returning campaign_id"
    ).fetchone()[0]
    conn.execute(
        "insert into campaign_members (campaign_id, ref, role, rank, score, amount_minor, note) values (%s, 'R1', 'reward', 1, 0.1, 100, 'Thanks')",
        (campaign_id,),
    )
    for step in ("approved", "submitting", "submitted"):
        conn.execute("update campaigns set status = %s where campaign_id = %s", (step, campaign_id))
    conn.execute(
        "insert into campaign_status_moves (campaign_id, from_status, to_status, moved_at) "
        "values (%s, 'submitting', 'submitted', now() - interval '1 day')",
        (campaign_id,),
    )
    return campaign_id


def simulated(conn: psycopg.Connection, paypal: JobsPayPal, campaign_id: uuid.UUID, order_id: str | None, minutes_ago: int) -> None:
    """A purchase the simulate button made as R1 minutes_ago, which PayPal holds as COMPLETED an hour ago, by its order id."""
    simulated_order_id = uuid.uuid4()
    conn.execute(
        "insert into simulated_orders (simulated_order_id, paypal_order_id, campaign_id, ref, created_at) "
        "values (%s, %s, %s, 'R1', now() - make_interval(mins => %s))",
        (simulated_order_id, order_id, campaign_id, minutes_ago),
    )
    if order_id is None:
        return
    when = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    paypal.orders[order_id] = {
        "id": order_id,
        "status": "COMPLETED",
        "payment_source": {"card": {"name": "Test Buyer", "last_digits": "1111"}},
        "purchase_units": [
            {
                "custom_id": str(simulated_order_id),
                "payments": {
                    "captures": [{"id": "CAP1", "status": "COMPLETED", "amount": {"currency_code": "USD", "value": "12.50"}, "create_time": when}]
                },
            }
        ],
    }


def test_a_simulated_order_with_no_purchase_is_read_after_15_minutes_and_recorded_as_the_capture_webhook_would(
    database: psycopg.Connection, paypal: JobsPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    campaign_id = sent_with_member(database)
    simulated(database, paypal, campaign_id, "SIMLOST1", 20)
    simulated(database, paypal, campaign_id, "SIMYOUNG1", 10)
    simulated(database, paypal, campaign_id, "SIMKNOWN1", 20)
    # PayPal's answer to the create was lost, so there is no order id to read.
    simulated(database, paypal, campaign_id, None, 20)
    database.execute(
        "insert into attributions (campaign_id, ref, role, purchased_at, amount_minor, simulated, source_order) "
        "values (%s, 'R1', 'reward', now(), 1250, true, 'SIMKNOWN1')",
        (campaign_id,),
    )

    assert jobs.main(["refresh_items"]) == 0

    assert paypal.order_reads == ["SIMLOST1"]
    assert printed(capsys) == [refreshed(orders=1, purchases=1)]
    assert database.execute(
        "select ref, role, amount_minor, simulated from attributions where source_order = 'SIMLOST1'"
    ).fetchall() == [("R1", "reward", 1250, True)]
    # The capture webhook arriving late meets the same record through the same path, and adds nothing.
    transmission_id = str(uuid.uuid4())
    body = {"id": "WH-1", "event_type": "PAYMENT.CAPTURE.COMPLETED", "resource": {"supplementary_data": {"related_ids": {"order_id": "SIMLOST1"}}}}
    database.execute(
        "insert into paypal_events (transmission_id, event_id, event_type, received_at, purge_after, raw) "
        "values (%s, 'WH-1', 'PAYMENT.CAPTURE.COMPLETED', now(), now() + interval '48 hours', %s)",
        (transmission_id, json.dumps(body)),
    )
    assert jobs.main(["process_events"]) == 0
    assert database.execute("select outcome, detail ->> 'reason' from event_outcomes where transmission_id = %s", (transmission_id,)).fetchone() == (
        "purchase refused", "the purchase is already attributed",
    )
    assert database.execute("select count(*) from attributions where source_order = 'SIMLOST1'").fetchone()[0] == 1


def test_at_most_10_orders_are_read_a_run_and_one_paypal_does_not_complete_or_cannot_answer_goes_to_the_back(
    database: psycopg.Connection, paypal: JobsPayPal, capsys: pytest.CaptureFixture[str]
) -> None:
    campaign_id = sent_with_member(database)
    orders = [f"SIM{n:02d}" for n in range(12)]
    for n, order_id in enumerate(orders):
        simulated(database, paypal, campaign_id, order_id, 40 - n)
    paypal.orders[orders[0]] = 500
    paypal.orders[orders[1]]["status"] = "APPROVED"

    assert jobs.main(["refresh_items"]) == 0
    assert paypal.order_reads == orders[:10]
    assert jobs.main(["refresh_items"]) == 0
    assert paypal.order_reads[10:] == orders[10:]

    assert printed(capsys) == [refreshed(orders=10, purchases=8, failed=1), refreshed(orders=2, purchases=2)]
    assert sorted(row[0] for row in database.execute("select source_order from attributions")) == orders[2:]
    assert database.execute(
        "select detail ->> 'outcome', detail ->> 'reason' from audit_log where action = 'simulated_order_reread' "
        "and detail ->> 'paypal_order_id' = any(%s) order by id",
        (orders[:2],),
    ).fetchall() == [("failed", None), ("purchase refused", "PayPal does not say the order is COMPLETED")]
