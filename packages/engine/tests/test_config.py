# Not covered here: DATABASE_URL handling and the pgserver start-up path, which
# the prove_m1 run exercises against a real local database.
from pathlib import Path

import pytest

from mend_engine.config import SANDBOX_API_HOST, Config, ConfigError, load_config

KEYS = (
    "PAYPAL_CLIENT_ID",
    "PAYPAL_CLIENT_SECRET",
    "PAYPAL_ENV",
    "MEND_DEV",
    "MEND_TEST_RECEIVER",
    "MEND_PAYOUT_ITEM_CAP_MINOR",
    "MEND_CAMPAIGN_CAP_MINOR",
    "MEND_DAILY_CAP_MINOR",
    "MEND_BALANCE_FLOOR_MINOR",
    "DATABASE_URL",
)

GOOD = {
    "PAYPAL_CLIENT_ID": "client-id-value",
    "PAYPAL_CLIENT_SECRET": "very-secret-value",
    "PAYPAL_ENV": "sandbox",
    "MEND_DEV": "1",
    "MEND_PAYOUT_ITEM_CAP_MINOR": "1000",
    "MEND_CAMPAIGN_CAP_MINOR": "10000",
    "MEND_DAILY_CAP_MINOR": "20000",
}


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in KEYS:
        monkeypatch.delenv(key, raising=False)


def write_env(tmp_path: Path, values: dict[str, str], newline: str = "\n") -> str:
    path = tmp_path / ".env"
    path.write_bytes(newline.join(f"{k}={v}" for k, v in values.items()).encode() + newline.encode())
    return str(path)


def test_loads_a_good_file_with_crlf_endings(tmp_path: Path) -> None:
    config = load_config(write_env(tmp_path, GOOD, newline="\r\n"))
    assert config.paypal_api_host == SANDBOX_API_HOST
    assert config.paypal_client_secret == "very-secret-value"
    assert config.item_cap_minor == 1000
    assert config.dev is True


def test_process_environment_wins_over_the_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MEND_PAYOUT_ITEM_CAP_MINOR", "500")
    assert load_config(write_env(tmp_path, GOOD)).item_cap_minor == 500


@pytest.mark.parametrize("env_value", ["live", "production", "Sandbox", ""])
def test_refuses_any_environment_but_sandbox(tmp_path: Path, env_value: str) -> None:
    with pytest.raises(ConfigError):
        load_config(write_env(tmp_path, {**GOOD, "PAYPAL_ENV": env_value}))


def test_live_in_process_env_beats_sandbox_in_file_and_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PAYPAL_ENV", "live")
    with pytest.raises(ConfigError):
        load_config(write_env(tmp_path, GOOD))


@pytest.mark.parametrize("key", ["PAYPAL_CLIENT_SECRET", "PAYPAL_CLIENT_ID"])
def test_refuses_an_empty_key(tmp_path: Path, key: str) -> None:
    with pytest.raises(ConfigError):
        load_config(write_env(tmp_path, {**GOOD, key: ""}))


@pytest.mark.parametrize("cap", ["ten", "1.5", "-5", "0", " ", "1_000", "+10", "1e3"])
def test_refuses_a_cap_that_is_not_a_positive_whole_number(tmp_path: Path, cap: str) -> None:
    with pytest.raises(ConfigError):
        load_config(write_env(tmp_path, {**GOOD, "MEND_CAMPAIGN_CAP_MINOR": cap}))


def test_the_balance_floor_is_25000_cents_unless_set(tmp_path: Path) -> None:
    assert load_config(write_env(tmp_path, GOOD)).balance_floor_minor == 25000
    assert load_config(write_env(tmp_path, {**GOOD, "MEND_BALANCE_FLOOR_MINOR": ""})).balance_floor_minor == 25000
    assert load_config(write_env(tmp_path, {**GOOD, "MEND_BALANCE_FLOOR_MINOR": "40000"})).balance_floor_minor == 40000


@pytest.mark.parametrize("floor", ["ten", "1.5", "-5", "0", "1_000", "+10"])
def test_refuses_a_balance_floor_that_is_not_a_positive_whole_number(tmp_path: Path, floor: str) -> None:
    with pytest.raises(ConfigError, match="MEND_BALANCE_FLOOR_MINOR"):
        load_config(write_env(tmp_path, {**GOOD, "MEND_BALANCE_FLOOR_MINOR": floor}))


def test_refuses_a_missing_env_file(tmp_path: Path) -> None:
    with pytest.raises(ConfigError):
        load_config(str(tmp_path / "missing.env"))


def test_repr_and_errors_hide_the_secret(tmp_path: Path) -> None:
    config = load_config(write_env(tmp_path, GOOD))
    assert "very-secret-value" not in repr(config)
    assert "very-secret-value" not in str(config)
    assert "client-id-value" not in repr(config)
    with pytest.raises(ConfigError) as caught:
        load_config(write_env(tmp_path, {**GOOD, "PAYPAL_ENV": "live"}))
    assert "very-secret-value" not in str(caught.value)


def test_a_hand_built_config_cannot_carry_the_live_host() -> None:
    with pytest.raises(ConfigError):
        Config(
            paypal_client_id="a",
            paypal_client_secret="b",
            paypal_api_host="api-m.paypal.com",
            database_url=None,
            dev=True,
            test_receiver=None,
            item_cap_minor=1,
            campaign_cap_minor=1,
            daily_cap_minor=1,
        )
