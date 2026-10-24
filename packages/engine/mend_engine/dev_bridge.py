"""The local stand-in for Render Workflows, for development and proofs only.

    python -m mend_engine.dev_bridge [--port N]

Render's own local task server cannot run on this Windows Python (it needs Unix
sockets), so the web app reaches the engine's tasks through this small HTTP server
instead when MEND_DEV=1. It listens on 127.0.0.1 only, refuses to start unless
MEND_DEV is on and PAYPAL_ENV is sandbox, and answers only requests that carry the
random token the caller generated into MEND_BRIDGE_TOKEN.

One route: POST /tasks/<name> with {"args": [...]} (at most 64 KB) runs that task
from tasks.TASK_NAMES synchronously and answers with the dict it returns. The first
line on stdout is "dev bridge listening on 127.0.0.1:<port>"; logs go to stderr.
"""

from __future__ import annotations

import argparse
import hmac
import inspect
import json
import os
import re
import sys
from collections.abc import Callable, Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psycopg

from mend_engine import tasks
from mend_engine.config import ConfigError, load_config
from mend_engine.db.migrate import migrate

HOST = "127.0.0.1"
TOKEN_HEADER = "X-Mend-Bridge-Token"
MAX_BODY_BYTES = 64 * 1024
MIN_TOKEN_CHARS = 32
REQUEST_TIMEOUT_SECONDS = 30
ENV_PATH = Path(__file__).resolve().parents[3] / ".env"

_TASK_PATH = re.compile(r"/tasks/([a-z_]{1,40})", re.ASCII)
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


def _no_repeats(pairs: list) -> dict:
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError("repeated key")
    return dict(pairs)


def _refuse_constant(name: str) -> None:
    raise ValueError(f"{name} is not JSON")


def make_handler(token: str, registry: Mapping[str, Callable[..., dict]]) -> type[BaseHTTPRequestHandler]:
    """A request handler class bound to one token and one fixed task registry."""
    expected = token.encode("ascii")

    class Handler(BaseHTTPRequestHandler):
        timeout = REQUEST_TIMEOUT_SECONDS
        server_version = "mend-dev-bridge"
        sys_version = ""

        def do_POST(self) -> None:
            # The token is checked before the path or body is looked at.
            given = self.headers.get(TOKEN_HEADER, "")
            if not hmac.compare_digest(given.encode("utf-8", "replace"), expected):
                self._answer(401, {"error": "unauthorised"})
                return
            match = _TASK_PATH.fullmatch(self.path)
            task = registry.get(match.group(1)) if match else None
            if match is None or task is None:
                self._answer(404, {"error": "no such task"})
                return
            length = self.headers.get("Content-Length", "")
            if not length.isascii() or not length.isdigit():
                self._answer(411, {"error": "a Content-Length is required"})
                return
            if int(length) > MAX_BODY_BYTES:
                self._answer(413, {"error": "body too large"})
                return
            try:
                body = json.loads(
                    self.rfile.read(int(length)).decode("utf-8"),
                    object_pairs_hook=_no_repeats,
                    parse_constant=_refuse_constant,
                )
            except (UnicodeDecodeError, ValueError, RecursionError):
                self._answer(400, {"error": "body is not strict JSON"})
                return
            if type(body) is not dict or set(body) != {"args"} or type(body["args"]) is not list:
                self._answer(400, {"error": 'body must be {"args": [...]}'})
                return
            try:
                inspect.signature(task).bind(*body["args"])
            except TypeError:
                self._answer(400, {"error": "wrong number of arguments for this task"})
                return
            try:
                result = task(*body["args"])
            except Exception:
                # Tasks turn every failure into a dict themselves; this is the last fence.
                self._answer(500, {"error": "the task failed"}, task=match.group(1))
                return
            if type(result) is not dict:
                self._answer(500, {"error": "the task did not answer with an object"}, task=match.group(1))
                return
            self._answer(200, result, task=match.group(1))

        def do_GET(self) -> None:
            self._answer(405, {"error": "use POST"})

        do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = do_GET

        def _answer(self, status: int, body: object, task: str | None = None) -> None:
            data = json.dumps(body, allow_nan=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)
            _log({"kind": "dev_bridge", "status": status, "task": task})

        def log_message(self, format: str, *args: object) -> None:
            # http.server's own access line is replaced by the JSON line in _answer.
            return

    return Handler


def _log(record: dict) -> None:
    sys.stderr.write(json.dumps(record) + "\n")
    sys.stderr.flush()


def task_registry() -> dict[str, Callable[..., dict]]:
    """Every task the bridge will run, by name: exactly tasks.TASK_NAMES, nothing looked up from a request."""
    return {name: getattr(tasks, name) for name in tasks.TASK_NAMES}


def build_server(port: int, token: str, registry: Mapping[str, Callable[..., dict]] | None = None) -> ThreadingHTTPServer:
    """A server bound to 127.0.0.1:port (0 picks a free port), not yet serving."""
    tasks_by_name = registry if registry is not None else task_registry()
    server = ThreadingHTTPServer((HOST, port), make_handler(token, tasks_by_name))
    server.daemon_threads = True
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m mend_engine.dev_bridge", description="Local stand-in for Render Workflows.")
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
