"""The only door from the engine to PayPal's REST API.

Every request, including links PayPal hands back, goes through sandbox_url(), so
nothing in the engine can reach live PayPal or any other host. Errors carry the
HTTP status, PayPal's error name and debug_id, and nothing else: never the
secret, the token or the Authorization header.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from urllib.parse import SplitResult, urlsplit

import httpx

from mend_engine.config import Config

TIMEOUT_SECONDS = 15.0
TOKEN_REFRESH_MARGIN_SECONDS = 60
MAX_BODY_BYTES = 2_000_000
_CALLER_FORBIDDEN_HEADERS = frozenset({"authorization", "host"})


class HostRefused(Exception):
    """A request was aimed somewhere other than the PayPal sandbox API. Nothing was sent."""


class PayPalError(Exception):
    """PayPal answered with an error, or could not be reached.

    Carries only the HTTP status, PayPal's error name and debug_id.
    """

    def __init__(self, status: int | None, name: str | None, debug_id: str | None) -> None:
        self.status = status
        self.name = name
        self.debug_id = debug_id
        super().__init__(f"PayPal error status={status} name={name} debug_id={debug_id}")


class PayPalUnreachable(PayPalError):
    """Timeout or connection failure. The request may or may not have reached PayPal."""


@dataclass
class PayPalResponse:
    status: int
    body: dict
    debug_id: str | None


def sandbox_url(url: str, host: str) -> SplitResult:
    """Resolve and check a URL, returning the parsed object that may be fetched.

    Relative paths starting with "/" are joined to https://<host> first. The result
    must be https, its hostname must equal host exactly, and it may carry no
    userinfo and no port other than 443. Raises HostRefused otherwise.

    Covers lookalike hosts, suffix tricks, userinfo tricks, plain http and hosts
    hidden in the query. Does not cover DNS or TLS attacks on the real host; httpx
    validates the certificate for that.
    """
    if type(url) is not str or not url:
        raise HostRefused("empty or non-string URL")
    # urlsplit silently deletes tabs and newlines and trims leading spaces, which
    # would let a URL read differently to a person than to the parser.
    if not url.isascii() or any(ord(ch) <= 0x20 or ord(ch) == 0x7F for ch in url):
        raise HostRefused("URL contains spaces, control or non-ASCII characters")
    if url.startswith("/"):
        url = "https://" + host + url
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise HostRefused("URL could not be parsed") from None
    if parts.scheme != "https":
        raise HostRefused("only https is allowed")
    if parts.hostname != host:
        raise HostRefused("host is not the PayPal sandbox API")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise HostRefused("URL carries userinfo")
    if port not in (None, 443):
        raise HostRefused("unexpected port")
    return parts


def _error_name(body: dict) -> str | None:
    name = body.get("name") if isinstance(body, dict) else None
    if name is None:
        name = body.get("error") if isinstance(body, dict) else None
    return name if isinstance(name, str) else None


class PayPalHttp:
    """Authenticated JSON client for the PayPal sandbox REST API.

    transport is a test seam for httpx.MockTransport; production code leaves it None.
    """

    def __init__(self, config: Config, *, transport: httpx.BaseTransport | None = None) -> None:
        self._config = config
        self._host = config.paypal_api_host
        self._token: str | None = None
        self._token_expires_at = 0.0
        self.requests_sent = 0
        self._client = httpx.Client(
            timeout=httpx.Timeout(TIMEOUT_SECONDS),
            follow_redirects=False,
            transport=transport,
            event_hooks={"request": [self._last_check]},
        )

    @property
    def config(self) -> Config:
        return self._config

    def _last_check(self, request: httpx.Request) -> None:
        # Second guard at the moment of sending, using httpx's own parser on the
        # exact object going out. If the two parsers ever disagree, nothing is sent.
        if request.url.scheme != "https" or request.url.host != self._host:
            raise HostRefused("host is not the PayPal sandbox API")
        if request.url.userinfo:
            raise HostRefused("URL carries userinfo")
        self.requests_sent += 1

    def _send(self, method: str, parts: SplitResult, **kwargs: object) -> httpx.Response:
        try:
            return self._client.request(method, parts.geturl(), **kwargs)
        except httpx.TimeoutException:
            raise PayPalUnreachable(None, "TIMEOUT", None) from None
        except httpx.TransportError:
            raise PayPalUnreachable(None, "CONNECTION_ERROR", None) from None

    @staticmethod
    def _parse(response: httpx.Response) -> PayPalResponse:
        debug_id = response.headers.get("paypal-debug-id")
        body: dict = {}
        content = response.content
        if len(content) > MAX_BODY_BYTES:
            raise PayPalError(response.status_code, "RESPONSE_TOO_LARGE", debug_id)
        if content:
            try:
                parsed = response.json()
            except ValueError:
                parsed = {}
            body = parsed if isinstance(parsed, dict) else {}
        if debug_id is None and isinstance(body.get("debug_id"), str):
            debug_id = body["debug_id"]
        return PayPalResponse(status=response.status_code, body=body, debug_id=debug_id)

    def _bearer(self) -> str:
        now = time.monotonic()
        if self._token is not None and now < self._token_expires_at:
            return self._token
        self._token = None
        parts = sandbox_url("/v1/oauth2/token", self._host)
        response = self._send(
            "POST",
            parts,
            data={"grant_type": "client_credentials"},
            auth=(self._config.paypal_client_id, self._config.paypal_client_secret),
            headers={"Accept": "application/json"},
        )
        parsed = self._parse(response)
        token = parsed.body.get("access_token")
        expires_in = parsed.body.get("expires_in")
        if parsed.status != 200 or not isinstance(token, str) or not token:
            raise PayPalError(parsed.status, _error_name(parsed.body), parsed.debug_id)
        if type(expires_in) is not int or expires_in <= 0:
            raise PayPalError(parsed.status, "TOKEN_WITHOUT_EXPIRY", parsed.debug_id)
        self._token = token
        self._token_expires_at = now + expires_in - TOKEN_REFRESH_MARGIN_SECONDS
        return token

    def _bearer_for_sdk(self) -> tuple[str, int]:
        """The cached token and its usable seconds left, for the Server SDK only.

        Lets the SDK share this one token and this one credential source instead
        of holding the secret and fetching a second token of its own.
        """
        token = self._bearer()
        return token, max(int(self._token_expires_at - time.monotonic()), 0)

    def secrets_found_in(self, text: str) -> list[str]:
        """Names (never values) of the client id, secret or current token found in text."""
        candidates = {
            "client id": self._config.paypal_client_id,
            "client secret": self._config.paypal_client_secret,
            "access token": self._token,
        }
        return [label for label, value in candidates.items() if value and value in text]

    def request(
        self,
        method: str,
        url: str,
        *,
        json_body: dict | None = None,
        headers: dict[str, str] | None = None,
    ) -> PayPalResponse:
        """Send one authenticated request to the sandbox API and return PayPal's answer.

        Any HTTP status is returned as a PayPalResponse; the caller decides what an
        error status means. Raises HostRefused before sending if url is not on the
        sandbox API host, PayPalUnreachable on timeout or connection failure, and
        PayPalError if no token can be obtained.
        """
        parts = sandbox_url(url, self._host)
        extra = dict(headers or {})
        if any(key.lower() in _CALLER_FORBIDDEN_HEADERS for key in extra):
            raise ValueError("callers may not set Authorization or Host")
        token = self._bearer()
        send_headers = {"Accept": "application/json", **extra, "Authorization": f"Bearer {token}"}
        kwargs: dict[str, object] = {"headers": send_headers}
        if json_body is not None:
            kwargs["json"] = json_body
        response = self._send(method, parts, **kwargs)
        if response.status_code == 401:
            # A token PayPal no longer accepts is dropped so the next call fetches a fresh one.
            self._token = None
        return self._parse(response)

    def close(self) -> None:
        self._client.close()
