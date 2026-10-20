# Not covered here: real TLS certificate checks and DNS, which httpx and the OS
# handle against the live host; the prove_m1 run covers a real sandbox request.
import httpx
import pytest

from mend_engine.config import SANDBOX_API_HOST, Config
from mend_engine.paypal.http import HostRefused, PayPalError, PayPalHttp

SECRET = "sekret-value-123"
TOKEN = "token-value-456"


def make_config() -> Config:
    return Config(
        paypal_client_id="client-id-789",
        paypal_client_secret=SECRET,
        paypal_api_host=SANDBOX_API_HOST,
        database_url=None,
        dev=True,
        test_receiver=None,
        item_cap_minor=1000,
        campaign_cap_minor=10000,
        daily_cap_minor=20000,
    )


class Recorder:
    def __init__(self, status: int = 200) -> None:
        self.requests: list[httpx.Request] = []
        self.status = status

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": TOKEN, "expires_in": 32000})
        return httpx.Response(self.status, json={"name": "SOME_ERROR", "debug_id": "dbg1"})


def client(recorder: Recorder) -> PayPalHttp:
    return PayPalHttp(make_config(), transport=httpx.MockTransport(recorder))


@pytest.mark.parametrize(
    "url",
    [
        "https://api-m.paypal.com/v1/payments/payouts",
        "https://api-m.sandbox.paypal.com.evil.com/v1/payments/payouts",
        "http://api-m.sandbox.paypal.com/v1/payments/payouts",
        "https://evil.com/?h=api-m.sandbox.paypal.com",
        "https://api-m.sandbox.paypal.com@evil.com/v1/payments/payouts",
        "https://user@api-m.sandbox.paypal.com/v1/payments/payouts",
        "https://api-m.sandbox.paypal.com:8443/v1/payments/payouts",
        "https://api-m.sandbox.paypal.com\t.evil.com/",
        " https://evil.com/",
        "v1/payments/payouts",
        "",
        # PayPal's own links point here; the host rule is exact, so they are refused too.
        "https://api.sandbox.paypal.com/v1/payments/payouts/ABC123",
    ],
)
def test_refuses_before_sending(url: str) -> None:
    recorder = Recorder()
    http = client(recorder)
    with pytest.raises(HostRefused):
        http.request("GET", url)
    assert recorder.requests == []
    assert http.requests_sent == 0


def test_accepts_a_relative_path_and_sends_it_to_the_sandbox_host() -> None:
    recorder = Recorder()
    http = client(recorder)
    response = http.request("GET", "/v1/payments/payouts")
    sent = recorder.requests[-1]
    assert sent.url.scheme == "https"
    assert sent.url.host == SANDBOX_API_HOST
    assert sent.url.path == "/v1/payments/payouts"
    assert sent.headers["Authorization"] == f"Bearer {TOKEN}"
    assert response.status == 200


def test_a_double_slash_path_still_goes_to_the_sandbox_host() -> None:
    recorder = Recorder()
    http = client(recorder)
    http.request("GET", "//evil.com/x")
    assert all(r.url.host == SANDBOX_API_HOST for r in recorder.requests)


def test_token_is_cached_between_calls() -> None:
    recorder = Recorder()
    http = client(recorder)
    http.request("GET", "/v1/a")
    http.request("GET", "/v1/b")
    token_calls = [r for r in recorder.requests if r.url.path == "/v1/oauth2/token"]
    assert len(token_calls) == 1


def test_callers_cannot_override_authorization() -> None:
    http = client(Recorder())
    with pytest.raises(ValueError):
        http.request("GET", "/v1/a", headers={"authorization": "Bearer other"})


def test_token_failure_error_carries_no_secret() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "invalid_client", "error_description": SECRET})

    http = PayPalHttp(make_config(), transport=httpx.MockTransport(refuse))
    with pytest.raises(PayPalError) as caught:
        http.request("GET", "/v1/a")
    text = str(caught.value) + repr(caught.value)
    assert caught.value.status == 401
    assert caught.value.name == "invalid_client"
    assert SECRET not in text and TOKEN not in text and "Authorization" not in text


def test_timeout_error_carries_no_request_details() -> None:
    def hang(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    http = PayPalHttp(make_config(), transport=httpx.MockTransport(hang))
    with pytest.raises(PayPalError) as caught:
        http.request("GET", "/v1/a")
    assert caught.value.name == "TIMEOUT"
    assert caught.value.__cause__ is None and caught.value.__suppress_context__


def test_secrets_found_in_reports_names_not_values() -> None:
    http = client(Recorder())
    http.request("GET", "/v1/a")
    assert http.secrets_found_in("nothing here") == []
    found = http.secrets_found_in(f"x {TOKEN} y {SECRET}")
    assert found == ["client secret", "access token"]
