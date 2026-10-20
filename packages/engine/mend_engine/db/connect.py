"""Database connection: DATABASE_URL when set, otherwise a local pgserver in dev only."""

from __future__ import annotations

from pathlib import Path

import psycopg

from mend_engine.config import Config, ConfigError

PGDATA = Path(__file__).resolve().parents[2] / ".pgdata"
SCHEMA_PATH = Path(__file__).with_name("schema.sql")
CONNECT_TIMEOUT_SECONDS = 15

# pgserver stops Postgres when its handle is garbage collected or the process
# exits, so the handle is kept for the life of the process.
_local_servers: list[object] = []


def _local_url() -> str:
    import pgserver

    server = pgserver.get_server(PGDATA)
    _local_servers.append(server)
    return server.get_uri()


def connect(config: Config) -> psycopg.Connection:
    """Open a connection and apply the schema (idempotent).

    Uses config.database_url if set. Otherwise, only when config.dev is true,
    starts or reuses the local pgserver at packages/engine/.pgdata. Raises
    ConfigError when neither applies.
    """
    if config.database_url:
        url = config.database_url
    elif config.dev:
        url = _local_url()
    else:
        raise ConfigError("DATABASE_URL is not set and MEND_DEV is off")
    # Autocommit, so every "with conn.transaction()" is a real BEGIN and COMMIT.
    # Without it, any bare query opens an implicit transaction, later blocks turn
    # into savepoints inside it, and close() silently rolls all of them back.
    conn = psycopg.connect(url, connect_timeout=CONNECT_TIMEOUT_SECONDS, autocommit=True)
    with conn.transaction():
        conn.execute(SCHEMA_PATH.read_text(encoding="utf-8"))
    return conn
