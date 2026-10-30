"""Seeds the demo shop on the configured database: python -m mend_engine.seed_demo

Run once on a fresh deploy, after python -m mend_engine.db.migrate. It never applies the
schema itself: connect() refuses a database without it. In order, each step skipped
when it is already done, so a second run changes nothing:

1. orders: the UCI Online Retail II invoices as the shop's own order records (import_uci)
2. refunds: its cancellation invoices as the shop's refunds (import_refunds)
3. facts: the model's measured proof numbers for the landing page (store_facts)
4. members: the 40 quiet regulars worth a nudge at ranks 2 to 41, biggest spenders
   first, chosen as prove_m4a chooses them, joined as verified demo stand-ins (source
   'seed', actor seed_demo) on the current consent wording; stand-ins this seed made
   earlier are labelled seed and re-consented, and every other stand-in leaves, so a
   database seeded under the earlier "most at risk" rule is repaired by running again
5. receiver: MEND_TEST_RECEIVER, the sandbox account that can really claim a payout,
   joined as a verified member linked to one more quiet regular, chosen as prove_m4b
   chooses it; a row the receiver made itself through Log in with PayPal is left as is
6. receiver first: that member linked to rank 1 of the worth-a-nudge group, which no
   stand-in holds, so it is the first eligible member and a default demo draft always
   considers it; no member is displaced (seed_receiver_first)

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
from mend_engine.campaigns.eligibility import OWNER_SCOPE, held_members, quiet_regular_members, worth_a_nudge_refs
from mend_engine.campaigns.scoring import ScoreSet, score_customers
from mend_engine.config import Config, ConfigError, load_config
from mend_engine.data.uci import CACHE_DIR, ZIP_NAME, SourceError, ensure_source
from mend_engine.db.connect import connect
from mend_engine.members.consent import ACCEPTED_CONSENT_VERSIONS, DEMO_SHOP_NAME
from mend_engine.members.membership import SOURCE_SEED, MembershipRefused, customer_refs_by_email, join_member, leave_member
from mend_engine.paypal.payouts import normalise_email
from mend_engine.shop.identities import synthetic_email
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
    """Computes and stores only the facts that are missing or out of date, so a current fact keeps its time.

    A backtest stored before the live-segment headline or the forecast bands existed is
    out of date: the landing page would show it without the results campaigns actually
    depend on.
    """
    present = store_facts.read_facts(conn)
    current = store_facts.UCI_GROUP_KEYS | {store_facts.UCI_BANDS_KEY}
    stored = []
    for key, compute in FACTS:
        fact = present[key]
        outdated = key == store_facts.UCI_KEY and fact is not None and not current <= fact.keys()
        if fact is None or outdated:
            store_facts.store(conn, key, getattr(store_facts, compute)())
            stored.append(key)
    return f"facts: stored {', '.join(stored)}" if stored else "facts: already stored"


def shop_scores(conn: psycopg.Connection) -> ScoreSet:
    scores = score_customers(conn, AS_OF)
    if not scores.converged:
        raise LookupError(f"the shop's scores did not converge ({scores.message})")
    return scores


def seed_members(conn: psycopg.Connection, config: Config, scores: ScoreSet) -> str:
    """Join the 40 demo stand-ins as seed rows on the current wording, labelling any this seed made before members had a source, and remove every other stand-in.

    The stand-ins are the synthetic addresses of the 40 demo customers, fixed by
    customer_ref, so moving the test receiver first (which trades shop emails)
    never changes the list, and the receiver's own address is never on it. Rows on
    the list still marked paypal_login are labelled seed first, with one audit_log
    row of their member ids, so joining them again re-consents them to the current
    wording (join_member).

    Once the 40 are joined, every member with source 'seed' whose email, after the
    one normaliser, is neither on the list nor the receiver's leaves through
    leave_member, so a database seeded under an earlier rule is repaired by running
    the seed again. leave_member voids drafts, awaiting_approval and approved
    campaigns that include a leaver, and keeps rows past approval with member_id
    null (C28). A paypal_login row is never touched.
    """
    receiver = normalise_email(config.test_receiver or "")
    own = sorted(email for email in (synthetic_email(ref) for ref in prove_m4a.demo_customers(scores)) if email != receiver)
    before = conn.execute("select count(*) from members").fetchone()[0]
    with conn.transaction():
        labelled = [
            str(row[0])
            for row in conn.execute(
                "update members set source = %s where paypal_email = any(%s) and source <> %s returning member_id",
                (SOURCE_SEED, own, SOURCE_SEED),
            )
        ]
        if labelled:
            conn.execute(
                "insert into audit_log (actor, action, detail) values (%s, %s, %s)",
                (ACTOR, "members_labelled_seed", Jsonb({"member_ids": sorted(labelled)})),
            )
    joined = [
        join_member(
            conn, paypal_email=email, paypal_payer_id=None, email_verified=True,
            shop_name=DEMO_SHOP_NAME, client_id=config.paypal_client_id, actor=ACTOR,
        )
        for email in own
    ]
    after = conn.execute("select count(*) from members").fetchone()[0]
    keep = {normalise_email(email) for email in own} | {receiver}
    outside = [
        member_id
        for member_id, email in conn.execute("select member_id, paypal_email from members where source = %s", (SOURCE_SEED,))
        if normalise_email(email) not in keep
    ]
    if outside:
        # leave_member records each removal as the member's own leaving; this row says the seed did it.
        conn.execute(
            "insert into audit_log (actor, action, detail) values (%s, %s, %s)",
            (ACTOR, "stand_ins_outside_group_removed", Jsonb({"member_ids": sorted(str(member_id) for member_id in outside)})),
        )
    left = sum(1 for member_id in outside if leave_member(conn, member_id).removed)
    line = f"members: {len(joined)} demo members ({after - before} new)"
    line += f", {len(labelled)} labelled as demo stand-ins" if labelled else ""
    return line + (f", {left} stand-ins outside the group left" if left else "")


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
    # A receiver row this seed makes is a stand-in; one the receiver made by joining with PayPal is left exactly as it is.
    join_member(
        conn, paypal_email=receiver, paypal_payer_id=None, email_verified=True,
        shop_name=DEMO_SHOP_NAME, client_id=config.paypal_client_id, actor=ACTOR,
    )
    return "receiver: MEND_TEST_RECEIVER is a verified member " + ("linked to one quiet regular" if not linked else "already linked")


def seed_receiver_first(conn: psycopg.Connection, config: Config, scores: ScoreSet) -> str:
    """Link the MEND_TEST_RECEIVER member to rank 1 of the worth-a-nudge group, so it is the first eligible member.

    The receiver is the one sandbox account that can really claim a payout, so it takes
    the history of the first worth-a-nudge customer (eligibility.worth_a_nudge_refs, the
    biggest spender): a default demo draft takes the first members in that order, and
    with the receiver first it is always considered and can land in the rewarded half.
    When the receiver is linked to another row, the emails on two shop_customers rows
    trade places in one transaction: the receiver's row and rank 1's, which no member
    matches, so no member is displaced. No member row changes and the member set stays
    the same. Payouts still go to each member's own PayPal email (C5 restated).

    Returns, changing nothing: "receiver: held by a running measurement" while an owner
    campaign holds the receiver's member (eligibility.held_members); "receiver: waiting
    for the test customer to join again under the current consent" while the receiver's
    own paypal_login row is on a wording outside ACCEPTED_CONSENT_VERSIONS; and
    "receiver: already first" when it is linked to rank 1 and is the first of
    quiet_regular_members. Otherwise moves it and writes one audit_log row holding
    from_customer_ref, to_customer_ref and was_rank (its 1-based place among
    quiet_regular_members before the move, or null when it was not a candidate), never
    an email, and returns "receiver: moved to rank 1 (was rank N)" or "receiver: moved
    to rank 1 (was outside the worth-a-nudge group)".

    Raises LookupError, changing nothing, when no customer is worth a nudge, when the
    receiver is linked to no shop customer, when it is linked to rank 1 but is not the
    first eligible member, when a member's email matches rank 1's row, when either row
    changed before it could be locked, or when after the move the receiver would still
    not be the first eligible member.
    """
    receiver = normalise_email(config.test_receiver or "")
    member = conn.execute("select member_id from members where paypal_email = %s", (receiver,)).fetchone()
    member_id = member[0] if member is not None else None
    if member_id is not None and member_id in held_members(conn, OWNER_SCOPE):
        # It comes free when that measurement ends; the rest of the seed still holds, so say so and stop here.
        return "receiver: held by a running measurement"
    login = conn.execute(
        "select consent_version from members where paypal_email = %s and source = 'paypal_login'", (receiver,)
    ).fetchone()
    if login is not None and login[0] not in ACCEPTED_CONSENT_VERSIONS:
        # A real member row on an earlier consent wording is not eligible until its owner
        # joins again through PayPal; the rest of the seed still holds, so say so and stop here.
        return "receiver: waiting for the test customer to join again under the current consent"
    group = worth_a_nudge_refs(scores)
    if not group:
        raise LookupError("no customer is worth a nudge, so the test receiver cannot be moved first")
    first = group[0]
    linked = customer_refs_by_email(conn).get(receiver)
    if linked is None:
        raise LookupError("the test receiver is linked to no shop customer; run seed_receiver first")
    if linked == first:
        ranked = quiet_regular_members(conn, scores, scores.as_of)
        if ranked and ranked[0].member_id == member_id:
            return "receiver: already first"
        raise LookupError("the test receiver is not an eligible member")
    seen = dict(conn.execute("select customer_ref, email from shop_customers where customer_ref = any(%s)", ([first, linked],)))
    with conn.transaction():
        locked = dict(
            conn.execute(
                "select customer_ref, email from shop_customers where customer_ref = any(%s) for update", ([first, linked],)
            )
        )
        if locked != seen or normalise_email(locked.get(linked, "")) != receiver:
            raise LookupError("a shop record changed while the test receiver was being moved first")
        emails = {normalise_email(email) for (email,) in conn.execute("select paypal_email from members")}
        if normalise_email(locked[first]) in emails:
            raise LookupError("a member matches the first worth-a-nudge customer, so moving the test receiver there would displace them")
        before = quiet_regular_members(conn, scores, scores.as_of)
        was_rank = next((i for i, candidate in enumerate(before, start=1) if candidate.member_id == member_id), None)
        update = "update shop_customers set email = %s where customer_ref = %s"
        conn.execute(update, (SWAP_PLACEHOLDER, linked))
        conn.execute(update, (locked[linked], first))
        conn.execute(update, (locked[first], linked))
        conn.execute(
            "insert into audit_log (actor, action, detail) values (%s, %s, %s)",
            (
                ACTOR,
                "sandbox_receiver_moved_first",
                Jsonb({"from_customer_ref": linked, "to_customer_ref": first, "was_rank": was_rank}),
            ),
        )
        after = quiet_regular_members(conn, scores, scores.as_of)
        if not after or after[0].member_id != member_id:
            raise LookupError("the test receiver would not be the first eligible member after the move")
    if was_rank is None:
        return "receiver: moved to rank 1 (was outside the worth-a-nudge group)"
    return f"receiver: moved to rank 1 (was rank {was_rank})"


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
