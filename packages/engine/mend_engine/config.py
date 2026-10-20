"""Deployment settings for the engine, read once at start-up.

The engine can only ever talk to the PayPal sandbox. The API host is a constant,
not a setting, so no environment value, file or caller can point it at live PayPal.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

SANDBOX_API_HOST = "api-m.sandbox.paypal.com"

_WHOLE_NUMBER = re.compile(r"[0-9]+")


class ConfigError(Exception):
    """The engine refuses to start. Messages name the setting, never its value."""


@dataclass(frozen=True)
class Config:
    paypal_client_id: str = field(repr=False)
    paypal_client_secret: str = field(repr=False)
    paypal_api_host: str
    database_url: str | None = field(repr=False)
    dev: bool
    test_receiver: str | None = field(repr=False)
    item_cap_minor: int
    campaign_cap_minor: int
    daily_cap_minor: int

    def __post_init__(self) -> None:
        # Checked here as well as in load_config so a Config built by hand in a
        # test or script cannot carry a live host or a broken cap either.
        if self.paypal_api_host != SANDBOX_API_HOST:
            raise ConfigError("paypal_api_host must be the sandbox host")
        if not self.paypal_client_id or not self.paypal_client_secret:
            raise ConfigError("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must both be set")
        for name in ("item_cap_minor", "campaign_cap_minor", "daily_cap_minor"):
            value = getattr(self, name)
            if type(value) is not int or value < 1:
                raise ConfigError(f"{name} must be a positive whole number")


def _read_env_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        raise ConfigError(f"env file not found: {path.name}")
    values: dict[str, str] = {}
    # utf-8-sig drops a byte-order mark that PowerShell editors sometimes add.
    text = path.read_text(encoding="utf-8-sig")
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def _parse_cap(name: str, raw: str | None) -> int:
    # int() alone would accept " 12", "+12" and "1_000"; a cap must be plain digits.
    if raw is None or not _WHOLE_NUMBER.fullmatch(raw):
        raise ConfigError(f"{name} must be a positive whole number")
    value = int(raw)
    if value < 1:
        raise ConfigError(f"{name} must be a positive whole number")
    return value


def _parse_dev(raw: str | None) -> bool:
    if raw is None or raw == "" or raw == "0" or raw.lower() == "false":
        return False
    if raw == "1" or raw.lower() == "true":
        return True
    raise ConfigError("MEND_DEV must be 1, 0, true or false")


def load_config(env_path: str | None = None) -> Config:
    """Build the Config from the process environment, plus the .env file at env_path.

    The process environment wins over the file. Raises ConfigError unless
    PAYPAL_ENV is exactly "sandbox", both PayPal keys are non-empty and every cap
    is a positive whole number.
    """
    file_values = _read_env_file(Path(env_path)) if env_path is not None else {}

    def get(name: str) -> str | None:
        value = os.environ.get(name)
        if value is None:
            value = file_values.get(name)
        return value.strip() if value is not None else None

    if get("PAYPAL_ENV") != "sandbox":
        raise ConfigError("PAYPAL_ENV must be exactly 'sandbox'")

    client_id = get("PAYPAL_CLIENT_ID") or ""
    client_secret = get("PAYPAL_CLIENT_SECRET") or ""
    if not client_id or not client_secret:
        raise ConfigError("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must both be set")

    return Config(
        paypal_client_id=client_id,
        paypal_client_secret=client_secret,
        paypal_api_host=SANDBOX_API_HOST,
        database_url=get("DATABASE_URL") or None,
        dev=_parse_dev(get("MEND_DEV")),
        test_receiver=get("MEND_TEST_RECEIVER") or None,
        item_cap_minor=_parse_cap("MEND_PAYOUT_ITEM_CAP_MINOR", get("MEND_PAYOUT_ITEM_CAP_MINOR")),
        campaign_cap_minor=_parse_cap("MEND_CAMPAIGN_CAP_MINOR", get("MEND_CAMPAIGN_CAP_MINOR")),
        daily_cap_minor=_parse_cap("MEND_DAILY_CAP_MINOR", get("MEND_DAILY_CAP_MINOR")),
    )
