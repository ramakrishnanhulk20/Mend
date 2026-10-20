# Not covered here: that the database holds only these identities (prove_m2 checks
# every stored row), and whether a generated name happens to match a real person's
# first name and initial, which carries no identity on its own.
import re

import pytest

from mend_engine.shop.identities import FIRST_NAMES, customer_ref, display_name, synthetic_email

SOURCE_IDS = range(12346, 12346 + 6000)
NAME = re.compile(r"[A-Z][a-z]+ [A-Z]\.")


def test_known_values_are_pinned() -> None:
    assert customer_ref(13085) == "C13085"
    assert display_name("C13085") == "Ivy E."
    assert synthetic_email("C13085") == "c13085@shop.example"


def test_names_are_deterministic_and_well_formed() -> None:
    refs = [customer_ref(i) for i in SOURCE_IDS]
    first = [display_name(r) for r in refs]
    assert first == [display_name(r) for r in refs]
    assert all(NAME.fullmatch(name) and name.split()[0] in FIRST_NAMES for name in first)


def test_emails_are_unique_and_never_deliverable_for_6000_refs() -> None:
    emails = [synthetic_email(customer_ref(i)) for i in SOURCE_IDS]
    assert len(set(emails)) == 6000
    assert all(email.endswith("@shop.example") for email in emails)


def test_no_digit_of_the_source_id_reaches_the_display_name() -> None:
    for source_id in SOURCE_IDS:
        name = display_name(customer_ref(source_id))
        assert not any(ch.isdigit() for ch in name)
        assert str(source_id) not in name


@pytest.mark.parametrize("bad", [0, -1, 1_000_000_000, True, 13085.0, "13085", None])
def test_customer_ref_refuses_anything_but_a_positive_whole_number(bad: object) -> None:
    with pytest.raises(ValueError):
        customer_ref(bad)  # type: ignore[arg-type]


@pytest.mark.parametrize("bad", ["c13085", "C013085", "C13085 ", "13085", "C", "", "C1\n", "C١٢", None])
def test_names_and_emails_refuse_a_malformed_ref(bad: object) -> None:
    with pytest.raises(ValueError):
        display_name(bad)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        synthetic_email(bad)  # type: ignore[arg-type]
