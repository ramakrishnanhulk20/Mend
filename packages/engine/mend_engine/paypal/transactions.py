"""Reads the shop's PayPal history through PayPal's Python Server SDK.

The SDK is pinned to the sandbox in two ways: it is built with the sandbox
environment and checked against the sandbox base URL, and every request it makes
goes through SandboxOnlySession, which applies the same host check as PayPalHttp.
It shares PayPalHttp's token, so the client secret lives in one place only.
"""

from __future__ import annotations

import json
import weakref
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import requests
from apimatic_core.utilities.auth_helper import AuthHelper
from paypalserversdk.api_helper import APIHelper
from paypalserversdk.configuration import Environment
from paypalserversdk.exceptions.api_exception import ApiException
from paypalserversdk.http.auth.o_auth_2 import ClientCredentialsAuthCredentials
from paypalserversdk.models.o_auth_token import OAuthToken
from paypalserversdk.paypal_serversdk_client import PaypalServersdkClient

from mend_engine.config import SANDBOX_API_HOST
from mend_engine.paypal.http import (
    TIMEOUT_SECONDS,
    HostRefused,
    PayPalError,
    PayPalHttp,
    PayPalUnreachable,
    sandbox_url,
)

MAX_RANGE = timedelta(days=31)
MAX_PAGE_SIZE = 500
MAX_PAGE = 10_000
_PAYER_ID_FIELDS = ("email_address", "account_id")


class RangeRefused(ValueError):
    """A search window or page request PayPal would refuse, or that is ambiguous."""


class SdkFieldLoss(RuntimeError):
    """The SDK's typed response lost a payer field PayPal actually sent."""


@dataclass
class TransactionPage:
    total_items: int
    total_pages: int
    rows: list[dict] = field(default_factory=list)


class SandboxOnlySession(requests.Session):
    """A requests session that refuses to send anything off the sandbox API host.

    requests routes redirects through send() too, so a redirect hop is checked as well.
    """

    def __init__(self, host: str) -> None:
        super().__init__()
        self._host = host

    def send(self, request: requests.PreparedRequest, **kwargs: object) -> requests.Response:
        sandbox_url(request.url or "", self._host)
        return super().send(request, **kwargs)


_clients: weakref.WeakKeyDictionary[PayPalHttp, PaypalServersdkClient] = weakref.WeakKeyDictionary()


def _token_provider(http: PayPalHttp):
    def provide(_previous: object, _auth_manager: object) -> OAuthToken:
        token, seconds_left = http._bearer_for_sdk()
        # The SDK compares expiry against its own clock (local time read as UTC),
        # so the expiry must be computed from that same clock, not time.time().
        return OAuthToken(
            access_token=token,
            token_type="Bearer",
            expires_in=seconds_left,
            expiry=AuthHelper.get_current_utc_timestamp() + seconds_left,
        )

    return provide


def _is_pinned(client: PaypalServersdkClient) -> bool:
    config = client.config
    session = getattr(config.http_client, "session", None)
    return (
        config.environment is Environment.SANDBOX
        and config.get_base_uri() == "https://" + SANDBOX_API_HOST
        and isinstance(session, SandboxOnlySession)
    )


def sdk_client_for(http: PayPalHttp) -> PaypalServersdkClient:
    """The Server SDK client bound to http's sandbox host and token. Built once per http."""
    client = _clients.get(http)
    if client is not None:
        return client
    host = http.config.paypal_api_host
    client = PaypalServersdkClient(
        http_client_instance=SandboxOnlySession(host),
        timeout=TIMEOUT_SECONDS,
        max_retries=0,
        environment=Environment.SANDBOX,
        # Empty id and secret: the SDK can never fetch a token of its own, only
        # use the one PayPalHttp hands it through the provider.
        client_credentials_auth_credentials=ClientCredentialsAuthCredentials(
            o_auth_client_id="",
            o_auth_client_secret="",
            o_auth_token_provider=_token_provider(http),
        ),
    )
    if not _is_pinned(client):
        raise HostRefused("the Server SDK client is not pinned to the sandbox host")
    _clients[http] = client
    return client


def _utc(value: datetime, name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise RangeRefused(f"{name} must be a timezone-aware datetime")
    return value.astimezone(timezone.utc)


def _as_dict(model: object) -> dict:
    if model is None:
        return {}
    return APIHelper.to_dictionary(model)


def _check_no_field_loss(raw_text: str | None, rows: list[dict]) -> None:
    try:
        raw = json.loads(raw_text or "{}")
    except ValueError:
        raise SdkFieldLoss("could not read PayPal's raw answer to cross-check the SDK") from None
    raw_rows = raw.get("transaction_details") if isinstance(raw, dict) else None
    if not isinstance(raw_rows, list):
        raw_rows = []
    if len(raw_rows) != len(rows):
        raise SdkFieldLoss("the SDK returned a different number of rows than PayPal sent")
    for raw_row, row in zip(raw_rows, rows):
        raw_payer = raw_row.get("payer_info") if isinstance(raw_row, dict) else None
        if not isinstance(raw_payer, dict):
            continue
        for name in _PAYER_ID_FIELDS:
            if raw_payer.get(name) and not row["payer_info"].get(name):
                raise SdkFieldLoss(f"the SDK dropped payer_info.{name}")


def search_transactions(
    http_or_client: PayPalHttp | PaypalServersdkClient,
    start: datetime,
    end: datetime,
    page: int = 1,
    page_size: int = 100,
) -> TransactionPage:
    """One page of the shop's transactions between start and end, with fields=all.

    start and end must be timezone-aware and at most 31 days apart; page starts at 1
    and page_size is 1 to 500. Raises RangeRefused for a bad window, HostRefused if
    a passed-in SDK client is not pinned to the sandbox, PayPalError or
    PayPalUnreachable when PayPal refuses or cannot be reached, and SdkFieldLoss if
    the SDK's typed rows lose a payer email or account id that PayPal sent.
    """
    if isinstance(http_or_client, PayPalHttp):
        client = sdk_client_for(http_or_client)
    elif isinstance(http_or_client, PaypalServersdkClient):
        if not _is_pinned(http_or_client):
            raise HostRefused("the Server SDK client is not pinned to the sandbox host")
        client = http_or_client
    else:
        raise TypeError("expected PayPalHttp or a sandbox-pinned PaypalServersdkClient")

    start_utc = _utc(start, "start")
    end_utc = _utc(end, "end")
    if end_utc <= start_utc:
        raise RangeRefused("end must be after start")
    if end_utc - start_utc > MAX_RANGE:
        raise RangeRefused("PayPal searches at most 31 days per call")
    if type(page) is not int or not 1 <= page <= MAX_PAGE:
        raise RangeRefused("page must be a whole number from 1")
    if type(page_size) is not int or not 1 <= page_size <= MAX_PAGE_SIZE:
        raise RangeRefused("page_size must be 1 to 500")

    options = {
        "start_date": start_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "end_date": end_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fields": "all",
        "page_size": page_size,
        "page": page,
    }
    try:
        response = client.transaction_search.search_transactions(options)
    except ApiException as exc:
        raise PayPalError(
            exc.response_code, getattr(exc, "name", None), getattr(exc, "debug_id", None)
        ) from None
    except requests.Timeout:
        raise PayPalUnreachable(None, "TIMEOUT", None) from None
    except requests.RequestException:
        raise PayPalUnreachable(None, "CONNECTION_ERROR", None) from None

    body = response.body
    rows = [
        {
            "transaction_info": _as_dict(getattr(detail, "transaction_info", None)),
            "payer_info": _as_dict(getattr(detail, "payer_info", None)),
        }
        for detail in (getattr(body, "transaction_details", None) or [])
    ]
    _check_no_field_loss(response.text, rows)
    total_items = getattr(body, "total_items", None)
    total_pages = getattr(body, "total_pages", None)
    return TransactionPage(
        total_items=total_items if type(total_items) is int else 0,
        total_pages=total_pages if type(total_pages) is int else 0,
        rows=rows,
    )
