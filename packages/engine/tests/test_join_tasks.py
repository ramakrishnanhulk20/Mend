# Not covered here: Log in with PayPal itself and the web app's join and leave routes
# (packages/web tests), whether a real sandbox payer id has the 13-character shape
# (day zero), and two joins, or a join and a leave, racing on separate connections.
import hashlib
import json
import re
import uuid
from collections.abc import Iterator
from dataclasses import replace
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

import pgserver
import psycopg
import pytest
from psycopg import sql

from mend_engine import tasks
from mend_engine.config import SANDBOX_API_HOST, Config
from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import apply_schema
from mend_engine.members.consent import CONSENT_VERSION, DEMO_SHOP_NAME, consent_text_for
from mend_engine.members.membership import LEFT_REASON

CLIENT_ID = "cid-for-join-tests"
PAYER_A = "PAYERAAAAAAA1"
PAYER_B = "PAYERBBBBBBB2"
# Worked out here, not with consent_hash, so the task is checked against SHA-256 itself.
CONSENT = hashlib.sha256(consent_text_for(DEMO_SHOP_NAME).encode("utf-8")).hexdigest()
REF_SHAPE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


@pytest.fixture(scope="module")
def server_url() -> Iterator[str]:
    server = pgserver.get_server(PGDATA)
    yield server.get_uri()


@pytest.fixture
def schema(server_url: str) -> Iterator[str]:
    name = "m7c_join_" + uuid.uuid4().hex[:12]
    with psycopg.connect(server_url, autocommit=True) as admin:
        admin.execute(sql.SQL("create schema {}").format(sql.Identifier(name)))
        try:
            yield name
        finally:
            admin.execute(sql.SQL("drop schema {} cascade").format(sql.Identifier(name)))


@pytest.fixture
def conn(server_url: str, schema: str) -> Iterator[psycopg.Connection]:
    with psycopg.connect(server_url, autocommit=True) as connection:
        connection.execute(sql.SQL("set search_path to {}").format(sql.Identifier(schema)))
        apply_schema(connection)
        yield connection


@pytest.fixture
def config(monkeypatch: pytest.MonkeyPatch, server_url: str, schema: str, conn: psycopg.Connection) -> Config:
    """Points every task at this test's schema. Joining and leaving never call PayPal."""
    parts = urlsplit(server_url)
    query = urlencode([*parse_qsl(parts.query), ("options", f"-c search_path={schema}")], quote_via=quote)
    found = Config(
        paypal_client_id=CLIENT_ID,
        paypal_client_secret="csecret-for-join-tests",
        paypal_api_host=SANDBOX_API_HOST,
        database_url=urlunsplit(parts._replace(query=query)),
        dev=True,
        test_receiver=None,
        item_cap_minor=1000,
        campaign_cap_minor=10000,
        daily_cap_minor=20000,
    )
    monkeypatch.setattr(tasks, "_load_config", lambda: found)
    return found


def identity(email: str, *, verified: bool = True, payer_id: str | None = None) -> dict:
    return {"email": email, "email_verified": verified, "payer_id": payer_id}


def refused(result: dict, code: str) -> bool:
    return set(result) == {"ok", "error", "ref"} and result["ok"] is False and result["error"] == code and bool(REF_SHAPE.fullmatch(result["ref"]))


def written(conn: psycopg.Connection) -> tuple:
    return conn.execute("select (select count(*) from members), (select count(*) from audit_log)").fetchone()


def draft_holding(conn: psycopg.Connection, member_id: uuid.UUID) -> uuid.UUID:
    campaign_id = conn.execute(
        "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
        "values (%s, 'goal', '2026-10-16', 1000, 100, 0.5, 'draft') returning campaign_id",
        (DEMO_SHOP_NAME,),
    ).fetchone()[0]
    conn.execute(
        "insert into campaign_members (campaign_id, ref, member_id, role, rank, score, amount_minor, note) "
        "values (%s, 'R1', %s, 'reward', 1, 0.1, 100, 'Thanks')",
        (campaign_id, member_id),
    )
    return campaign_id


def test_consent_text_gives_the_demo_shops_sentence_and_the_hash_of_that_text(conn: psycopg.Connection, config: Config) -> None:
    found = tasks.consent_text()

    assert found == {
        "ok": True,
        "shop_name": DEMO_SHOP_NAME,
        "text": consent_text_for(DEMO_SHOP_NAME),
        "hash": hashlib.sha256(found["text"].encode("utf-8")).hexdigest(),
    }
    assert found["hash"] == CONSENT and found["text"].startswith(DEMO_SHOP_NAME + " may look at your past orders")


def test_join_creates_a_member_once_and_joining_again_returns_the_same_one_with_no_audit_row(
    conn: psycopg.Connection, config: Config
) -> None:
    first = tasks.join(identity(" Maya.R@Shop.Example ", payer_id=PAYER_A), CONSENT)

    assert set(first) == {"ok", "member_id", "created", "linked"}
    assert (first["ok"], first["created"], first["linked"]) == (True, True, False)
    stored = conn.execute(
        "select member_id::text, paypal_email, paypal_payer_id, email_verified, consent_version, client_id from members"
    ).fetchall()
    assert stored == [(str(uuid.UUID(first["member_id"])), "maya.r@shop.example", PAYER_A, True, CONSENT_VERSION, CLIENT_ID)]
    assert written(conn) == (1, 1)

    again = tasks.join(identity("maya.r@shop.example", payer_id=PAYER_A), CONSENT)
    without_payer_id = tasks.join(identity("MAYA.R@shop.example"), CONSENT)

    assert again == without_payer_id == {"ok": True, "member_id": first["member_id"], "created": False, "linked": False}
    assert written(conn) == (1, 1)


def test_join_links_a_verified_shop_customer_and_never_an_unverified_one(conn: psycopg.Connection, config: Config) -> None:
    conn.execute(
        "insert into shop_customers values ('C1', 'Maya R.', 'c1@shop.example', 'UK'), ('C2', 'Lena A.', 'c2@shop.example', 'UK')"
    )

    verified = tasks.join(identity("C1@shop.example"), CONSENT)
    unverified = tasks.join(identity("c2@shop.example", verified=False), CONSENT)
    outsider = tasks.join(identity("nobody@outside.example"), CONSENT)

    assert (verified["created"], verified["linked"]) == (True, True)
    assert (unverified["ok"], unverified["created"], unverified["linked"]) == (True, True, False)
    assert (outsider["created"], outsider["linked"]) == (True, False)


def test_a_verified_join_upgrades_an_unverified_member_and_links_them(conn: psycopg.Connection, config: Config) -> None:
    conn.execute("insert into shop_customers values ('C1', 'Maya R.', 'c1@shop.example', 'UK')")
    first = tasks.join(identity("c1@shop.example", verified=False), CONSENT)
    assert (first["created"], first["linked"]) == (True, False)

    upgraded = tasks.join(identity("C1@shop.example", payer_id=PAYER_A), CONSENT)

    assert upgraded == {"ok": True, "member_id": first["member_id"], "created": False, "linked": True}
    assert conn.execute("select email_verified, paypal_payer_id, consent_version from members").fetchall() == [
        (True, PAYER_A, CONSENT_VERSION)
    ]
    audit = conn.execute("select action, detail::text from audit_log order by id").fetchall()
    assert [action for action, _detail in audit] == ["member_joined", "member_email_verified"]
    assert "@" not in str(audit) and PAYER_A not in str(audit)

    # Never downgraded by a later unverified sign-in, and nothing more is written.
    again = tasks.join(identity("c1@shop.example", verified=False), CONSENT)
    assert again == {"ok": True, "member_id": first["member_id"], "created": False, "linked": True}
    assert written(conn) == (1, 2)


def test_an_upgrade_carrying_another_payer_id_is_identity_conflict_and_writes_nothing(conn: psycopg.Connection, config: Config) -> None:
    tasks.join(identity("c1@shop.example", verified=False, payer_id=PAYER_A), CONSENT)
    before = conn.execute("select xmin::text, m.* from members m").fetchall()

    assert refused(tasks.join(identity("c1@shop.example", payer_id=PAYER_B), CONSENT), "identity_conflict")

    assert conn.execute("select xmin::text, m.* from members m").fetchall() == before
    assert written(conn) == (1, 1)


@pytest.mark.parametrize("consent", ["0" * 64, CONSENT.upper(), CONSENT + "\n", CONSENT[:63], None, 7])
def test_join_refuses_any_consent_but_exactly_the_current_hash(conn: psycopg.Connection, config: Config, consent: object) -> None:
    assert CONSENT.upper() != CONSENT
    assert refused(tasks.join(identity("ok@shop.example"), consent), "consent_changed")
    assert written(conn) == (0, 0)


GOOD = identity("ok@shop.example", payer_id=PAYER_A)


@pytest.mark.parametrize(
    "bad",
    [
        {k: v for k, v in GOOD.items() if k != "payer_id"},
        {**GOOD, "name": "Maya R."},
        {**GOOD, "email_verified": 1},
        {**GOOD, "email_verified": "true"},
        {**GOOD, "payer_id": PAYER_A[:12]},
        {**GOOD, "payer_id": PAYER_A.lower()},
        {**GOOD, "payer_id": PAYER_A + "\n"},
        {**GOOD, "email": "a" * 242 + "@shop.example"},
        {**GOOD, "email": None},
        ["ok@shop.example", True, PAYER_A],
        None,
    ],
)
def test_join_and_leave_refuse_an_identity_of_the_wrong_shape_and_change_nothing(
    conn: psycopg.Connection, config: Config, bad: object
) -> None:
    assert tasks.join(GOOD, CONSENT)["created"] is True

    assert refused(tasks.join(bad, CONSENT), "bad_identity")
    assert refused(tasks.leave(bad), "bad_identity")
    assert written(conn) == (1, 1)


@pytest.mark.parametrize("email", ["not an email", "x@y", "a" * 120 + "@shop.example", ""])
def test_join_refuses_an_email_paypal_could_not_pay(conn: psycopg.Connection, config: Config, email: str) -> None:
    assert refused(tasks.join(identity(email), CONSENT), "not_payable")
    assert written(conn) == (0, 0)


def test_join_refuses_an_email_or_payer_id_that_belongs_to_another_member(conn: psycopg.Connection, config: Config) -> None:
    member_id = tasks.join(identity("a@shop.example", payer_id=PAYER_A), CONSENT)["member_id"]

    assert refused(tasks.join(identity("a@shop.example", payer_id=PAYER_B), CONSENT), "identity_conflict")
    assert refused(tasks.join(identity("new@shop.example", payer_id=PAYER_A), CONSENT), "identity_conflict")
    assert conn.execute("select member_id::text, paypal_payer_id from members").fetchall() == [(member_id, PAYER_A)]
    assert written(conn) == (1, 1)


def test_any_other_membership_rule_refusal_is_bad_identity(conn: psycopg.Connection, config: Config, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tasks, "_load_config", lambda: replace(config, paypal_client_id="client id with spaces"))
    assert refused(tasks.join(identity("ok@shop.example"), CONSENT), "bad_identity")
    assert written(conn) == (0, 0)


def test_leave_removes_the_member_voids_the_open_draft_that_held_them_and_a_second_leave_is_harmless(
    conn: psycopg.Connection, config: Config
) -> None:
    member_id = uuid.UUID(tasks.join(identity("leaver@shop.example", payer_id=PAYER_A), CONSENT)["member_id"])
    stayer = uuid.UUID(tasks.join(identity("stayer@shop.example"), CONSENT)["member_id"])
    draft = draft_holding(conn, member_id)
    untouched = draft_holding(conn, stayer)

    assert tasks.leave(identity(" Leaver@Shop.Example", payer_id=PAYER_A)) == {"ok": True, "left": True, "voided": 1}

    assert conn.execute("select member_id from members").fetchall() == [(stayer,)]
    statuses = {row[0]: row[1:] for row in conn.execute("select campaign_id, status, void_reason from campaigns")}
    assert statuses == {draft: ("voided", LEFT_REASON), untouched: ("draft", None)}
    assert conn.execute("select count(*) from campaign_members where campaign_id = %s", (draft,)).fetchone() == (0,)

    assert tasks.leave(identity("leaver@shop.example", payer_id=PAYER_A)) == {"ok": True, "left": False, "voided": 0}


def test_leave_refuses_a_payer_id_that_is_not_the_members(conn: psycopg.Connection, config: Config) -> None:
    tasks.join(identity("a@shop.example", payer_id=PAYER_A), CONSENT)

    assert refused(tasks.leave(identity("a@shop.example", payer_id=PAYER_B)), "identity_conflict")
    assert written(conn) == (1, 1)
    # A sign-in that carries no payer id is matched on the verified email alone.
    assert tasks.leave(identity("a@shop.example")) == {"ok": True, "left": True, "voided": 0}


def test_leave_refuses_an_unverified_email_before_looking_anyone_up(conn: psycopg.Connection, config: Config) -> None:
    tasks.join(identity("a@shop.example", payer_id=PAYER_A), CONSENT)

    # The same answer for a member's email and for an email nobody has, so the refusal comes before any lookup.
    assert refused(tasks.leave(identity("a@shop.example", verified=False, payer_id=PAYER_A)), "email_unverified")
    assert refused(tasks.leave(identity("nobody@shop.example", verified=False)), "email_unverified")
    assert written(conn) == (1, 1)


def test_no_email_payer_id_or_consent_text_reaches_the_log_in_any_case(
    conn: psycopg.Connection, config: Config, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    conn.execute("insert into shop_customers values ('C1', 'Maya R.', 'c1@shop.example', 'UK')")
    capsys.readouterr()

    results = [
        tasks.consent_text(),
        tasks.join(identity("c1@shop.example", payer_id=PAYER_A), CONSENT),
        tasks.join(identity("c1@shop.example", payer_id=PAYER_A), CONSENT),
        tasks.join(identity("c2@shop.example", verified=False), CONSENT),
        tasks.join(identity("c3@shop.example"), "0" * 64),
        tasks.join(identity("c3@shop.example"), CONSENT.upper()),
        tasks.join({**identity("c3@shop.example"), "extra": 1}, CONSENT),
        tasks.join(identity("c3@shop.example", payer_id=PAYER_B[:12]), CONSENT),
        tasks.join(identity("not an email"), CONSENT),
        tasks.join(identity("x@y"), CONSENT),
        tasks.join(identity("c1@shop.example", payer_id=PAYER_B), CONSENT),
        tasks.leave(identity("c1@shop.example", payer_id=PAYER_B)),
        tasks.leave(identity("c1@shop.example", verified=False, payer_id=PAYER_A)),
        tasks.leave(identity("c1@shop.example", payer_id=PAYER_A)),
        tasks.leave(identity("c1@shop.example", payer_id=PAYER_A)),
    ]
    monkeypatch.setattr(tasks, "_load_config", lambda: replace(config, paypal_client_id="client id with spaces"))
    results.append(tasks.join(identity("c4@shop.example"), CONSENT))

    errors = [r.get("error") for r in results]
    assert errors == [None, None, None, None, "consent_changed", "consent_changed", "bad_identity", "bad_identity",
                      "not_payable", "not_payable", "identity_conflict", "identity_conflict", "email_unverified",
                      None, None, "bad_identity"]
    err = capsys.readouterr().err
    logged = [json.loads(line) for line in err.splitlines()]
    assert len(logged) == len(results)
    assert [line["ref"] for line in logged if line["outcome"] == "refused"] == [r["ref"] for r in results if not r["ok"]]
    for leaked in ("@", PAYER_A, PAYER_B, PAYER_B[:12], consent_text_for(DEMO_SHOP_NAME), "past orders"):
        assert leaked not in err


def test_an_unexpected_failure_logs_an_email_as_a_placeholder_in_the_detail_and_the_trace(
    conn: psycopg.Connection, config: Config, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def broken(_conn: psycopg.Connection, **given: object) -> None:
        raise psycopg.errors.UniqueViolation(
            'duplicate key value violates unique constraint "members_paypal_email_key"\n'
            f"DETAIL:  Key (paypal_email)=({given['paypal_email']}) already exists."
        )

    monkeypatch.setattr(tasks, "join_member", broken)
    capsys.readouterr()

    result = tasks.join(identity("maya.r@shop.example"), CONSENT)

    assert refused(result, "internal")
    err = capsys.readouterr().err
    [entry] = [line for line in map(json.loads, err.splitlines()) if line["ref"] == result["ref"]]
    assert (entry["outcome"], entry["exception"]) == ("failed", "UniqueViolation")
    assert "Key (paypal_email)=([email])" in entry["detail"] and "Key (paypal_email)=([email])" in entry["trace"]
    assert "Traceback" in entry["trace"] and "@" not in err
