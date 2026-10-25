"""The engine's task server on Render: the production twin of the dev bridge.

    python -m mend_engine.task_server

Runs as the private service mend-engine, which Render puts on its private network only:
it has no public address, and only Mend's own services can reach it. It binds 0.0.0.0
on $PORT (10000, Render's default, when PORT is unset) and refuses to start unless
PAYPAL_ENV is exactly "sandbox" (C16), DATABASE_URL is set, and MEND_ENGINE_TOKEN is
at least 32 printable characters with no spaces. It never applies the schema: the
deploy runs python -m mend_engine.db.migrate once, and tasks only check that the schema
is in place (C22).

    GET  /health        answers "ok" without the token, so a probe can see the server is up
    POST /tasks/<name>  {"args": [...]} (at most 64 KB) runs that task from
                        tasks.TASK_NAMES synchronously and answers with the dict it returns

Every other request needs the x-mend-engine-token header, compared in constant time
before the path or body is looked at. At most 16 tasks run at once, so a burst cannot
use up the database's connections; a request that waits 60 seconds for a slot is
answered 503. The dispatch code is shared with the dev bridge (make_task_handler), so
what runs locally is what runs on Render. Logs are JSON lines on stderr.
"""

from __future__ import annotations

import argparse
import hmac
import inspect
import json
import os
import re
import sys
import threading
from collections.abc import Callable, Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mend_engine import tasks
from mend_engine.config import ConfigError, load_config

HOST = "0.0.0.0"
DEFAULT_PORT = 10000
TOKEN_HEADER = "X-Mend-Engine-Token"
HEALTH_PATH = "/health"
MAX_BODY_BYTES = 64 * 1024
MIN_TOKEN_BYTES = 32
REQUEST_TIMEOUT_SECONDS = 30
# The database allows 100 connections (Render basic_256mb); each running task holds one.
MAX_RUNNING_TASKS = 16
SLOT_WAIT_SECONDS = 60

_TASK_PATH = re.compile(r"/tasks/([a-z_]{1,40})", re.ASCII)
_TOKEN_SHAPE = re.compile(r"[\x21-\x7e]+", re.ASCII)
_PORT = re.compile(r"[0-9]{1,5}", re.ASCII)


class ServerRefused(Exception):
    """The task server will not start. The message names the setting, never its value."""


def server_settings(env: Mapping[str, str]) -> tuple[str, int]:
    """(token, port) once the environment allows the server to run.

    Raises ServerRefused unless load_config accepts the process environment (PAYPAL_ENV
    exactly "sandbox", both PayPal keys, the three caps), DATABASE_URL is set,
    MEND_ENGINE_TOKEN is at least 32 printable characters with no spaces, and PORT, when
    set, is a whole number from 1 to 65535. No .env file is read: on Render the settings
    come from the service's own environment only.
    """
    try:
        config = load_config(None)
    except ConfigError as exc:
        raise ServerRefused(str(exc)) from None
    if not config.database_url:
        raise ServerRefused("DATABASE_URL must be set")
    token = env.get("MEND_ENGINE_TOKEN", "")
    if len(token.encode("utf-8")) < MIN_TOKEN_BYTES or not _TOKEN_SHAPE.fullmatch(token):
        raise ServerRefused(f"MEND_ENGINE_TOKEN must be at least {MIN_TOKEN_BYTES} printable characters with no spaces")
    port_text = env.get("PORT", str(DEFAULT_PORT))
    if not _PORT.fullmatch(port_text) or not 1 <= int(port_text) <= 65535:
        raise ServerRefused("PORT must be a whole number from 1 to 65535")
    return token, int(port_text)


def _no_repeats(pairs: list) -> dict:
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError("repeated key")
    return dict(pairs)


def _refuse_constant(name: str) -> None:
    raise ValueError(f"{name} is not JSON")


def _log(record: dict) -> None:
    sys.stderr.write(json.dumps(record) + "\n")
    sys.stderr.flush()


def make_task_handler(
    token: str,
    registry: Mapping[str, Callable[..., dict]],
    *,
    token_header: str,
    server_name: str,
    log_kind: str,
    health_path: str | None = None,
    slots: threading.BoundedSemaphore | None = None,
    slot_wait_seconds: float = SLOT_WAIT_SECONDS,
) -> type[BaseHTTPRequestHandler]:
    """A request handler class bound to one token, one fixed task registry and one set of names.

    POST /tasks/<name> with exactly {"args": [...]}, strict JSON of at most 64 KB and the
    right number of arguments, runs that task and answers 200 with its dict. In order:
    a wrong or missing token gets 401, an unknown path or task 404, no Content-Length
    411, a longer body 413 (before it is read), a body that breaks those rules 400, a
    task that raises or answers with something other than a dict 500. With slots, a
    task waits up to slot_wait_seconds for one and is otherwise answered 503 without
    running. A GET of health_path answers "ok" with no token; any other method gets
    401 without the token and 405 with it. The token itself is never logged.
    """
    expected = token.encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        timeout = REQUEST_TIMEOUT_SECONDS
        server_version = server_name
        sys_version = ""

        def do_POST(self) -> None:
            if not self._token_matches():
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
            if slots is not None and not slots.acquire(timeout=slot_wait_seconds):
                self._answer(503, {"error": "busy"}, task=match.group(1))
                return
            try:
                result = task(*body["args"])
            except Exception:
                # Tasks turn every failure into a dict themselves; this is the last fence.
                self._answer(500, {"error": "the task failed"}, task=match.group(1))
                return
            finally:
                if slots is not None:
                    slots.release()
            if type(result) is not dict:
                self._answer(500, {"error": "the task did not answer with an object"}, task=match.group(1))
                return
            self._answer(200, result, task=match.group(1))

        def do_GET(self) -> None:
            if health_path is not None and self.path == health_path:
                self._send(200, b"ok", "text/plain; charset=utf-8")
                _log({"kind": log_kind, "status": 200, "task": None})
                return
            if not self._token_matches():
                return
            self._answer(405, {"error": "use POST"})

        do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = do_GET

        def _token_matches(self) -> bool:
            given = self.headers.get(token_header, "")
            if hmac.compare_digest(given.encode("utf-8", "replace"), expected):
                return True
            self._answer(401, {"error": "unauthorised"})
            return False

        def _answer(self, status: int, body: object, task: str | None = None) -> None:
            self._send(status, json.dumps(body, allow_nan=False).encode("utf-8"), "application/json")
            _log({"kind": log_kind, "status": status, "task": task})

        def _send(self, status: int, data: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)

        def log_message(self, format: str, *args: object) -> None:
            # http.server's own access line is replaced by the JSON line in _answer.
            return

    return Handler


def task_registry() -> dict[str, Callable[..., dict]]:
    """Every task a server will run, by name: exactly tasks.TASK_NAMES, nothing looked up from a request."""
    return {name: getattr(tasks, name) for name in tasks.TASK_NAMES}


def build_server(
    port: int,
    token: str,
    registry: Mapping[str, Callable[..., dict]] | None = None,
    *,
    slot_wait_seconds: float = SLOT_WAIT_SECONDS,
) -> ThreadingHTTPServer:
    """A server bound to 0.0.0.0:port (0 picks a free port), not yet serving."""
    handler = make_task_handler(
        token,
        registry if registry is not None else task_registry(),
        token_header=TOKEN_HEADER,
        server_name="mend-task-server",
        log_kind="task_server",
        health_path=HEALTH_PATH,
        slots=threading.BoundedSemaphore(MAX_RUNNING_TASKS),
        slot_wait_seconds=slot_wait_seconds,
    )
    server = ThreadingHTTPServer((HOST, port), handler)
    server.daemon_threads = True
    return server


def main(argv: list[str] | None = None) -> int:
    argparse.ArgumentParser(prog="python -m mend_engine.task_server", description="Serve the engine's tasks on Render's private network.").parse_args(argv)
    try:
        token, port = server_settings(os.environ)
    except ServerRefused as exc:
        print(f"task_server: {exc}", file=sys.stderr)
        return 2
    server = build_server(port, token)
    print(f"task server listening on {HOST}:{server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
