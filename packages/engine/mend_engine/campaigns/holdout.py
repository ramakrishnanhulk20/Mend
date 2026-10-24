"""The random holdout: candidates held back from a campaign so its effect can be measured (C6).

The draw uses the operating system's secure random source, so nobody, including
whoever ranks or writes notes, can predict or steer who is held back. It happens
once, on the bare candidate list, and is stored with the campaign for good.
"""

from __future__ import annotations

import random
import secrets
from collections.abc import Sequence
from decimal import ROUND_HALF_UP, Decimal

from mend_engine.campaigns.eligibility import Candidate

DEFAULT_HOLDOUT_SHARE = Decimal("0.50")
HOLDOUT_MIN = Decimal("0.20")
HOLDOUT_MAX = Decimal("0.50")
# The campaigns table stores the share as numeric(3,2). A share with more places
# would be stored rounded, and the stored share would no longer be the one drawn.
_HOLDOUT_STEP = Decimal("0.01")


def check_share(share: Decimal) -> None:
    """Raise ValueError unless share is a Decimal from 0.20 to 0.50 with at most two decimal places."""
    if type(share) is not Decimal or not share.is_finite():
        raise ValueError("holdout share must be a finite Decimal")
    if share.quantize(_HOLDOUT_STEP) != share:
        raise ValueError("holdout share may have at most two decimal places")
    if not HOLDOUT_MIN <= share <= HOLDOUT_MAX:
        raise ValueError(f"holdout share must be between {HOLDOUT_MIN} and {HOLDOUT_MAX}")


def holdout_size(count: int, share: Decimal) -> int:
    """How many of count candidates are held back: share x count rounded half up, at least 1 from 2 up.

    Raises ValueError for a negative or non-int count or a share check_share refuses.
    """
    check_share(share)
    if type(count) is not int or count < 0:
        raise ValueError("count must be a whole number from 0 up")
    size = int((share * count).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    return max(size, 1) if count >= 2 else size


def split_holdout(
    candidates: Sequence[Candidate], share: Decimal, rng: random.Random | None = None
) -> tuple[list[Candidate], list[Candidate]]:
    """Split candidates at random into (rewarded, holdout), each keeping the input order.

    The holdout has holdout_size(len(candidates), share) members, drawn with rng,
    which defaults to secrets.SystemRandom(). Tests pass a seeded random.Random.
    At a share of at most 0.50, 2 or more candidates always leave at least one
    rewarded.

    Raises ValueError for a share check_share refuses or a member listed twice.
    """
    items = list(candidates)
    if len({c.member_id for c in items}) != len(items):
        raise ValueError("a member appears twice in the candidate list")
    size = holdout_size(len(items), share)
    draw = rng if rng is not None else secrets.SystemRandom()
    held = set(draw.sample(range(len(items)), size))
    rewarded = [c for i, c in enumerate(items) if i not in held]
    holdout = [c for i, c in enumerate(items) if i in held]
    return rewarded, holdout
