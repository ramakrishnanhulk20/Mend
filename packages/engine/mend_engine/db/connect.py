"""Database connection: DATABASE_URL when set, otherwise a local pgserver in dev only.

connect() never changes the database's structure (C22). schema.sql is applied only by
mend_engine.db.migrate: on deploy, by the dev bridge and dev_url at start in
development, and by the proof scripts and test fixtures. Re-applying it here on every
connection used to drop and recreate triggers under concurrent writes, which took
ACCESS EXCLUSIVE locks and deadlocked with them.
"""

from __future__ import annotations

import threading
from pathlib import Path

import psycopg

from mend_engine.config import Config, ConfigError

PGDATA = Path(__file__).resolve().parents[2] / ".pgdata"
SCHEMA_PATH = Path(__file__).with_name("schema.sql")
CONNECT_TIMEOUT_SECONDS = 15
SCHEMA_MISSING = "schema missing: run python -m mend_engine.db.migrate"

# pgserver stops Postgres when its handle is garbage collected or the process
# exits, so the handle is kept for the life of the process.
_local_servers: list[object] = []

# Database URLs whose schema this process has already found in place. A URL carries
# its search_path, so each schema a test or proof points at is checked on its own.
_checked: set[str] = set()
_checked_lock = threading.Lock()

# Objects from across the schema's history, so a database migrated from an older
# schema.sql is refused as well as an empty one.
_SCHEMA_PRESENT = """
select to_regclass('approved_snapshots') is not null
   and to_regclass('campaign_owners') is not null
   and to_regclass('sessions') is not null
   and exists (
       select 1 from pg_trigger
        where tgrelid = to_regclass('campaigns') and tgname = 'campaigns_status_guard' and not tgisinternal
   )
"""


def _local_url() -> str:
    import pgserver

    server = pgserver.get_server(PGDATA)
    _local_servers.append(server)
    return server.get_uri()


def database_url(config: Config) -> str:
    """config.database_url if set; otherwise, only when config.dev is true, the local pgserver's. Raises ConfigError when neither applies."""
    if config.database_url:
        return config.database_url
    if config.dev:
        return _local_url()
    raise ConfigError("DATABASE_URL is not set and MEND_DEV is off")


def open_connection(config: Config) -> psycopg.Connection:
    """An autocommit connection with no check that the schema is there. For migrate only."""
    # Autocommit, so every "with conn.transaction()" is a real BEGIN and COMMIT.
    # Without it, any bare query opens an implicit transaction, later blocks turn
    # into savepoints inside it, and close() silently rolls all of them back.
    return psycopg.connect(database_url(config), connect_timeout=CONNECT_TIMEOUT_SECONDS, autocommit=True)


def connect(config: Config) -> psycopg.Connection:
    """Open an autocommit connection to a database whose schema is already in place.

    Uses config.database_url if set, otherwise (dev only) the local pgserver. The
    first connection to each URL in this process reads the catalog to confirm the
    schema is there; it runs no DDL. Raises ConfigError when no database is
    configured, or SCHEMA_MISSING when the schema has not been applied.
    """
    url = database_url(config)
    conn = psycopg.connect(url, connect_timeout=CONNECT_TIMEOUT_SECONDS, autocommit=True)
    with _checked_lock:
        known = url in _checked
    if not known:
        try:
            present = conn.execute(_SCHEMA_PRESENT).fetchone()[0]
        except Exception:
            conn.close()
            raise
        if not present:
            conn.close()
            raise ConfigError(SCHEMA_MISSING)
        with _checked_lock:
            _checked.add(url)
    return conn
