"""Seeds the demo shop on the configured database: python -m mend_engine.seed_demo

Run once on a fresh deploy, after python -m mend_engine.db.migrate. It never applies the
schema itself: connect() refuses a database without it. In order, each step skipped
when it is already done, so a second run changes nothing:

1. orders: the UCI Online Retail II invoices as the shop's own order records (import_uci)
2. refunds: its cancellation invoices as the shop's refunds (import_refunds)
3. facts: the model's measured proof numbers for the landing page (store_facts)
4. members: the 40 quiet regulars most at risk joined as verified demo members, chosen
   and joined exactly as prove_m4a does
5. receiver: MEND_TEST_RECEIVER, the sandbox account that can really claim a payout,
   joined as a verified member linked to one more quiet regular, chosen as prove_m4b
   chooses it
6. receiver first: that member made the most at-risk eligible member, so a default
   demo draft always considers it (seed_receiver_first)

Reads the UCI zip from packages/engine/.data (downloaded once when missing, checked by
size and SHA-256). Calls no PayPal API and moves no money. Every shop identity is the
importer's synthetic one (C25); the test receiver's address replaces one of them and
is never printed. Prints one line per step, then SEED RESULT: PASS or FAIL. Exits 0 on
PASS, 2 when the settings or the schema are missing, 1 on any other failure.
"""

from __future__ import annotations

import sys
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from mend_engine import prove_m4a, prove_m4b, store_facts
from mend_engine.campaigns.eligibility import quiet_regular_members
from mend_engine.campaigns.scoring import ScoreSet, score_customers
from mend_engine.config import Config, ConfigError, load_config
from mend_engine.data.uci import CACHE_DIR, ZIP_NAME, SourceError, ensure_source
from mend_engine.db.connect import connect
from mend_engine.members.consent import DEMO_SHOP_NAME
from mend_engine.members.membership import MembershipRefused, join_member
from mend_engine.paypal.payouts import normalise_email
from mend_engine.shop.import_orders import REFUNDS_SOURCE_SUFFIX, ImportRefused, import_refunds, import_uci

ENV_PATH = Path(__file__).resolve().parents[3] / ".env"
ACTOR = "seed_demo"
# The day the demo shop's records run to, the day both proofs score on.
AS_OF = prove_m4a.AS_OF
FACTS = (
    (store_facts.CDNOW_KEY, "cdnow_fact"),
    (store_facts.UCI_KEY, "uci_fact"),
)
# shop_customers.email is unique, so one row holds this while the other takes its email.
# It has no "@", so no member can match it even inside the swap's transaction.
SWAP_PLACEHOLDER = "seed-demo-swap-in-progress"


class SeedRefused(Exception):
    """The seed will not run. The message names the setting, never its value."""


def _imported(conn: psycopg.Connection, source: str) -> bool:
    # import_uci and import_refunds each append one import_runs row when they finish.
    return conn.execute("select exists (select 1 from import_runs where source = %s)", (source,)).fetchone()[0]


def seed_orders(conn: psycopg.Connection) -> str:
    if _imported(conn, ZIP_NAME):
        return "orders: already imported"
    result = import_uci(conn, ensure_source(CACHE_DIR))
    return f"orders: imported {result.orders:,} orders from {result.customers:,} customers"


def seed_refunds(conn: psycopg.Connection) -> str:
    if _imported(conn, ZIP_NAME + REFUNDS_SOURCE_SUFFIX):
        return "refunds: already imported"
    result = import_refunds(conn, ensure_source(CACHE_DIR))
    return f"refunds: imported {result.refunds:,} cancellation records"


def seed_facts(conn: psycopg.Connection) -> str:
    """Computes and stores only the facts that are missing, so a stored fact keeps its time."""
    present = store_facts.read_facts(conn)
    stored = []
    for key, compute in FACTS:
        if present[key] is None:
            store_facts.store(conn, key, getattr(store_facts, compute)())
            stored.append(key)
    return f"facts: stored {', '.join(stored)}" if stored else "facts: already stored"


def shop_scores(conn: psycopg.Connection) -> ScoreSet:
    scores = score_customers(conn, AS_OF)
    if not scores.converged:
        raise LookupError(f"the shop's scores did not converge ({scores.message})")
    return scores


def seed_members(conn: psycopg.Connection, config: Config, scores: ScoreSet) -> str:
    before = conn.execute("select count(*) from members").fetchone()[0]
    joined = prove_m4a.join_demo_members(conn, config, prove_m4a.demo_customers(scores))
    after = conn.execute("select count(*) from members").fetchone()[0]
    return f"members: {len(joined)} demo members ({after - before} new)"


def seed_receiver(conn: psycopg.Connection, config: Config, scores: ScoreSet) -> str:
    receiver = normalise_email(config.test_receiver or "")
    linked = conn.execute("select 1 from shop_customers where email = %s", (receiver,)).fetchone() is not None
    if not linked:
        ref = prove_m4b.unlinked_quiet_regular(conn, scores)
        with conn.transaction():
            conn.execute("update shop_customers set email = %s where customer_ref = %s", (receiver, ref))
            conn.execute(
                "insert into audit_log (actor, action, detail) values (%s, %s, %s)",
                (ACTOR, "shop_customer_linked_to_sandbox_receiver", Jsonb({"customer_ref": ref})),
            )
    join_member(
        conn, paypal_email=receiver, paypal_payer_id=None, email_verified=True,
        shop_name=DEMO_SHOP_NAME, client_id=config.paypal_client_id,
    )
    return "receiver: MEND_TEST_RECEIVER is a verified member " + ("linked to one quiet regular" if not linked else "already linked")


def seed_receiver_first(conn: psycopg.Connection, config: Config, scores: ScoreSet) -> str:
    """Make the MEND_TEST_RECEIVER member the most at-risk eligible member.

    The receiver is the one sandbox account that can really claim a payout, so it stands
    in for the most at-risk quiet regular: a default demo draft takes the 10 most at-risk
    members, and with the receiver first it is always considered and can land in the
    rewarded half. The emails on two shop_customers rows trade places in one
    transaction: the row the first eligible member matches and the row the receiver
    matches. No member row changes and the member set stays the same; only which order
    history each of the two members matches. Payouts still go to each member's own
    PayPal email (C5 restated).

    Ranks with quiet_regular_members at the day scores were computed for. Returns
    "receiver: already first" and changes nothing when it is; otherwise writes one
    audit_log row holding from_customer_ref, to_customer_ref and was_rank, never an
    email. Raises LookupError, changing nothing, when no member is eligible, when the
    receiver is not an eligible member (a swap would then push the displaced member
    out of the eligible set), or when either row changed before it could be locked.
    """
    receiver = normalise_email(config.test_receiver or "")
    ranked = quiet_regular_members(conn, scores, scores.as_of)
    if not ranked:
        raise LookupError("no member is eligible, so the test receiver cannot be moved first")
    emails = {member_id: normalise_email(email) for member_id, email in conn.execute("select member_id, paypal_email from members")}
    at = next((i for i, candidate in enumerate(ranked) if emails.get(candidate.member_id) == receiver), None)
    if at is None:
        raise LookupError("the test receiver is not an eligible member; run seed_receiver first")
    if at == 0:
        return "receiver: already first"
    first, mine = ranked[0], ranked[at]
    with conn.transaction():
        held = dict(
            conn.execute(
                "select customer_ref, email from shop_customers where customer_ref = any(%s) for update",
                ([first.customer_ref, mine.customer_ref],),
            )
        )
        still_mine = normalise_email(held.get(mine.customer_ref, "")) == receiver
        still_first = normalise_email(held.get(first.customer_ref, "")) == emails[first.member_id]
        if not (still_mine and still_first):
            raise LookupError("a shop record changed while the test receiver was being moved first")
        update = "update shop_customers set email = %s where customer_ref = %s"
        conn.execute(update, (SWAP_PLACEHOLDER, mine.customer_ref))
        conn.execute(update, (held[mine.customer_ref], first.customer_ref))
        conn.execute(update, (held[first.customer_ref], mine.customer_ref))
        conn.execute(
            "insert into audit_log (actor, action, detail) values (%s, %s, %s)",
            (
                ACTOR,
                "sandbox_receiver_moved_first",
                Jsonb({"from_customer_ref": mine.customer_ref, "to_customer_ref": first.customer_ref, "was_rank": at + 1}),
            ),
        )
    return f"receiver: moved to rank 1 (was rank {at + 1})"


def run(config: Config) -> bool:
    """Seed the database config points at, printing one line per step. Raises SeedRefused or ConfigError when it cannot start."""
    if not config.test_receiver:
        raise SeedRefused("MEND_TEST_RECEIVER must be set")
    try:
        conn = connect(config)
    except psycopg.Error as exc:
        raise SeedRefused(f"the database could not be reached ({type(exc).__name__})") from None
    with conn:
        for step in (seed_orders, seed_refunds, seed_facts):
            print(step(conn), flush=True)
        scores = shop_scores(conn)
        print(seed_members(conn, config, scores), flush=True)
        print(seed_receiver(conn, config, scores), flush=True)
        print(seed_receiver_first(conn, config, scores), flush=True)
    return True


def main() -> int:
    try:
        config = load_config(str(ENV_PATH) if ENV_PATH.is_file() else None)
        passed = run(config)
        code = 0
    except (SeedRefused, ConfigError) as exc:
        print(f"seed_demo: {exc}", file=sys.stderr)
        passed, code = False, 2
    except (ImportRefused, SourceError, MembershipRefused, LookupError, ValueError) as exc:
        print(f"FAIL: {type(exc).__name__}: {exc}", flush=True)
        passed, code = False, 1
    except (OSError, psycopg.Error) as exc:
        # Database errors can quote row values, so only the kind of failure is shown.
        print(f"FAIL: {type(exc).__name__}", flush=True)
        passed, code = False, 1
    print(f"SEED RESULT: {'PASS' if passed else 'FAIL'}", flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
