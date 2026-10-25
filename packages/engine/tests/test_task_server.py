# Not covered here: the real tasks behind the server (test_tasks.py), the web app's client
# for it (packages/web engine.test.ts), and Render's private network itself: the live
# proof (node scripts/deploy/render.mjs prove) checks that mend-engine has no public
# address. Traffic on that network is plain http, so nothing here tests TLS.
import http.client
import json
import os
import threading
from collections.abc import Iterator

import pytest

from mend_engine import task_server, tasks
from mend_engine.db import migrate
from mend_engine.dev_bridge import TOKEN_HEADER as BRIDGE_HEADER
from mend_engine.task_server import HEALTH_PATH, MAX_BODY_BYTES, TOKEN_HEADER, ServerRefused, build_server, server_settings, task_registry

TOKEN = "e" * 48
SECRET = "csecret-for-task-server-tests"
ENV = {
    "PAYPAL_ENV": "sandbox",
    "PAYPAL_CLIENT_ID": "cid",
    "PAYPAL_CLIENT_SECRET": SECRET,
    "DATABASE_URL": "postgresql://mend:pw@dpg-test-a/mend",
    "MEND_PAYOUT_ITEM_CAP_MINOR": "1000",
    "MEND_CAMPAIGN_CAP_MINOR": "10000",
    "MEND_DAILY_CAP_MINOR": "20000",
    "MEND_ENGINE_TOKEN": TOKEN,
}


@pytest.fixture
def environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("MEND_DEV", "PORT", "MEND_TEST_RECEIVER"):
        monkeypatch.delenv(name, raising=False)
    for name, value in ENV.items():
        monkeypatch.setenv(name, value)


@pytest.fixture
def calls() -> list:
    return []


def serve(server: object) -> threading.Thread:
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return thread


@pytest.fixture
def port(calls: list) -> Iterator[int]:
    def echo(value: object) -> dict:
        calls.append(value)
        return {"ok": True, "echo": value}

    server = build_server(0, TOKEN, {"echo": echo})
    serve(server)
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()


def request(port: int, method: str, path: str, body: bytes | None = None, headers: dict[str, str] | None = None) -> tuple[int, bytes]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        connection.putrequest(method, path)
        for name, value in (headers or {}).items():
            connection.putheader(name, value)
        connection.endheaders(body)
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def call(port: int, body: object, *, token: str | None = TOKEN, header: str = TOKEN_HEADER, path: str = "/tasks/echo") -> tuple[int, dict]:
    data = body if isinstance(body, bytes) else json.dumps(body).encode()
    headers = {"Content-Type": "application/json", "Content-Length": str(len(data))}
    if token is not None:
        headers[header] = token
    status, answer = request(port, "POST", path, data, headers)
    return status, json.loads(answer)


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("PAYPAL_ENV", "live"),
        ("DATABASE_URL", None),
        ("MEND_ENGINE_TOKEN", None),
        ("MEND_ENGINE_TOKEN", "e" * 31),
        ("MEND_ENGINE_TOKEN", "e" * 20 + " " + "e" * 20),
        ("MEND_ENGINE_TOKEN", "é" * 32),
        ("PORT", "0"),
        ("PORT", "65536"),
        ("PORT", "80a"),
        ("PORT", " 8080"),
    ],
)
def test_the_server_refuses_to_start_without_sandbox_a_database_a_long_token_and_a_real_port(
    environment: None, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], name: str, value: str | None
) -> None:
    if value is None:
        monkeypatch.delenv(name)
    else:
        monkeypatch.setenv(name, value)
    with pytest.raises(ServerRefused):
        server_settings(os.environ)
    assert task_server.main([]) == 2
    printed = capsys.readouterr()
    assert SECRET not in printed.err + printed.out and TOKEN not in printed.err + printed.out


def test_a_sandbox_environment_with_a_database_and_a_long_token_starts_on_port_10000_or_port(
    environment: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert server_settings(os.environ) == (TOKEN, 10000)
    monkeypatch.setenv("PORT", "8080")
    assert server_settings(os.environ) == (TOKEN, 8080)


def test_the_server_listens_on_every_address_so_the_private_network_reaches_it() -> None:
    server = build_server(0, TOKEN, {})
    try:
        assert server.server_address[0] == "0.0.0.0"
    finally:
        server.server_close()


def test_health_answers_ok_without_the_token_and_nothing_else_does(port: int, calls: list) -> None:
    assert request(port, "GET", HEALTH_PATH) == (200, b"ok")
    assert request(port, "POST", HEALTH_PATH, b"{}", {"Content-Length": "2"})[0] == 401
    assert request(port, "GET", "/tasks/echo")[0] == 401
    assert request(port, "GET", "/tasks/echo", headers={TOKEN_HEADER: TOKEN})[0] == 405
    assert calls == []


@pytest.mark.parametrize("token", [None, "", TOKEN[:-1], TOKEN + "x", "f" * 48])
def test_every_task_call_needs_the_exact_engine_token(port: int, calls: list, token: str | None) -> None:
    assert call(port, {"args": [1]}, token=token) == (401, {"error": "unauthorised"})
    assert calls == []


def test_the_dev_bridge_header_is_not_accepted(port: int, calls: list) -> None:
    assert call(port, {"args": [1]}, header=BRIDGE_HEADER) == (401, {"error": "unauthorised"})
    assert calls == []


def test_a_task_runs_with_its_arguments_and_its_dict_comes_back(port: int, calls: list) -> None:
    assert call(port, {"args": [{"campaign": "x", "n": 3}]}) == (200, {"ok": True, "echo": {"campaign": "x", "n": 3}})
    assert calls == [{"campaign": "x", "n": 3}]


def test_a_body_over_64_kb_is_refused_before_it_is_read(port: int, calls: list) -> None:
    status, body = request(port, "POST", "/tasks/echo", None, {TOKEN_HEADER: TOKEN, "Content-Length": str(MAX_BODY_BYTES + 1)})
    assert (status, json.loads(body)) == (413, {"error": "body too large"}) and calls == []


def test_a_task_that_waits_too_long_for_a_free_slot_is_refused_without_running(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(task_server, "MAX_RUNNING_TASKS", 1)
    started, release, ran = threading.Event(), threading.Event(), []

    def slow(value: object) -> dict:
        ran.append(value)
        started.set()
        release.wait(10)
        return {"ok": True}

    server = build_server(0, TOKEN, {"slow": slow}, slot_wait_seconds=0.2)
    serve(server)
    port = server.server_address[1]
    try:
        first: list = []
        holder = threading.Thread(target=lambda: first.append(call(port, {"args": [1]}, path="/tasks/slow")))
        holder.start()
        assert started.wait(10)
        assert call(port, {"args": [2]}, path="/tasks/slow") == (503, {"error": "busy"})
        release.set()
        holder.join(10)
        assert first == [(200, {"ok": True})] and ran == [1]
    finally:
        release.set()
        server.shutdown()
        server.server_close()


def test_the_token_never_reaches_the_log(port: int, capsys: pytest.CaptureFixture[str]) -> None:
    call(port, {"args": [1]})
    call(port, {"args": [1]}, token=TOKEN + "x")
    logged = capsys.readouterr().err
    assert '"status": 200' in logged and '"status": 401' in logged
    assert TOKEN not in logged


def test_starting_never_applies_the_schema(environment: None, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    def refuse(*_args: object) -> None:
        raise AssertionError("the task server must not apply the schema")

    class Stub:
        server_address = ("0.0.0.0", 10000)

        def serve_forever(self) -> None:
            raise KeyboardInterrupt

        def server_close(self) -> None:
            return

    monkeypatch.setattr(migrate, "migrate", refuse)
    monkeypatch.setattr(migrate, "apply_schema", refuse)
    monkeypatch.setattr(task_server, "build_server", lambda port, token: Stub())
    assert task_server.main([]) == 0
    assert capsys.readouterr().out.splitlines()[0] == "task server listening on 0.0.0.0:10000"


def test_the_default_registry_is_exactly_the_engine_tasks() -> None:
    registry = task_registry()
    assert sorted(registry) == sorted(tasks.TASK_NAMES)
    assert all(registry[name] is getattr(tasks, name) for name in tasks.TASK_NAMES)
