# Not covered here: the real tasks behind the bridge (test_tasks.py), the web app's
# client for it (packages/web engine.test.ts) and the two running together
# (npm run prove:m7a). Nothing here checks what other processes on this machine can
# do: anything local that learns the token can call the bridge, which is why it is
# development only.
import http.client
import json
import os
import threading
from collections.abc import Iterator

import pytest

from mend_engine import dev_bridge, tasks
from mend_engine.dev_bridge import MAX_BODY_BYTES, TOKEN_HEADER, BridgeRefused, bridge_token, build_server, task_registry

TOKEN = "t" * 40
ENV = {
    "PAYPAL_ENV": "sandbox",
    "PAYPAL_CLIENT_ID": "cid",
    "PAYPAL_CLIENT_SECRET": "csecret",
    "MEND_DEV": "1",
    "MEND_PAYOUT_ITEM_CAP_MINOR": "1000",
    "MEND_CAMPAIGN_CAP_MINOR": "10000",
    "MEND_DAILY_CAP_MINOR": "20000",
}


@pytest.fixture
def calls() -> list:
    return []


@pytest.fixture
def port(calls: list) -> Iterator[int]:
    def echo(value: object) -> dict:
        calls.append(value)
        return {"ok": True, "echo": value}

    server = build_server(0, TOKEN, {"echo": echo})
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()


def post(port: int, path: str, body: bytes | None, headers: dict[str, str]) -> tuple[int, dict]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        connection.putrequest("POST", path)
        for name, value in headers.items():
            connection.putheader(name, value)
        connection.endheaders(body)
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


def call(port: int, body: object, *, token: str | None = TOKEN, path: str = "/tasks/echo") -> tuple[int, dict]:
    data = body if isinstance(body, bytes) else json.dumps(body).encode()
    headers = {"Content-Type": "application/json", "Content-Length": str(len(data))}
    if token is not None:
        headers[TOKEN_HEADER] = token
    return post(port, path, data, headers)


@pytest.mark.parametrize(
    ("changes", "token"),
    [
        ({"MEND_DEV": "0"}, TOKEN),
        ({"MEND_DEV": ""}, TOKEN),
        ({"PAYPAL_ENV": "live"}, TOKEN),
        ({}, ""),
        ({}, "short-token"),
        ({}, "t" * 20 + " " + "t" * 20),
    ],
)
def test_the_bridge_refuses_to_start_outside_sandbox_development_or_without_a_token(
    monkeypatch: pytest.MonkeyPatch, changes: dict, token: str
) -> None:
    for name, value in {**ENV, **changes, "MEND_BRIDGE_TOKEN": token}.items():
        monkeypatch.setenv(name, value)
    with pytest.raises(BridgeRefused):
        bridge_token(os.environ, None)
    assert dev_bridge.main(["--port", "0"]) == 2


def test_a_sandbox_development_environment_with_a_long_token_starts(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in ENV.items():
        monkeypatch.setenv(name, value)
    assert bridge_token({"MEND_BRIDGE_TOKEN": TOKEN}, None) == TOKEN


def test_the_bridge_listens_on_the_loopback_address_only() -> None:
    server = build_server(0, TOKEN, {})
    try:
        assert server.server_address[0] == "127.0.0.1"
    finally:
        server.server_close()


@pytest.mark.parametrize("token", [None, "", "t" * 39, "u" * 40, TOKEN + "x"])
def test_every_request_needs_the_exact_token(port: int, calls: list, token: str | None) -> None:
    assert call(port, {"args": [1]}, token=token) == (401, {"error": "unauthorised"})
    assert calls == []


def test_a_task_runs_with_its_arguments_and_its_dict_comes_back(port: int, calls: list) -> None:
    assert call(port, {"args": [{"campaign": "x", "n": 3}]}) == (200, {"ok": True, "echo": {"campaign": "x", "n": 3}})
    assert calls == [{"campaign": "x", "n": 3}]


def test_a_body_over_64_kb_is_refused_before_it_is_read(port: int, calls: list) -> None:
    status, body = post(port, "/tasks/echo", None, {TOKEN_HEADER: TOKEN, "Content-Length": str(MAX_BODY_BYTES + 1)})
    assert (status, body) == (413, {"error": "body too large"}) and calls == []
    padding = MAX_BODY_BYTES - len(json.dumps({"args": [""]}).encode())
    assert call(port, {"args": ["x" * padding]})[0] == 200


@pytest.mark.parametrize(
    ("body", "status"),
    [
        (b"not json", 400),
        (b'{"args": [1], "args": [2]}', 400),
        (b'{"args": [NaN]}', 400),
        (b'{"args": 1}', 400),
        (b'{"args": [], "extra": 1}', 400),
        (b'{"args": []}', 400),
        (b'{"args": [1, 2]}', 400),
    ],
)
def test_bodies_that_are_not_one_strict_args_list_for_the_task_are_refused(port: int, calls: list, body: bytes, status: int) -> None:
    assert call(port, body)[0] == status and calls == []


def test_unknown_tasks_and_other_methods_are_refused(port: int, calls: list) -> None:
    assert call(port, {"args": [1]}, path="/tasks/unknown")[0] == 404
    assert call(port, {"args": [1]}, path="/tasks/echo/../echo")[0] == 404
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    connection.request("GET", "/tasks/echo", headers={TOKEN_HEADER: TOKEN})
    assert connection.getresponse().status == 405
    connection.close()
    assert calls == []


def test_the_default_registry_is_exactly_the_engine_tasks() -> None:
    registry = task_registry()
    assert sorted(registry) == sorted(tasks.TASK_NAMES)
    assert all(registry[name] is getattr(tasks, name) for name in tasks.TASK_NAMES)
