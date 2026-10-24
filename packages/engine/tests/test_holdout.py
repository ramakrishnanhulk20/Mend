# Not covered here: the statistical quality of the operating system's random source,
# and that the holdout is stored and never changes (test_drafts.py and prove_m4a).
import random
import uuid
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from mend_engine.campaigns import holdout as holdout_module
from mend_engine.campaigns.eligibility import Candidate
from mend_engine.campaigns.holdout import holdout_size, split_holdout

SHARES = [Decimal(n) / 100 for n in range(20, 51)]


def candidates(count: int) -> list[Candidate]:
    return [Candidate(uuid.UUID(int=i + 1), f"C{i + 1}", i / 10, 100 + i) for i in range(count)]


@pytest.mark.parametrize(
    ("count", "share", "expected"),
    [
        (10, "0.20", 2),
        (10, "0.50", 5),
        (5, "0.50", 3),  # 2.5 rounds half up
        (5, "0.20", 1),
        (3, "0.20", 1),  # 0.6 rounds to 1
        (2, "0.20", 1),  # 0.4 rounds to 0, raised to the minimum of 1
        (40, "0.50", 20),
        (250, "0.20", 50),
        (1, "0.20", 0),
        (0, "0.50", 0),
    ],
)
def test_holdout_sizes(count: int, share: str, expected: int) -> None:
    rewarded, held = split_holdout(candidates(count), Decimal(share), random.Random(7))
    assert holdout_size(count, Decimal(share)) == len(held) == expected
    assert len(rewarded) == count - expected


def test_a_seeded_draw_is_repeatable_and_seeds_differ() -> None:
    pool = candidates(40)
    first = split_holdout(pool, Decimal("0.50"), random.Random(11))
    assert split_holdout(pool, Decimal("0.50"), random.Random(11)) == first
    assert split_holdout(pool, Decimal("0.50"), random.Random(12)) != first


def test_the_default_draw_uses_the_operating_system_source(monkeypatch: pytest.MonkeyPatch) -> None:
    made: list[random.Random] = []

    class Recording(random.SystemRandom):
        def __init__(self) -> None:
            super().__init__()
            made.append(self)

    monkeypatch.setattr(holdout_module.secrets, "SystemRandom", Recording)
    rewarded, held = split_holdout(candidates(9), Decimal("0.50"))
    assert len(made) == 1 and (len(rewarded), len(held)) == (4, 5)


@pytest.mark.parametrize("share", [Decimal("0.6"), Decimal("0.19"), Decimal("0.51"), Decimal("0.333"), Decimal("NaN"), 0.5, "0.5"])
def test_a_share_outside_the_allowed_range_or_shape_is_refused(share: object) -> None:
    with pytest.raises(ValueError):
        split_holdout(candidates(10), share)  # type: ignore[arg-type]


def test_a_member_listed_twice_is_refused() -> None:
    pool = candidates(4)
    with pytest.raises(ValueError):
        split_holdout(pool + pool[:1], Decimal("0.50"), random.Random(1))


@given(count=st.integers(0, 300), share=st.sampled_from(SHARES), seed=st.integers(0, 2**32))
def test_rewarded_and_holdout_never_overlap_and_together_are_the_input(count: int, share: Decimal, seed: int) -> None:
    pool = candidates(count)
    rewarded, held = split_holdout(pool, share, random.Random(seed))
    rewarded_ids = {c.member_id for c in rewarded}
    held_ids = {c.member_id for c in held}
    assert not rewarded_ids & held_ids
    assert rewarded_ids | held_ids == {c.member_id for c in pool}
    assert len(rewarded) + len(held) == count
    assert rewarded == [c for c in pool if c.member_id in rewarded_ids]
    assert held == [c for c in pool if c.member_id in held_ids]
    if count >= 2:
        assert len(held) >= 1 and len(rewarded) >= 1
