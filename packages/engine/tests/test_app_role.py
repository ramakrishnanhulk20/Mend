# Not covered here: the roles on Render's Postgres, where the owner has CREATEROLE but is not
# a superuser (the live proof, node scripts/deploy/render.mjs prove, attacks them there), and
# password checks: the local pgserver trusts local logins, so a wrong password would still
# connect. Each test uses role names of its own, because roles belong to the whole cluster.
import uuid
from collections.abc import Iterator
from dataclasses import replace
from datetime import date
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

import pgserver
import psycopg
import pytest
from psycopg import sql
from psycopg.errors import InsufficientPrivilege
from psycopg.types.json import Jsonb

from mend_engine.config import SANDBOX_API_HOST, Config, ConfigError
from mend_engine.db import migrate as migrate_module
from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import NEVER_WEB_WRITES, WEB_READ_ONLY, grant_engine_role, migrate

PASSWORD = "db-role-test-password-0123456789abcdef"
SESSION = "a" * 64


@pytest.fixture(scope="module")
def server_url() -> str:
    return pgserver.get_server(PGDATA).get_uri()


@pytest.fixture
def schema(server_url: str) -> Iterator[str]:
    name = "db_roles_" + uuid.uuid4().hex[:12]
    with psycopg.connect(server_url, autocommit=True) as admin:
        admin.execute(sql.SQL("create schema {}").format(sql.Identifier(name)))
        try:
            yield name
        finally:
            admin.execute(sql.SQL("drop schema {} cascade").format(sql.Identifier(name)))


@pytest.fixture
def roles(server_url: str, schema: str) -> Iterator[dict[str, str]]:
    """Role names of this test's own; whatever they were granted is dropped with them."""
    tag = uuid.uuid4().hex[:10]
    names = {"engine": f"mend_engine_{tag}", "web": f"mend_web_{tag}", "legacy": f"mend_app_{tag}"}
    try:
        yield names
    finally:
        # Under migrate's own lock: the database's privilege row is shared by every test run
        # on this pgserver, and two sessions changing it at once fail with "tuple concurrently updated".
        with psycopg.connect(server_url, autocommit=True) as admin, admin.transaction():
            admin.execute("select pg_advisory_xact_lock(%s)", (migrate_module.SCHEMA_LOCK,))
            for name in names.values():
                if admin.execute("select 1 from pg_roles where rolname = %s", (name,)).fetchone():
                    admin.execute(sql.SQL("drop owned by {}").format(sql.Identifier(name)))
                    admin.execute(sql.SQL("drop role {}").format(sql.Identifier(name)))


def config_for(server_url: str, schema: str) -> Config:
    parts = urlsplit(server_url)
    query = urlencode([*parse_qsl(parts.query), ("options", f"-c search_path={schema}")], quote_via=quote)
    return Config(
        paypal_client_id="cid", paypal_client_secret="csecret-for-role-tests", paypal_api_host=SANDBOX_API_HOST,
        database_url=urlunsplit(parts._replace(query=query)), dev=False, test_receiver=None,
        item_cap_minor=1000, campaign_cap_minor=10000, daily_cap_minor=20000,
    )


def run_migrate(config: Config, roles: dict[str, str], **kwargs: object) -> migrate_module.Migrated:
    passwords = {"engine_password": PASSWORD, "web_password": PASSWORD}
    passwords.update({key: value for key, value in kwargs.items() if key.endswith("_password")})
    rest = {key: value for key, value in kwargs.items() if not key.endswith("_password")}
    return migrate(config, **passwords, engine_role=roles["engine"], web_role=roles["web"], legacy_role=roles["legacy"], **rest)


@pytest.fixture
def migrated(server_url: str, schema: str, roles: dict[str, str]) -> Config:
    config = config_for(server_url, schema)
    run_migrate(config, roles)
    return config


def connect_as(server_url: str, schema: str, role: str) -> psycopg.Connection:
    return psycopg.connect(server_url, user=role, password=PASSWORD, autocommit=True, options=f"-c search_path={schema}")


def admin(server_url: str, schema: str) -> psycopg.Connection:
    return psycopg.connect(server_url, autocommit=True, options=f"-c search_path={schema}")


# The engine role (mend-engine and mend-jobs).


@pytest.mark.parametrize(
    "statement",
    [
        "alter table audit_log disable trigger audit_log_append_only",
        "update audit_log set actor = actor",
        "delete from audit_log",
        "truncate audit_log",
        "create table smuggled (id integer)",
        "truncate shop_customers",
        "drop table members",
        "alter table members add column extra text",
        "create trigger smuggled before insert on members for each row execute function mend_refuse_change()",
    ],
)
def test_the_engine_role_cannot_change_the_schema_or_the_audit_log(server_url: str, schema: str, roles: dict, migrated: Config, statement: str) -> None:
    with connect_as(server_url, schema, roles["engine"]) as conn:
        conn.execute("insert into audit_log (actor, action, detail) values ('test', 'kept', '{}')")
        with pytest.raises(InsufficientPrivilege):
            conn.execute(statement)
    with admin(server_url, schema) as conn:
        assert conn.execute("select count(*) from audit_log where action = 'kept'").fetchone()[0] == 1
        assert conn.execute("select count(*) from pg_trigger where tgrelid = 'audit_log'::regclass and tgenabled = 'D'").fetchone()[0] == 0


def test_the_engine_role_appends_to_the_audit_log_and_reads_and_writes_the_other_tables(server_url: str, schema: str, roles: dict, migrated: Config) -> None:
    with connect_as(server_url, schema, roles["engine"]) as conn:
        conn.execute("insert into audit_log (actor, action, detail) values (%s, %s, %s)", ("test", "engine_wrote", Jsonb({"n": 1})))
        assert conn.execute("select actor from audit_log where action = 'engine_wrote'").fetchone() == ("test",)
        conn.execute("insert into shop_customers values ('C1', 'Ann B.', 'c1@shop.example', 'UK')")
        conn.execute("update shop_customers set country = 'FR' where customer_ref = 'C1'")
        # The status trigger writes campaign_status_moves as the role that changed the campaign.
        campaign = conn.execute(
            "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
            "values ('Shop', 'goal', '2026-10-16', 100, 10, 0.5, 'draft') returning campaign_id"
        ).fetchone()[0]
        assert conn.execute("select to_status from campaign_status_moves where campaign_id = %s", (campaign,)).fetchone() == ("draft",)
        conn.execute("insert into payout_batches (sender_batch_id, campaign_id, snapshot_hash, status) values ('s1', 'c', 'h', 'created')")
        conn.execute("update payout_batches set status = 'submitted' where sender_batch_id = 's1'")
        conn.execute("delete from shop_customers where customer_ref = 'C1'")


def privileges(server_url: str, schema: str, role: str) -> tuple:
    """Everything the role holds and is, read from the catalog, in a fixed order."""
    with psycopg.connect(server_url, autocommit=True) as conn:
        tables = conn.execute(
            "select c.relname, a.privilege_type from pg_class c cross join lateral aclexplode(c.relacl) a "
            "where c.relnamespace = %s::regnamespace and a.grantee = %s::regrole order by 1, 2",
            (schema, role),
        ).fetchall()
        on_schema = conn.execute(
            "select a.grantee::regrole::text, a.privilege_type from pg_namespace n cross join lateral aclexplode(n.nspacl) a "
            "where n.nspname = %s order by 1, 2",
            (schema,),
        ).fetchall()
        defaults = conn.execute(
            "select d.defaclobjtype, a.privilege_type from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a "
            "where d.defaclnamespace = %s::regnamespace and a.grantee = %s::regrole order by 1, 2",
            (schema, role),
        ).fetchall()
        attributes = conn.execute(
            "select rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls from pg_roles where rolname = %s",
            (role,),
        ).fetchone()
        owned = conn.execute("select count(*) from pg_class where relnamespace = %s::regnamespace and relowner = %s::regrole", (schema, role)).fetchone()
        shape = conn.execute(
            "select (select count(*) from pg_class where relnamespace = %s::regnamespace), "
            "(select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = %s::regnamespace and not t.tgisinternal)",
            (schema, schema),
        ).fetchone()
    return tables, on_schema, defaults, attributes, owned, shape


def held_by(tables: list) -> dict[str, set[str]]:
    held: dict[str, set[str]] = {}
    for table, privilege in tables:
        held.setdefault(table, set()).add(privilege)
    return held


def test_the_engine_role_holds_exactly_what_mend_engine_and_mend_jobs_need(server_url: str, schema: str, roles: dict, migrated: Config) -> None:
    tables, on_schema, defaults, attributes, owned, _shape = privileges(server_url, schema, roles["engine"])
    held = held_by(tables)
    assert held.pop("audit_log") == {"SELECT", "INSERT"}
    sequences = {name for name, kinds in held.items() if kinds == {"SELECT", "USAGE"}}
    assert sequences and all(name.endswith("_seq") for name in sequences)
    assert all(held[name] == {"SELECT", "INSERT", "UPDATE", "DELETE"} for name in held if name not in sequences)
    assert (roles["engine"], "USAGE") in on_schema and (roles["engine"], "CREATE") not in on_schema and ("-", "CREATE") not in on_schema
    assert defaults == [("S", "SELECT"), ("S", "USAGE"), ("r", "DELETE"), ("r", "INSERT"), ("r", "SELECT"), ("r", "UPDATE")]
    assert attributes == (False, False, False, True, False, False)
    assert owned == (0,)


# The web role (mend-web).


def test_the_web_role_runs_every_statement_the_website_sends(server_url: str, schema: str, roles: dict, migrated: Config) -> None:
    with connect_as(server_url, schema, roles["web"]) as conn:
        conn.execute("insert into audit_log (actor, action, detail) values (%s, %s, %s::jsonb)", ("web", "signed_in", "{}"))
        conn.execute("insert into rate_limit_hits (bucket, subject) values (%s, %s)", ("draft", "s"))
        assert conn.execute("select count(*)::int from rate_limit_hits where bucket = %s and subject = %s", ("draft", "s")).fetchone() == (1,)
        conn.execute("delete from rate_limit_hits where at < now() - make_interval(secs => %s)", (60,))
        conn.execute("insert into sessions (session_id, role, expires_at) values (%s, 'demo', now() + interval '1 day') returning expires_at", (SESSION,))
        assert conn.execute("update sessions set last_seen_at = now() where session_id = %s returning role", (SESSION,)).fetchone() == ("demo",)
        conn.execute("insert into run_owners (run_id, session_id_hash, task) values (%s, %s, %s) on conflict (run_id) do nothing", ("brn-1", SESSION, "results"))
        assert conn.execute("select task from run_owners where run_id = %s", ("brn-1",)).fetchone() == ("results",)
        upsert = "insert into paypal_certs (url, last_verified_at) values (%s, now()) on conflict (url) do update set last_verified_at = excluded.last_verified_at"
        conn.execute(upsert, ("https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",))
        conn.execute(upsert, ("https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",))
        assert conn.execute("select count(*)::int from paypal_certs").fetchone() == (1,)
        assert conn.execute("select 1 from paypal_events where transmission_id = %s", ("t1",)).fetchone() is None
        assert conn.execute("select exists (select 1 from event_outcomes where transmission_id = %s)", ("t1",)).fetchone() == (False,)
        conn.execute(
            "insert into paypal_events (transmission_id, event_id, event_type, resource_id, received_at, purge_after, raw) "
            "values (%s, %s, %s, %s, now(), now() + make_interval(hours => %s), %s) on conflict do nothing",
            ("t1", "WH-1", "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", None, 47, "{}"),
        )
        conn.execute("insert into claude_usage (day, subject) values (%s, %s)", (date(2026, 10, 27), "demo:s"))
        conn.execute("update claude_usage set input_tokens = input_tokens + 10 where subject = 'demo:s'")
        conn.execute("delete from claude_usage where subject = 'demo:s'")
        conn.execute("delete from sessions where session_id = %s", (SESSION,))


@pytest.mark.parametrize("table", NEVER_WEB_WRITES)
@pytest.mark.parametrize("statement", ["insert into {} default values", "delete from {}", "select count(*) from {}"])
def test_the_web_role_can_neither_write_nor_read_money_members_or_campaigns(
    server_url: str, schema: str, roles: dict, migrated: Config, table: str, statement: str
) -> None:
    if table in WEB_READ_ONLY and statement.startswith("select"):
        pytest.skip("the webhook's replay check reads this table; writing it is still refused")
    with connect_as(server_url, schema, roles["web"]) as conn, pytest.raises(InsufficientPrivilege):
        conn.execute(sql.SQL(statement).format(sql.Identifier(table)))


@pytest.mark.parametrize(
    "statement",
    [
        "update payout_items set status = status",
        "select count(*) from audit_log",
        "update audit_log set actor = actor",
        "update paypal_events set raw = raw",
        "delete from paypal_events",
        "create table smuggled (id integer)",
        "alter table sessions add column extra text",
        "truncate sessions",
    ],
)
def test_the_web_role_is_refused_everything_else(server_url: str, schema: str, roles: dict, migrated: Config, statement: str) -> None:
    with connect_as(server_url, schema, roles["web"]) as conn, pytest.raises(InsufficientPrivilege):
        conn.execute(statement)


def test_the_web_role_holds_exactly_its_list(server_url: str, schema: str, roles: dict, migrated: Config) -> None:
    tables, on_schema, defaults, attributes, owned, _shape = privileges(server_url, schema, roles["web"])
    writes = {"SELECT", "INSERT", "UPDATE", "DELETE"}
    assert held_by(tables) == {
        "audit_log": {"INSERT"},
        "audit_log_id_seq": {"USAGE"},
        "paypal_events": {"SELECT", "INSERT"},
        "event_outcomes": {"SELECT"},
        "sessions": writes,
        "run_owners": writes,
        "rate_limit_hits": writes,
        "paypal_certs": writes,
        "claude_usage": writes,
    }
    assert (roles["web"], "USAGE") in on_schema and (roles["web"], "CREATE") not in on_schema
    assert defaults == []
    assert attributes == (False, False, False, True, False, False)
    assert owned == (0,)


def test_a_table_a_later_schema_adds_is_the_engines_and_never_the_websites(server_url: str, schema: str, roles: dict, migrated: Config) -> None:
    with admin(server_url, schema) as conn:
        conn.execute("create table added_later (id bigserial primary key, note text)")
    with connect_as(server_url, schema, roles["engine"]) as conn:
        conn.execute("insert into added_later (note) values ('ok')")
    with connect_as(server_url, schema, roles["web"]) as conn, pytest.raises(InsufficientPrivilege):
        conn.execute("select note from added_later")


# Both roles, and the move away from mend_app.


def test_a_second_migrate_keeps_both_roles_and_changes_nothing_else(server_url: str, schema: str, roles: dict, migrated: Config) -> None:
    before = (privileges(server_url, schema, roles["engine"]), privileges(server_url, schema, roles["web"]))
    result = run_migrate(migrated, roles, engine_password=None, web_password=None)
    assert result.roles == {roles["engine"]: "kept", roles["web"]: "kept"}
    assert (privileges(server_url, schema, roles["engine"]), privileges(server_url, schema, roles["web"])) == before


@pytest.mark.parametrize(("missing", "setting"), [("engine_password", "MEND_ENGINE_DB_PASSWORD"), ("web_password", "MEND_WEB_DB_PASSWORD")])
def test_a_real_database_without_a_role_or_its_password_is_refused_before_anything_changes(
    server_url: str, schema: str, roles: dict, missing: str, setting: str
) -> None:
    config = config_for(server_url, schema)
    with pytest.raises(ConfigError, match=setting):
        run_migrate(config, roles, **{missing: None})
    with pytest.raises(ConfigError, match=setting):
        run_migrate(config, roles, **{missing: "too-short"})
    with psycopg.connect(server_url, autocommit=True) as conn:
        assert conn.execute("select count(*) from pg_roles where rolname = any(%s)", ([roles["engine"], roles["web"]],)).fetchone() == (0,)
        assert conn.execute("select count(*) from pg_class where relnamespace = %s::regnamespace", (schema,)).fetchone() == (0,)


def test_the_local_development_database_needs_no_roles(server_url: str, schema: str, roles: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    # Development with no DATABASE_URL means the bundled pgserver; it is pointed at this
    # test's schema here so the shared development schema is left alone.
    config = replace(config_for(server_url, schema), dev=True)
    monkeypatch.setattr(migrate_module, "is_local_development", lambda cfg: True)
    result = run_migrate(config, roles, engine_password=None, web_password=None)
    assert set(result.roles.values()) == {"skipped"}
    with psycopg.connect(server_url, autocommit=True) as conn:
        assert conn.execute("select count(*) from pg_roles where rolname = any(%s)", (list(roles.values()),)).fetchone() == (0,)
        assert conn.execute("select to_regclass(%s) is not null", (f"{schema}.audit_log",)).fetchone() == (True,)


def legacy_role(server_url: str, schema: str, roles: dict) -> None:
    """The old single role, with the grants every service used to share."""
    with admin(server_url, schema) as conn:
        grant_engine_role(conn, PASSWORD, roles["legacy"])


def test_mend_app_is_dropped_only_when_asked_and_no_one_is_connected_as_it(server_url: str, schema: str, roles: dict, migrated: Config) -> None:
    legacy_role(server_url, schema, roles)
    assert run_migrate(migrated, roles, engine_password=None, web_password=None).legacy == "left"
    with connect_as(server_url, schema, roles["legacy"]):
        assert run_migrate(migrated, roles, engine_password=None, web_password=None, drop_legacy=True).legacy == "in use (1 open connections)"
    result = run_migrate(migrated, roles, engine_password=None, web_password=None, drop_legacy=True)
    assert result.legacy == "dropped"
    with psycopg.connect(server_url, autocommit=True) as conn:
        assert conn.execute("select count(*) from pg_roles where rolname = %s", (roles["legacy"],)).fetchone() == (0,)
    assert run_migrate(migrated, roles, engine_password=None, web_password=None, drop_legacy=True).legacy == "absent"
    with connect_as(server_url, schema, roles["engine"]) as conn:
        conn.execute("select count(*) from members")
