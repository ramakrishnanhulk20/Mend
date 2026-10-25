"""The local stand-in for the engine's task server, for development and proofs only.

    python -m mend_engine.dev_bridge [--port N]

With MEND_DEV=1 the web app reaches the engine's tasks through this small HTTP server
on this machine instead of mend-engine on Render. It listens on 127.0.0.1 only, refuses to start unless
MEND_DEV is on and PAYPAL_ENV is sandbox, and answers only requests that carry the
random token the caller generated into MEND_BRIDGE_TOKEN.

One route: POST /tasks/<name> with {"args": [...]} (at most 64 KB) runs that task
from tasks.TASK_NAMES synchronously and answers with the dict it returns. The first
line on stdout is "dev bridge listening on 127.0.0.1:<port>"; logs go to stderr. The
request handling is task_server's, shared with the engine's server on Render.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections.abc import Callable, Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psycopg

from mend_engine.config import ConfigError, load_config
from mend_engine.db.migrate import migrate
from mend_engine.task_server import MAX_BODY_BYTES, make_task_handler, task_registry

__all__ = ["MAX_BODY_BYTES", "TOKEN_HEADER", "BridgeRefused", "bridge_token", "build_server", "main", "make_handler", "task_registry"]

HOST = "127.0.0.1"
TOKEN_HEADER = "X-Mend-Bridge-Token"
MIN_TOKEN_CHARS = 32
ENV_PATH = Path(__file__).resolve().parents[3] / ".env"

_TOKEN_SHAPE = re.compile(r"[\x21-\x7e]+", re.ASCII)


class BridgeRefused(Exception):
    """The bridge will not start. The message names the setting, never its value."""


def bridge_token(env: Mapping[str, str], env_path: str | None) -> str:
    """The token every request must carry, once the environment allows the bridge to run.

    Raises BridgeRefused unless MEND_DEV is on, PAYPAL_ENV is exactly "sandbox" (both
    through load_config, so the process environment wins over the .env file), and
    MEND_BRIDGE_TOKEN is at least 32 printable characters with no spaces. The token
    is read from the environment only, never from the .env file, because the caller
    generates a new one for each run.
    """
    try:
        config = load_config(env_path)
    except ConfigError as exc:
        raise BridgeRefused(str(exc)) from None
    if not config.dev:
        raise BridgeRefused("MEND_DEV must be on: the bridge is for local development only")
    token = env.get("MEND_BRIDGE_TOKEN", "")
    if len(token) < MIN_TOKEN_CHARS or not _TOKEN_SHAPE.fullmatch(token):
        raise BridgeRefused(f"MEND_BRIDGE_TOKEN must be at least {MIN_TOKEN_CHARS} printable characters with no spaces")
    return token


def make_handler(token: str, registry: Mapping[str, Callable[..., dict]]) -> type[BaseHTTPRequestHandler]:
    """A request handler class bound to one token and one fixed task registry, under the bridge's own header."""
    return make_task_handler(token, registry, token_header=TOKEN_HEADER, server_name="mend-dev-bridge", log_kind="dev_bridge")


def build_server(port: int, token: str, registry: Mapping[str, Callable[..., dict]] | None = None) -> ThreadingHTTPServer:
    """A server bound to 127.0.0.1:port (0 picks a free port), not yet serving."""
    tasks_by_name = registry if registry is not None else task_registry()
    server = ThreadingHTTPServer((HOST, port), make_handler(token, tasks_by_name))
    server.daemon_threads = True
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m mend_engine.dev_bridge", description="Local stand-in for the engine's task server.")
    parser.add_argument("--port", type=int, default=8765, help="port on 127.0.0.1; 0 picks a free one")
    args = parser.parse_args(argv)
    try:
        token = bridge_token(os.environ, str(ENV_PATH) if ENV_PATH.is_file() else None)
    except BridgeRefused as exc:
        print(f"dev_bridge: {exc}", file=sys.stderr)
        return 2
    # Development only (bridge_token refused otherwise): the schema is applied once here,
    # because tasks never apply it themselves.
    try:
        migrate(load_config(str(ENV_PATH) if ENV_PATH.is_file() else None))
    except (ConfigError, psycopg.Error) as exc:
        print(f"dev_bridge: the schema could not be applied ({type(exc).__name__})", file=sys.stderr)
        return 2
    server = build_server(args.port, token)
    print(f"dev bridge listening on {HOST}:{server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
