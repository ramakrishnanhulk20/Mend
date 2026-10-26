# Not covered here: the role on Render's Postgres, where the owner has CREATEROLE but is not
# a superuser (the live proof, node scripts/deploy/render.mjs prove, attacks it there), and
# password checks: the local pgserver trusts local logins, so a wrong password would still
# connect. Each test uses its own role name, because roles belong to the whole cluster.
import uuid
from collections.abc import Iterator
from dataclasses import replace
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

import pgserver
import psycopg
import pytest
from psycopg import sql
from psycopg.errors import InsufficientPrivilege
from psycopg.types.json import Jsonb

from mend_engine.config import SANDBOX_API_HOST, Config, ConfigError
from mend_engine.db.connect import PGDATA
from mend_engine.db.migrate import migrate

PASSWORD = "app-role-test-password-0123456789abcdef"


@pytest.fixture(scope="module")
def server_url() -> str:
    return pgserver.get_server(PGDATA).get_uri()


@pytest.fixture
def schema(server_url: str) -> Iterator[str]:
    name = "app_role_" + uuid.uuid4().hex[:12]
    with psycopg.connect(server_url, autocommit=True) as admin:
        admin.execute(sql.SQL("create schema {}").format(sql.Identifier(name)))
        try:
            yield name
        finally:
            admin.execute(sql.SQL("drop schema {} cascade").format(sql.Identifier(name)))


@pytest.fixture
def role(server_url: str, schema: str) -> Iterator[str]:
    """A role name of this test's own; whatever it was granted is dropped with it."""
    name = "mend_app_" + uuid.uuid4().hex[:12]
    try:
        yield name
    finally:
        with psycopg.connect(server_url, autocommit=True) as admin:
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


@pytest.fixture
def migrated(server_url: str, schema: str, role: str) -> Config:
    config = config_for(server_url, schema)
    migrate(config, app_password=PASSWORD, role=role)
    return config


def as_app(server_url: str, schema: str, role: str) -> psycopg.Connection:
    return psycopg.connect(server_url, user=role, password=PASSWORD, autocommit=True, options=f"-c search_path={schema}")


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
def test_the_app_role_cannot_change_the_schema_or_the_audit_log(server_url: str, schema: str, role: str, migrated: Config, statement: str) -> None:
    with as_app(server_url, schema, role) as conn:
        conn.execute("insert into audit_log (actor, action, detail) values ('test', 'kept', '{}')")
        with pytest.raises(InsufficientPrivilege):
            conn.execute(statement)
    with psycopg.connect(server_url, autocommit=True, options=f"-c search_path={schema}") as admin:
        assert admin.execute("select count(*) from audit_log where action = 'kept'").fetchone()[0] == 1
        assert admin.execute("select count(*) from pg_trigger where tgrelid = 'audit_log'::regclass and tgenabled = 'D'").fetchone()[0] == 0


def test_the_app_role_appends_to_the_audit_log_and_reads_and_writes_the_other_tables(
    server_url: str, schema: str, role: str, migrated: Config
) -> None:
    with as_app(server_url, schema, role) as conn:
        conn.execute("insert into audit_log (actor, action, detail) values (%s, %s, %s)", ("test", "app_wrote", Jsonb({"n": 1})))
        assert conn.execute("select actor from audit_log where action = 'app_wrote'").fetchone() == ("test",)
        conn.execute("insert into shop_customers values ('C1', 'Ann B.', 'c1@shop.example', 'UK')")
        conn.execute("update shop_customers set country = 'FR' where customer_ref = 'C1'")
        assert conn.execute("select country from shop_customers").fetchone() == ("FR",)
        # The status trigger writes campaign_status_moves as the app role, through a sequence-free table.
        campaign = conn.execute(
            "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
            "values ('Shop', 'goal', '2026-10-16', 100, 10, 0.5, 'draft') returning campaign_id"
        ).fetchone()[0]
        assert conn.execute("select to_status from campaign_status_moves where campaign_id = %s", (campaign,)).fetchone() == ("draft",)
        conn.execute("insert into import_runs (source, source_bytes, lines_read, lines_kept, week_shift) values ('t', 1, 1, 1, 0)")
        conn.execute("delete from shop_customers where customer_ref = 'C1'")
        assert conn.execute("select count(*) from shop_customers").fetchone() == (0,)


def privileges(server_url: str, schema: str, role: str) -> tuple:
    """Everything the role holds and is, read from the catalog, in a fixed order."""
    with psycopg.connect(server_url, autocommit=True) as admin:
        tables = admin.execute(
            "select c.relname, a.privilege_type from pg_class c cross join lateral aclexplode(c.relacl) a "
            "where c.relnamespace = %s::regnamespace and a.grantee = %s::regrole order by 1, 2",
            (schema, role),
        ).fetchall()
        on_schema = admin.execute(
            "select a.grantee::regrole::text, a.privilege_type from pg_namespace n cross join lateral aclexplode(n.nspacl) a "
            "where n.nspname = %s order by 1, 2",
            (schema,),
        ).fetchall()
        defaults = admin.execute(
            "select d.defaclobjtype, a.privilege_type from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a "
            "where d.defaclnamespace = %s::regnamespace and a.grantee = %s::regrole order by 1, 2",
            (schema, role),
        ).fetchall()
        attributes = admin.execute(
            "select rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls from pg_roles where rolname = %s",
            (role,),
        ).fetchone()
        owned = admin.execute(
            "select count(*) from pg_class where relnamespace = %s::regnamespace and relowner = %s::regrole", (schema, role)
        ).fetchone()
        shape = admin.execute(
            "select (select count(*) from pg_class where relnamespace = %s::regnamespace), "
            "(select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = %s::regnamespace and not t.tgisinternal)",
            (schema, schema),
        ).fetchone()
    return tables, on_schema, defaults, attributes, owned, shape


def test_the_app_role_holds_exactly_the_privileges_the_services_need(server_url: str, schema: str, role: str, migrated: Config) -> None:
    tables, on_schema, defaults, attributes, owned, _shape = privileges(server_url, schema, role)
    held = {}
    for table, privilege in tables:
        held.setdefault(table, set()).add(privilege)
    assert held.pop("audit_log") == {"SELECT", "INSERT"}
    sequences = {name for name, kinds in held.items() if kinds == {"SELECT", "USAGE"}}
    assert sequences and all(name.endswith("_seq") for name in sequences)
    assert all(held[name] == {"SELECT", "INSERT", "UPDATE", "DELETE"} for name in held if name not in sequences)
    assert (role, "USAGE") in on_schema and (role, "CREATE") not in on_schema and ("-", "CREATE") not in on_schema
    assert defaults == [("S", "SELECT"), ("S", "USAGE"), ("r", "DELETE"), ("r", "INSERT"), ("r", "SELECT"), ("r", "UPDATE")]
    assert attributes == (False, False, False, True, False, False)
    assert owned == (0,)


def test_a_second_migrate_keeps_the_grants_and_changes_nothing_else(server_url: str, schema: str, role: str, migrated: Config) -> None:
    before = privileges(server_url, schema, role)
    migrate(migrated, app_password=PASSWORD, role=role)
    migrate(migrated, app_password=None, role=role)
    assert privileges(server_url, schema, role) == before


def test_a_table_a_later_schema_adds_is_covered_by_the_default_privileges(server_url: str, schema: str, role: str, migrated: Config) -> None:
    with psycopg.connect(server_url, autocommit=True, options=f"-c search_path={schema}") as admin:
        admin.execute("create table added_later (id bigserial primary key, note text)")
    with as_app(server_url, schema, role) as conn:
        conn.execute("insert into added_later (note) values ('ok')")
        assert conn.execute("select note from added_later").fetchone() == ("ok",)


def test_a_real_database_without_the_role_or_a_password_is_refused_before_anything_changes(server_url: str, schema: str, role: str) -> None:
    config = config_for(server_url, schema)
    with pytest.raises(ConfigError, match="MEND_APP_DB_PASSWORD"):
        migrate(config, app_password=None, role=role)
    with pytest.raises(ConfigError, match="MEND_APP_DB_PASSWORD"):
        migrate(config, app_password="too-short", role=role)
    with psycopg.connect(server_url, autocommit=True) as admin:
        assert admin.execute("select count(*) from pg_roles where rolname = %s", (role,)).fetchone() == (0,)
        assert admin.execute("select count(*) from pg_class where relnamespace = %s::regnamespace", (schema,)).fetchone() == (0,)


def test_the_local_development_database_needs_no_role(server_url: str, schema: str, role: str, monkeypatch: pytest.MonkeyPatch) -> None:
    # Development with no DATABASE_URL means the bundled pgserver; it is pointed at this
    # test's schema here so the shared development schema is left alone.
    config = replace(config_for(server_url, schema), dev=True)
    monkeypatch.setattr("mend_engine.db.migrate.is_local_development", lambda cfg: True)
    migrate(config, app_password=None, role=role)
    with psycopg.connect(server_url, autocommit=True) as admin:
        assert admin.execute("select count(*) from pg_roles where rolname = %s", (role,)).fetchone() == (0,)
        assert admin.execute("select to_regclass(%s) is not null", (f"{schema}.audit_log",)).fetchone() == (True,)
