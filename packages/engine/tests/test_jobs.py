# Not covered here: process_events and reconcile against real PayPal answers (test_events.py,
# test_reconcile.py and prove_m5 cover them), the cancel job and the refresh job against
# PayPal's real cancel and item answers (the M7e-1 live probe covers the cancel call, and
# the webhook path reads real items through the same get_item), a failure row older than
# an hour (the audit log cannot be backdated), and the cron schedule on Render: the live
# proof (node scripts/deploy/render.mjs prove) checks that mend-jobs has run.
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
from mend_engine.paypal.payouts import (
    PAYOUT_ITEM_PATH,
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
    another batch.
    """

    def __init__(self, conn: psycopg.Connection) -> None:
        self.conn = conn
        self.asked: list[str] = []
        self.read: list[str] = []
        self.failing: dict[str, int] = {}
        self.reads: dict[str, str | int] = {}
        self.elsewhere: set[str] = set()

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
        assert request.method == "GET" and path.startswith(PAYOUT_ITEM_PATH + "/"), "the jobs only cancel and read items"
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


def test_campaigns_paypal_will_not_cancel_rest_for_an_hour_and_never_block_a_newer_one(
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


def test_a_paypal_error_on_one_campaign_is_logged_and_the_cancel_job_goes_on_to_the_next(
    database: psycopg.Connection, paypal: JobsPayPal, capsys: pytest.CaptureFixture[str]
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
    zero = {"items": 0, "moved": 0, "unchanged": 0, "refused": 0, "failed": 0}
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
