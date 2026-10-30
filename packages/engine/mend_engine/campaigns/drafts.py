"""Builds a campaign draft: who is in it, who is held back and what each is paid, all decided in code.

The order is fixed. Settings are checked against the deployment's caps, customers
are scored, eligible members are ranked, and the holdout is drawn from that bare
ranked list before any amount, note or stored row exists (C6). Every amount is
computed here and nowhere else (C4). A draft stores member ids, never an email:
the payout receiver is read from the member row when a batch is built (C5).
"""

from __future__ import annotations

import unicodedata
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal

import psycopg
from psycopg.types.json import Jsonb

from mend_engine.campaigns.eligibility import quiet_regular_members
from mend_engine.campaigns.holdout import HOLDOUT_MAX, HOLDOUT_MIN, check_share, split_holdout
from mend_engine.campaigns.scoring import score_customers
from mend_engine.campaigns.spend import CapExceeded, check_daily_cap, database_now
from mend_engine.config import Config
from mend_engine.members.consent import DEMO_SHOP_NAME, consent_text_for
from mend_engine.money import MoneyError, to_decimal_string

# The note rule validate_snapshot applies to every payout note, so a note accepted
# here is a note the batch will accept.
from mend_engine.paypal.payouts import MAX_ITEMS, MAX_NOTE_CHARS, note_problem

MAX_GOAL_CHARS = 500
# At the lowest holdout share, 0.20, 250 candidates leave 200 to reward: the most
# items one Payouts batch may carry, and a campaign is exactly one batch (C3).
MAX_CANDIDATES = 250
NOTE_TEMPLATE = "Thank you for being a regular at {shop_name}. Here is a small thank-you from us."
ACTOR = "engine"

_INSERT_CAMPAIGN = (
    "insert into campaigns (shop_name, goal_text, as_of, budget_minor, per_recipient_minor, holdout_share, status) "
    "values (%s, %s, %s, %s, %s, %s, 'draft') returning campaign_id"
)
_INSERT_ROW = (
    "insert into campaign_members (campaign_id, ref, member_id, role, rank, score, amount_minor, note) "
    "values (%s, %s, %s, %s, %s, %s, %s, %s)"
)
_INSERT_AUDIT = "insert into audit_log (actor, action, detail) values (%s, %s, %s)"


class DraftRefused(ValueError):
    """The draft breaks a rule and nothing was stored.

    reason is a short fixed code (for example "budget_over_cap"); the message says
    why in plain words and never names a member or customer.
    """

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


@dataclass(frozen=True)
class DraftSettings:
    goal_text: str
    as_of: date
    budget_minor: int
    per_recipient_minor: int
    holdout_share: Decimal
    max_candidates: int


@dataclass(frozen=True)
class DraftResult:
    """What was stored. Counts and money only; identities stay in the database."""

    campaign_id: uuid.UUID
    candidates: int
    rewarded: int
    held_back: int
    total_minor: int


def reward_amounts(
    paid_minor: Sequence[int], *, per_recipient_minor: int, item_cap_minor: int, budget_minor: int
) -> list[int]:
    """One amount per rewarded customer, in the same order as paid_minor.

    Each is min(per_recipient_minor, item_cap_minor, budget_minor // count, what that
    customer paid), so no amount passes any cap and the total never passes the
    budget. Raises DraftRefused ("budget_too_small") when the budget cannot give
    everyone at least 1 cent, and ("amount_out_of_range") for any input that is not
    a whole number of cents from 1 up or an amount money.to_decimal_string refuses.
    """
    values = [per_recipient_minor, item_cap_minor, budget_minor, *paid_minor]
    if any(type(value) is not int or value < 1 for value in values):
        raise DraftRefused("amount_out_of_range", "every cap, budget and paid amount must be whole cents from 1 up")
    count = len(paid_minor)
    if count == 0:
        return []
    split = budget_minor // count
    if split < 1:
        raise DraftRefused("budget_too_small", f"a budget of {budget_minor} cents cannot give {count} people 1 cent each")
    amounts = [min(per_recipient_minor, item_cap_minor, split, paid) for paid in paid_minor]
    try:
        for amount in amounts:
            to_decimal_string(amount)
    except MoneyError:
        raise DraftRefused("amount_out_of_range", "an amount is outside what PayPal can be sent") from None
    return amounts


def build_draft(
    conn: psycopg.Connection, config: Config, settings: DraftSettings, shop_name: str = DEMO_SHOP_NAME
) -> DraftResult:
    """Build and store one campaign draft for the quiet regulars among the shop's members.

    Takes the first max_candidates eligible members in eligibility's order
    (quiet_regular_members: worth a nudge, biggest spenders first), draws the holdout
    with the operating system's random source, gives every rewarded member
    reward_amounts() and the code-owned thank-you note, and writes the campaign
    (status 'draft'), one row per candidate with refs "R1", "R2", ... in rank order,
    and one audit_log row, all in one transaction. Holdout rows carry no amount and
    no note.

    Raises DraftRefused, with nothing stored, for: a budget above
    config.campaign_cap_minor; a per-recipient amount above config.item_cap_minor;
    a holdout share outside 0.20 to 0.50 or with more than two decimal places; a
    goal that is empty, over 500 characters or holds a control or invisible
    character; a max_candidates outside 2 to 250; a bad shop name or note; a model
    fit that did not converge; fewer than 2 eligible members; a budget too small to
    give each rewarded member 1 cent; a total that would pass the rolling daily cap
    on top of what left the shop in the last 24 hours; a member who left while the
    draft was built.
    """
    note = _checked_settings(config, settings, shop_name)
    scores = score_customers(conn, settings.as_of)
    if not scores.converged:
        raise DraftRefused("model_not_converged", f"the customer model did not converge, so nobody can be ranked ({scores.message})")
    ranked = quiet_regular_members(conn, scores, settings.as_of)[: settings.max_candidates]
    if len(ranked) < 2:
        raise DraftRefused("too_few_candidates", f"{len(ranked)} eligible members; a campaign needs at least 2 so one can be held back")

    # The bare ranked list is all that exists at this point: no amount, note,
    # summary or stored row. The holdout is drawn from it here and never redrawn.
    rewarded, holdout = split_holdout(ranked, settings.holdout_share)
    if len(rewarded) > MAX_ITEMS:
        raise DraftRefused("too_many_recipients", f"a campaign may reward at most {MAX_ITEMS} members")
    amounts = reward_amounts(
        [c.paid_minor for c in rewarded],
        per_recipient_minor=settings.per_recipient_minor,
        item_cap_minor=config.item_cap_minor,
        budget_minor=settings.budget_minor,
    )
    total = sum(amounts)
    if total > settings.budget_minor or total > config.campaign_cap_minor:
        raise DraftRefused("over_budget", "the amounts add up to more than the budget")
    try:
        check_daily_cap(conn, config, total, database_now(conn))
    except CapExceeded as exc:
        raise DraftRefused("over_daily_cap", str(exc)) from None

    amount_for = {c.member_id: amount for c, amount in zip(rewarded, amounts)}
    held_back = {c.member_id for c in holdout}
    rows = []
    for rank, candidate in enumerate(ranked, start=1):
        if candidate.member_id in held_back:
            rows.append((f"R{rank}", candidate.member_id, "holdout", rank, candidate.score, None, None))
        else:
            rows.append((f"R{rank}", candidate.member_id, "reward", rank, candidate.score, amount_for[candidate.member_id], note))

    member_ids = [c.member_id for c in ranked]
    with conn.transaction():
        # Key-share locks hold every member row in place until this commits. A
        # member who left after the list was read is missing here, so the draft is
        # refused rather than stored with someone who withdrew consent (C28).
        present = conn.execute(
            "select member_id from members where member_id = any(%s) for key share", (member_ids,)
        ).fetchall()
        if len(present) != len(member_ids):
            raise DraftRefused("member_left", "a member left while the draft was being built; build it again")
        campaign_id = conn.execute(
            _INSERT_CAMPAIGN,
            (
                shop_name,
                settings.goal_text,
                settings.as_of,
                settings.budget_minor,
                settings.per_recipient_minor,
                settings.holdout_share,
            ),
        ).fetchone()[0]
        with conn.cursor() as cur:
            cur.executemany(_INSERT_ROW, [(campaign_id, *row) for row in rows])
        conn.execute(
            _INSERT_AUDIT,
            (
                ACTOR,
                "campaign_drafted",
                Jsonb(
                    {
                        "campaign_id": str(campaign_id),
                        "rewarded": len(rewarded),
                        "held_back": len(holdout),
                        "total_minor": total,
                    }
                ),
            ),
        )
    return DraftResult(campaign_id, len(ranked), len(rewarded), len(holdout), total)


def draft_view(conn: psycopg.Connection, campaign_id: uuid.UUID) -> list[dict]:
    """The draft as a language model or the console may see it, in rank order.

    Each row holds only ref, role, rank, amount_minor and note: no email, member id
    or customer ref (C12, C15). Raises ValueError if campaign_id is not a
    uuid.UUID and LookupError if there is no such campaign.
    """
    if not isinstance(campaign_id, uuid.UUID):
        raise ValueError("campaign_id must be a UUID")
    if conn.execute("select 1 from campaigns where campaign_id = %s", (campaign_id,)).fetchone() is None:
        raise LookupError("no such campaign")
    rows = conn.execute(
        "select ref, role, rank, amount_minor, note from campaign_members where campaign_id = %s order by rank",
        (campaign_id,),
    )
    return [
        {"ref": ref, "role": role, "rank": rank, "amount_minor": amount_minor, "note": note}
        for ref, role, rank, amount_minor, note in rows
    ]


def _checked_settings(config: Config, settings: DraftSettings, shop_name: str) -> str:
    """Refuse settings that break a rule, before anything is read or drawn. Returns the note."""
    if not isinstance(config, Config) or not isinstance(settings, DraftSettings):
        raise DraftRefused("invalid_settings", "config and settings must be a Config and DraftSettings")
    goal = settings.goal_text
    if type(goal) is not str or not goal.strip():
        raise DraftRefused("goal_empty", "the goal must be non-empty text")
    if len(goal) > MAX_GOAL_CHARS:
        raise DraftRefused("goal_too_long", f"the goal must be at most {MAX_GOAL_CHARS} characters")
    # Unicode's "other" group: controls such as newlines and escapes, invisible
    # format marks such as direction overrides, surrogates, private-use and
    # unassigned code points. Ordinary letters, digits, punctuation and spaces pass.
    if any(unicodedata.category(ch).startswith("C") for ch in goal):
        raise DraftRefused("goal_control_character", "the goal has a control or invisible character")
    if isinstance(settings.as_of, datetime) or not isinstance(settings.as_of, date):
        raise DraftRefused("invalid_settings", "as_of must be a date")
    for name in ("budget_minor", "per_recipient_minor"):
        value = getattr(settings, name)
        if type(value) is not int or value < 1:
            raise DraftRefused("invalid_settings", f"{name} must be whole cents from 1 up")
    if settings.budget_minor > config.campaign_cap_minor:
        raise DraftRefused("budget_over_cap", f"the budget is above the campaign cap of {config.campaign_cap_minor} cents")
    if settings.per_recipient_minor > config.item_cap_minor:
        raise DraftRefused("per_recipient_over_cap", f"the amount per person is above the item cap of {config.item_cap_minor} cents")
    share = settings.holdout_share
    try:
        check_share(share)
    except ValueError as exc:
        in_range = type(share) is Decimal and share.is_finite() and HOLDOUT_MIN <= share <= HOLDOUT_MAX
        raise DraftRefused("invalid_settings" if in_range else "holdout_share_out_of_range", str(exc)) from None
    if type(settings.max_candidates) is not int or not 2 <= settings.max_candidates <= MAX_CANDIDATES:
        raise DraftRefused("invalid_settings", f"max_candidates must be a whole number from 2 to {MAX_CANDIDATES}")
    try:
        # The shop name a member consented to is held to the same rule here.
        consent_text_for(shop_name)
    except ValueError as exc:
        raise DraftRefused("invalid_settings", str(exc)) from None
    note = NOTE_TEMPLATE.format(shop_name=shop_name)
    problem = note_problem(note, MAX_NOTE_CHARS)
    if problem:
        raise DraftRefused("note_rejected", f"the thank-you note {problem}")
    return note
