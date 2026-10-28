/**
 * Engine runs belong to the session that started them, and each task's answer becomes
 * exactly one response shape (C12, C15, C19).
 *
 * A route that answers 202 records the run id under the caller's session id hash in
 * run_owners before answering, so no run id is ever handed out unrecorded. GET
 * /api/runs/[runId] answers only that session; every other caller, and every id nobody
 * recorded, gets the same 404. The route that started a run and the run route both
 * turn a finished run into a response through finishedResponse(), so a polled answer
 * has the shape the original route would have given.
 *
 * Every body passes a strict zod schema before it leaves: the engine's answer is
 * checked as the engine promises it, mapped, and the mapped body checked again, so no
 * field either schema does not list can get out. Summary and quiet-regular bodies also
 * refuse an "@" or a UUID anywhere in them: one check on the whole output, not a list
 * of the fields that might carry one. It covers emails and member ids; it does not
 * cover a person's name, which is synthetic in the demo shop (C25).
 *
 * A simulate answer that passes its schema also records its PayPal order id for the
 * session that started the run (session-orders.ts), whether it reaches that session
 * directly or through a poll, so the assistant can show a demo visitor that order and
 * no other (C18).
 */
import { z } from "zod";
import { database } from "./db";
import { runAndWait, runTask, statusForEngineError, TASK_NAMES, type EngineAnswer, type RunOptions, type TaskName, type Waited } from "./engine";
import { writeLog } from "./log";
import { refuse, reply } from "./permissions";
import { rememberSessionOrder } from "./session-orders";

const SESSION_ID = /^[0-9a-f]{64}$/;
const RUN_ID = /^(?:brn|trn)-[A-Za-z0-9-]{1,80}$/;
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const count = z.number().int().min(0);
const cents = z.number().int().min(0);
const share = z.number().min(0).max(1);
const time = z.iso.datetime({ offset: true });
const day = z.iso.date();
const campaignId = z.uuid();
const status = z.string().regex(/^[a-z_]{1,32}$/);
const memberRef = z.string().regex(/^R[1-9][0-9]{0,3}$/);
// Letters, digits, spaces and ordinary punctuation only: no control or invisible
// characters, and no "@" so an email can never pass for a name.
const displayName = z.string().min(1).max(80).regex(/^[^\p{Cc}\p{Cf}@]+$/u);
// No character from Unicode's "other" group (controls, invisible format marks,
// private-use, unassigned), the same rule the engine applies to a shop name.
const shopName = z.string().min(1).max(100).regex(/^\P{C}+$/u);
const consentText = z.string().min(1).max(1000).regex(/^\P{C}+$/u);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
// The engine's name for the members a demo script joined, whom no person agreed to be (tasks.py SEEDED_LABEL).
// Kept apart from the people who joined, and never added to them.
const seededLabel = z.literal("demo stand-ins");

function carriesNoIdentifier(body: unknown): boolean {
  const text = JSON.stringify(body);
  return !text.includes("@") && !UUID_ANYWHERE.test(text);
}

type Spec = {
  readonly status: 200 | 201;
  /** The body to send for an engine answer, or null when the answer or the body breaks its schema. */
  readonly check: (result: unknown) => Readonly<Record<string, unknown>> | null;
};

function spec<A extends z.ZodType, B extends z.ZodType<Readonly<Record<string, unknown>>>>(
  okStatus: 200 | 201,
  answer: A,
  body: (answer: z.output<A>) => z.input<B>,
  response: B,
): Spec {
  return {
    status: okStatus,
    check(result) {
      const parsed = answer.safeParse(result);
      if (!parsed.success) return null;
      const sent = response.safeParse(body(parsed.data));
      return sent.success ? sent.data : null;
    },
  };
}

const ROW_ANSWER = z.strictObject({
  ref: memberRef,
  role: z.enum(["reward", "holdout"]),
  rank: z.number().int().min(1),
  amount_minor: cents.nullable(),
  note: z.string().max(400).nullable(),
});

const ARM_ANSWER = z.strictObject({ members: count, real_returns: count, real_rate: share.nullable(), simulated_returns: count });
const ARM = z.strictObject({ members: count, realReturns: count, realRate: share.nullable(), simulatedReturns: count });

function arm(answer: z.output<typeof ARM_ANSWER>): z.input<typeof ARM> {
  return { members: answer.members, realReturns: answer.real_returns, realRate: answer.real_rate, simulatedReturns: answer.simulated_returns };
}

const PARAMS_ANSWER = z.strictObject({ r: z.number(), alpha: z.number(), a: z.number(), b: z.number(), log_likelihood: z.number() });
const PARAMS = z.strictObject({ r: z.number(), alpha: z.number(), a: z.number(), b: z.number(), logLikelihood: z.number() });

function params(answer: z.output<typeof PARAMS_ANSWER>): z.input<typeof PARAMS> {
  return { r: answer.r, alpha: answer.alpha, a: answer.a, b: answer.b, logLikelihood: answer.log_likelihood };
}

const BENCHMARK_ANSWER = z.strictObject({
  source: z.string().min(1).max(200),
  customers: count,
  fitted: PARAMS_ANSWER,
  published: PARAMS_ANSWER,
  passed: z.boolean(),
  computed_at: time,
});
const BENCHMARK = z.strictObject({
  source: z.string().min(1).max(200),
  customers: count,
  fitted: PARAMS,
  published: PARAMS,
  passed: z.boolean(),
  computedAt: time,
});

// Any upper-case word, not a list of PayPal's item statuses: a list here would turn a
// status PayPal adds later into a broken results page instead of one more count.
const statusCounts = z.record(z.string().regex(/^[A-Z][A-Z_]{0,31}$/), count).refine((counts) => Object.keys(counts).length <= 20);

const PAYOUTS_ANSWER = z.strictObject({
  items: count,
  by_status: statusCounts,
  claimed_minor: cents,
  unclaimed_minor: cents,
  returned_minor: cents,
  failed_minor: cents,
  pending_minor: cents,
  unclaimed_return_by: time.nullable(),
});
const PAYOUTS = z.strictObject({
  items: count,
  byStatus: statusCounts,
  claimedMinor: cents,
  unclaimedMinor: cents,
  returnedMinor: cents,
  failedMinor: cents,
  pendingMinor: cents,
  unclaimedReturnBy: time.nullable(),
});

function payouts(answer: z.output<typeof PAYOUTS_ANSWER>): z.input<typeof PAYOUTS> {
  return {
    items: answer.items,
    byStatus: answer.by_status,
    claimedMinor: answer.claimed_minor,
    unclaimedMinor: answer.unclaimed_minor,
    returnedMinor: answer.returned_minor,
    failedMinor: answer.failed_minor,
    pendingMinor: answer.pending_minor,
    unclaimedReturnBy: answer.unclaimed_return_by,
  };
}

const CUTOFF_ANSWER =z.strictObject({ cutoff: day, customers: count, converged: z.boolean(), auc_model: share.nullable(), auc_recency: share });
const CUTOFF = z.strictObject({ cutoff: day, customers: count, converged: z.boolean(), aucModel: share.nullable(), aucRecency: share });
const DECILE_ANSWER = z.strictObject({ decile: z.number().int().min(1).max(10), customers: count, returned_share: share });
const DECILE = z.strictObject({ decile: z.number().int().min(1).max(10), customers: count, returnedShare: share });

// The model's AUC minus recency's, and the bounds of its bootstrap interval.
const difference = z.number().min(-1).max(1);
const groupLabel = z.string().regex(/^[a-z ]{1,40}$/);

// One backtest group (store_facts.py _group_fact): the live segment campaigns pick from,
// or every customer. The engine writes null where a group was too small to measure: the
// segment rule for all customers, the pooled difference and interval with no valid
// cutoff, and each cutoff's numbers where nobody in the group came back.
const GROUP_CUTOFF_ANSWER = z.strictObject({
  cutoff: day,
  customers: count,
  returned: count,
  auc_model: share.nullable(),
  auc_recency: share.nullable(),
  difference: difference.nullable(),
  interval_low: difference.nullable(),
  interval_high: difference.nullable(),
});
const GROUP_CUTOFF = z.strictObject({
  cutoff: day,
  customers: count,
  returned: count,
  aucModel: share.nullable(),
  aucRecency: share.nullable(),
  difference: difference.nullable(),
  intervalLow: difference.nullable(),
  intervalHigh: difference.nullable(),
});
const GROUP_ANSWER = z.strictObject({
  group: groupLabel,
  regular_min_days: count.nullable(),
  silent_min_days: count.nullable(),
  confidence: share,
  resamples: count,
  valid_cutoffs: count,
  model_wins: count,
  mean_auc_difference: difference.nullable(),
  interval_low: difference.nullable(),
  interval_high: difference.nullable(),
  cutoffs: z.array(GROUP_CUTOFF_ANSWER).max(20),
});
const GROUP = z.strictObject({
  group: groupLabel,
  regularMinDays: count.nullable(),
  silentMinDays: count.nullable(),
  confidence: share,
  resamples: count,
  validCutoffs: count,
  modelWins: count,
  meanAucDifference: difference.nullable(),
  intervalLow: difference.nullable(),
  intervalHigh: difference.nullable(),
  cutoffs: z.array(GROUP_CUTOFF).max(20),
});

function group(answer: z.output<typeof GROUP_ANSWER>): z.input<typeof GROUP> {
  return {
    group: answer.group,
    regularMinDays: answer.regular_min_days,
    silentMinDays: answer.silent_min_days,
    confidence: answer.confidence,
    resamples: answer.resamples,
    validCutoffs: answer.valid_cutoffs,
    modelWins: answer.model_wins,
    meanAucDifference: answer.mean_auc_difference,
    intervalLow: answer.interval_low,
    intervalHigh: answer.interval_high,
    cutoffs: answer.cutoffs.map((c) => ({
      cutoff: c.cutoff,
      customers: c.customers,
      returned: c.returned,
      aucModel: c.auc_model,
      aucRecency: c.auc_recency,
      difference: c.difference,
      intervalLow: c.interval_low,
      intervalHigh: c.interval_high,
    })),
  };
}

// Every older key keeps its all-customer meaning. headline (the live segment) and
// all_customers were added together, so a row stored before them has neither, and a row
// with only one of them is malformed.
const BACKTEST_ANSWER = z
  .strictObject({
    source: z.string().min(1).max(200),
    holdout_days: count,
    cutoffs: z.array(CUTOFF_ANSWER).max(20),
    converged: count,
    model_wins: count,
    mean_auc_gain: z.number().min(-1).max(1).nullable(),
    decile_cutoff: day.nullable(),
    deciles: z.array(DECILE_ANSWER).max(10),
    passed: z.boolean(),
    computed_at: time,
    headline: GROUP_ANSWER.optional(),
    all_customers: GROUP_ANSWER.optional(),
  })
  .refine((answer) => (answer.headline === undefined) === (answer.all_customers === undefined), "headline and all_customers come together");
// The live-segment headline comes before the all-customer result, and both are null for a row stored before them.
const BACKTEST = z.strictObject({
  source: z.string().min(1).max(200),
  holdoutDays: count,
  headline: GROUP.nullable(),
  allCustomers: GROUP.nullable(),
  cutoffs: z.array(CUTOFF).max(20),
  converged: count,
  modelWins: count,
  meanAucGain: z.number().min(-1).max(1).nullable(),
  decileCutoff: day.nullable(),
  deciles: z.array(DECILE).max(10),
  passed: z.boolean(),
  computedAt: time,
});

const QUIET_ROW_ANSWER = z.strictObject({
  position: z.number().int().min(1).max(50),
  display_name: displayName,
  purchase_days: count,
  days_silent: count,
  score: z.number().min(0),
  paid_net_minor: cents,
  member: z.boolean(),
});
const QUIET_ROW = z.strictObject({
  position: z.number().int().min(1).max(50),
  displayName,
  purchaseDays: count,
  daysSilent: count,
  score: z.number().min(0),
  paidNetMinor: cents,
  member: z.boolean(),
});

const SPECS: Readonly<Record<TaskName, Spec>> = {
  draft_campaign: spec(
    201,
    z.strictObject({ ok: z.literal(true), campaign_id: campaignId, candidates: count, rewarded: count, held_back: count, total_minor: cents }),
    (a) => ({ campaignId: a.campaign_id, candidates: a.candidates, rewarded: a.rewarded, heldBack: a.held_back, totalMinor: a.total_minor }),
    z.strictObject({ campaignId, candidates: count, rewarded: count, heldBack: count, totalMinor: cents }),
  ),
  view_campaign: spec(
    200,
    z.strictObject({
      ok: z.literal(true),
      campaign_id: campaignId,
      status,
      goal_text: z.string().max(500),
      as_of: day,
      budget_minor: cents,
      per_recipient_minor: cents,
      holdout_share: z.string().regex(/^0\.\d{1,2}$/),
      total_minor: cents,
      rows: z.array(ROW_ANSWER).max(250),
      review_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
      review_problem: z.string().regex(/^[a-z][a-z_]{0,63}$/).nullable(),
    }),
    (a) => ({
      campaignId: a.campaign_id,
      status: a.status,
      goalText: a.goal_text,
      asOf: a.as_of,
      budgetMinor: a.budget_minor,
      perRecipientMinor: a.per_recipient_minor,
      holdoutShare: a.holdout_share,
      totalMinor: a.total_minor,
      rows: a.rows.map((row) => ({ ref: row.ref, role: row.role, rank: row.rank, amountMinor: row.amount_minor, note: row.note })),
      reviewHash: a.review_hash,
      reviewProblem: a.review_problem,
    }),
    z.strictObject({
      campaignId,
      status,
      goalText: z.string().max(500),
      asOf: day,
      budgetMinor: cents,
      perRecipientMinor: cents,
      holdoutShare: z.string().regex(/^0\.\d{1,2}$/),
      totalMinor: cents,
      rows: z
        .array(z.strictObject({ ref: memberRef, role: z.enum(["reward", "holdout"]), rank: z.number().int().min(1), amountMinor: cents.nullable(), note: z.string().max(400).nullable() }))
        .max(250),
      reviewHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
      reviewProblem: z.string().regex(/^[a-z][a-z_]{0,63}$/).nullable(),
    }),
  ),
  approve_campaign: spec(
    200,
    z.strictObject({ ok: z.literal(true), campaign_id: campaignId, snapshot_hash: z.string().regex(/^[0-9a-f]{64}$/), approved_at: time }),
    (a) => ({ campaignId: a.campaign_id, snapshotHash: a.snapshot_hash, approvedAt: a.approved_at }),
    z.strictObject({ campaignId, snapshotHash: z.string().regex(/^[0-9a-f]{64}$/), approvedAt: time }),
  ),
  submit_campaign: spec(
    200,
    z.strictObject({ ok: z.literal(true), campaign_id: campaignId, status, sent: z.boolean(), payout_batch_id: z.string().regex(/^[A-Z0-9]{1,64}$/).nullable() }),
    (a) => ({ campaignId: a.campaign_id, status: a.status, sent: a.sent, payoutBatchId: a.payout_batch_id }),
    z.strictObject({ campaignId, status, sent: z.boolean(), payoutBatchId: z.string().regex(/^[A-Z0-9]{1,64}$/).nullable() }),
  ),
  simulate_return: spec(
    201,
    z.strictObject({
      ok: z.literal(true),
      campaign_id: campaignId,
      ref: memberRef,
      paypal_order_id: z.string().regex(/^[A-Z0-9]{1,36}$/),
      paypal_status: z.string().regex(/^[A-Z][A-Z_]{0,35}$/),
    }),
    (a) => ({ campaignId: a.campaign_id, ref: a.ref, paypalOrderId: a.paypal_order_id, paypalStatus: a.paypal_status }),
    z.strictObject({ campaignId, ref: memberRef, paypalOrderId: z.string().regex(/^[A-Z0-9]{1,36}$/), paypalStatus: z.string().regex(/^[A-Z][A-Z_]{0,35}$/) }),
  ),
  results: spec(
    200,
    z.strictObject({
      ok: z.literal(true),
      campaign_id: campaignId,
      status,
      rewarded: ARM_ANSWER,
      holdout: ARM_ANSWER,
      spend_minor: cents,
      fees_minor: cents,
      window_starts_at: time.nullable(),
      window_ends_at: time.nullable(),
      window_open: z.boolean(),
      p_value: share.nullable(),
      verdict: z.string().min(1).max(200),
      payouts: PAYOUTS_ANSWER,
    }),
    (a) => ({
      campaignId: a.campaign_id,
      status: a.status,
      rewarded: arm(a.rewarded),
      holdout: arm(a.holdout),
      spendMinor: a.spend_minor,
      feesMinor: a.fees_minor,
      windowStartsAt: a.window_starts_at,
      windowEndsAt: a.window_ends_at,
      windowOpen: a.window_open,
      pValue: a.p_value,
      verdict: a.verdict,
      payouts: payouts(a.payouts),
    }),
    z.strictObject({
      campaignId,
      status,
      rewarded: ARM,
      holdout: ARM,
      spendMinor: cents,
      feesMinor: cents,
      windowStartsAt: time.nullable(),
      windowEndsAt: time.nullable(),
      windowOpen: z.boolean(),
      pValue: share.nullable(),
      verdict: z.string().min(1).max(200),
      payouts: PAYOUTS,
    }),
  ),
  shop_summary: spec(
    200,
    z.strictObject({
      ok: z.literal(true),
      as_of: day.nullable(),
      shop_customers: count,
      members_joined: count,
      members_seeded: count,
      members_seeded_label: seededLabel,
      quiet_regulars: count,
      quiet_regulars_paid_12m_minor: cents,
      currency: z.literal("USD"),
      benchmark: BENCHMARK_ANSWER.nullable(),
      backtest: BACKTEST_ANSWER.nullable(),
    }),
    (a) => ({
      asOf: a.as_of,
      shopCustomers: a.shop_customers,
      membersJoined: a.members_joined,
      membersSeeded: a.members_seeded,
      membersSeededLabel: a.members_seeded_label,
      quietRegulars: a.quiet_regulars,
      quietRegularsPaid12mMinor: a.quiet_regulars_paid_12m_minor,
      currency: a.currency,
      benchmark:
        a.benchmark === null
          ? null
          : {
              source: a.benchmark.source,
              customers: a.benchmark.customers,
              fitted: params(a.benchmark.fitted),
              published: params(a.benchmark.published),
              passed: a.benchmark.passed,
              computedAt: a.benchmark.computed_at,
            },
      backtest:
        a.backtest === null
          ? null
          : {
              source: a.backtest.source,
              holdoutDays: a.backtest.holdout_days,
              headline: a.backtest.headline === undefined ? null : group(a.backtest.headline),
              allCustomers: a.backtest.all_customers === undefined ? null : group(a.backtest.all_customers),
              cutoffs: a.backtest.cutoffs.map((c) => ({ cutoff: c.cutoff, customers: c.customers, converged: c.converged, aucModel: c.auc_model, aucRecency: c.auc_recency })),
              converged: a.backtest.converged,
              modelWins: a.backtest.model_wins,
              meanAucGain: a.backtest.mean_auc_gain,
              decileCutoff: a.backtest.decile_cutoff,
              deciles: a.backtest.deciles.map((d) => ({ decile: d.decile, customers: d.customers, returnedShare: d.returned_share })),
              passed: a.backtest.passed,
              computedAt: a.backtest.computed_at,
            },
    }),
    z
      .strictObject({
        asOf: day.nullable(),
        shopCustomers: count,
        membersJoined: count,
        membersSeeded: count,
        membersSeededLabel: seededLabel,
        quietRegulars: count,
        quietRegularsPaid12mMinor: cents,
        currency: z.literal("USD"),
        benchmark: BENCHMARK.nullable(),
        backtest: BACKTEST.nullable(),
      })
      .refine(carriesNoIdentifier, "the summary carries an email or a UUID"),
  ),
  quiet_regulars: spec(
    200,
    z.strictObject({ ok: z.literal(true), as_of: day.nullable(), total: count, rows: z.array(QUIET_ROW_ANSWER).max(50) }),
    (a) => ({
      asOf: a.as_of,
      total: a.total,
      rows: a.rows.map((row) => ({
        position: row.position,
        displayName: row.display_name,
        purchaseDays: row.purchase_days,
        daysSilent: row.days_silent,
        score: row.score,
        paidNetMinor: row.paid_net_minor,
        member: row.member,
      })),
    }),
    z
      .strictObject({ asOf: day.nullable(), total: count, rows: z.array(QUIET_ROW).max(50) })
      .refine(carriesNoIdentifier, "the list carries an email or a UUID"),
  ),
  process_events: spec(
    200,
    z.strictObject({
      ok: z.literal(true),
      ran: z.boolean(),
      outcomes: z.record(z.string().regex(/^[a-z][a-z ]{0,31}$/), count).refine((o) => Object.keys(o).length <= 20),
      retrying: count,
    }),
    (a) => ({ ran: a.ran, outcomes: a.outcomes, retrying: a.retrying }),
    z.strictObject({
      ran: z.boolean(),
      outcomes: z.record(z.string().regex(/^[a-z][a-z ]{0,31}$/), count).refine((o) => Object.keys(o).length <= 20),
      retrying: count,
    }),
  ),
  reconcile: spec(
    200,
    z.strictObject({ ok: z.literal(true), ran: z.boolean(), looked_at: count, sent: count, waiting: count }),
    (a) => ({ ran: a.ran, lookedAt: a.looked_at, sent: a.sent, waiting: a.waiting }),
    z.strictObject({ ran: z.boolean(), lookedAt: count, sent: count, waiting: count }),
  ),
  purge: spec(
    200,
    z.strictObject({ ok: z.literal(true), deleted: count }),
    (a) => ({ deleted: a.deleted }),
    z.strictObject({ deleted: count }),
  ),
  draft_limits: spec(
    200,
    z.strictObject({ ok: z.literal(true), as_of: day.nullable(), campaign_cap_minor: cents.min(1), item_cap_minor: cents.min(1) }),
    (a) => ({ asOf: a.as_of, campaignCapMinor: a.campaign_cap_minor, itemCapMinor: a.item_cap_minor }),
    z.strictObject({ asOf: day.nullable(), campaignCapMinor: cents.min(1), itemCapMinor: cents.min(1) }),
  ),
  // What one customer's note is written from, on its way to the model: printable ASCII
  // item names, and no "@" or UUID anywhere (C15).
  note_context: spec(
    200,
    z.strictObject({
      ok: z.literal(true),
      shop_name: z.string().min(1).max(200).regex(/^[\x20-\x7e]+$/),
      recent_items: z.array(z.string().min(1).max(60).regex(/^[\x20-\x7e]+$/)).max(5),
      days_since_last_order: count.nullable(),
    }),
    (a) => ({ shopName: a.shop_name, recentItems: a.recent_items, daysSinceLastOrder: a.days_since_last_order }),
    z
      .strictObject({
        shopName: z.string().min(1).max(200),
        recentItems: z.array(z.string().min(1).max(60)).max(5),
        daysSinceLastOrder: count.nullable(),
      })
      .refine(carriesNoIdentifier, "the note context carries an email or a UUID"),
  ),
  set_note: spec(
    200,
    z.strictObject({ ok: z.literal(true), campaign_id: campaignId, ref: memberRef, template: z.boolean() }),
    (a) => ({ campaignId: a.campaign_id, ref: a.ref, template: a.template }),
    z.strictObject({ campaignId, ref: memberRef, template: z.boolean() }),
  ),
  request_approval: spec(
    200,
    z.strictObject({ ok: z.literal(true), campaign_id: campaignId, status: z.literal("awaiting_approval") }),
    (a) => ({ campaignId: a.campaign_id, status: a.status }),
    z.strictObject({ campaignId, status: z.literal("awaiting_approval") }),
  ),
  // The join link carries hash back unchanged, so a join is bound to these exact words (C28).
  consent_text: spec(
    200,
    z.strictObject({ ok: z.literal(true), shop_name: shopName, text: consentText, hash: sha256Hex }),
    (a) => ({ shopName: a.shop_name, text: a.text, hash: a.hash }),
    z.strictObject({ shopName, text: consentText, hash: sha256Hex }),
  ),
  // Joining and leaving answer the outcome only: the member id stays on the server (C15).
  join: spec(
    200,
    z.strictObject({ ok: z.literal(true), member_id: z.uuid(), created: z.boolean(), linked: z.boolean() }),
    (a) => ({ outcome: "joined" as const, linked: a.linked }),
    z.strictObject({ outcome: z.literal("joined"), linked: z.boolean() }),
  ),
  leave: spec(
    200,
    z.strictObject({ ok: z.literal(true), left: z.boolean(), voided: count }),
    () => ({ outcome: "left" as const }),
    z.strictObject({ outcome: z.literal("left") }),
  ),
  cancel_unclaimed: spec(
    200,
    z.strictObject({ ok: z.literal(true), campaign_id: campaignId, cancelled: count, returned_minor: cents, still_unclaimed: count, not_cancellable: count }),
    (a) => ({ campaignId: a.campaign_id, cancelled: a.cancelled, returnedMinor: a.returned_minor, stillUnclaimed: a.still_unclaimed, notCancellable: a.not_cancellable }),
    z.strictObject({ campaignId, cancelled: count, returnedMinor: cents, stillUnclaimed: count, notCancellable: count }),
  ),
};

const RUNNING = z.strictObject({ status: z.literal("running"), runId: z.string().regex(RUN_ID) });

function checkedOwner(runId: string, sessionId: string, task: TaskName): void {
  if (!RUN_ID.test(runId) || !SESSION_ID.test(sessionId) || !(TASK_NAMES as readonly string[]).includes(task)) {
    throw new Error("a run owner needs a run id, a session id hash and a task name of the right shapes");
  }
}

/**
 * Record that the session with id hash sessionId started run runId of task. Recording
 * the same run for the same session again is harmless. Throws if the run is already
 * recorded under another session, so its id is never handed to a second owner.
 */
export async function recordRun(runId: string, sessionId: string, task: TaskName): Promise<void> {
  checkedOwner(runId, sessionId, task);
  const pool = database();
  await pool.query("insert into run_owners (run_id, session_id_hash, task) values ($1, $2, $3) on conflict (run_id) do nothing", [runId, sessionId, task]);
  const { rows } = await pool.query<{ session_id_hash: string; task: string }>("select session_id_hash, task from run_owners where run_id = $1", [runId]);
  if (rows.length !== 1 || rows[0].session_id_hash !== sessionId || rows[0].task !== task) {
    throw new Error("this run is recorded under another session or task");
  }
}

// Who started each simulate run a poll has asked about. The poll route reads a run's
// owner here (ownedRunTask) before it builds the answer (finishedResponse), and recordRun
// gives a run id exactly one owner, so the session noted for a run is always the one that
// started it. Kept for as long as a run may be polled, and for at most this many runs.
const SIMULATE_OWNER_MS = 60 * 60 * 1000;
const MAX_SIMULATE_OWNERS = 1000;
const simulateOwners = new Map<string, { readonly sessionId: string; readonly at: number }>();

function noteSimulateOwner(runId: string, sessionId: string): void {
  const now = Date.now();
  simulateOwners.delete(runId);
  simulateOwners.set(runId, { sessionId, at: now });
  for (const [id, owner] of simulateOwners) {
    if (simulateOwners.size <= MAX_SIMULATE_OWNERS && now - owner.at < SIMULATE_OWNER_MS) break;
    simulateOwners.delete(id);
  }
}

function simulateOwner(runId: string): string | null {
  const owner = simulateOwners.get(runId);
  return owner !== undefined && Date.now() - owner.at < SIMULATE_OWNER_MS ? owner.sessionId : null;
}

/** The task of run runId if the session with id hash sessionId started it, otherwise null. */
export async function ownedRunTask(runId: string, sessionId: string): Promise<TaskName | null> {
  if (!RUN_ID.test(runId) || !SESSION_ID.test(sessionId)) return null;
  const { rows } = await database().query<{ task: string }>("select task from run_owners where run_id = $1 and session_id_hash = $2", [runId, sessionId]);
  const task = TASK_NAMES.find((name) => name === rows[0]?.task) ?? null;
  if (task === "simulate_return") noteSimulateOwner(runId, sessionId);
  return task;
}

/** True when the caller asked not to wait for the work (Prefer: respond-async, RFC 7240). */
export function prefersAsync(request: Request): boolean {
  const prefer = request.headers.get("prefer");
  if (prefer === null) return false;
  return prefer.split(",").some((part) => part.split(";")[0].trim().toLowerCase() === "respond-async");
}

/** 202 with the run id, for a run already recorded to its session. */
export function runningResponse(route: string, ref: string, task: TaskName, runId: string): Response {
  writeLog({ kind: "api", route, ref, status: 202, outcome: "running", task, run_id: runId });
  return reply(202, RUNNING.parse({ status: "running", runId }));
}

/** Record runId under the caller's session, then answer 202 with it. */
export async function pendingResponse(route: string, ref: string, task: TaskName, runId: string, sessionId: string): Promise<Response> {
  await recordRun(runId, sessionId, task);
  return runningResponse(route, ref, task, runId);
}

/**
 * The response for a finished run of task, exactly as the route that started it gives
 * it: the engine's refusal with its code, status and ref; 500 for a failed run or an
 * answer that does not fit the task's schema; otherwise the task's success status and
 * its checked body. sessionId is the session the answer goes to, when the caller knows
 * it; a poll leaves it out and the owner ownedRunTask noted is used. A checked simulate
 * answer records its order id for that session; with no known session, nothing is
 * recorded.
 */
export function finishedResponse(
  route: string,
  ref: string,
  task: TaskName,
  runId: string,
  run: { readonly status: "succeeded" | "failed"; readonly result?: EngineAnswer },
  sessionId: string | null = null,
): Response {
  if (run.status === "failed" || run.result === undefined) return refuse(route, ref, 500, "internal", { reason: "run_failed", run_id: runId });
  if (!run.result.ok) {
    const code = run.result.error;
    return refuse(route, run.result.ref, statusForEngineError(code), code, { run_id: runId });
  }
  const { status: okStatus, check } = SPECS[task];
  const body = check(run.result);
  if (body === null) return refuse(route, ref, 500, "internal", { reason: "malformed_answer", task, run_id: runId });
  if (task === "simulate_return" && typeof body.paypalOrderId === "string") {
    const buyer = sessionId ?? simulateOwner(runId);
    if (buyer !== null) rememberSessionOrder(buyer, body.paypalOrderId);
  }
  writeLog({ kind: "api", route, ref, status: okStatus, outcome: "answered", task, run_id: runId });
  return reply(okStatus, body);
}

/** finishedResponse for a run that finished in time, or a recorded 202 for one still going. */
export async function waitedResponse(route: string, ref: string, task: TaskName, waited: Waited, sessionId: string): Promise<Response> {
  if (waited.state === "pending") return pendingResponse(route, ref, task, waited.runId, sessionId);
  return finishedResponse(route, ref, task, waited.runId, waited, sessionId);
}

/**
 * Start task for the signed-in session and answer: at once with a recorded 202 when
 * the request says Prefer: respond-async, otherwise after waiting up to waitMs.
 */
export async function engineResponse(
  request: Request,
  route: string,
  ref: string,
  task: TaskName,
  args: readonly unknown[],
  waitMs: number,
  sessionId: string,
  options: RunOptions = {},
): Promise<Response> {
  if (prefersAsync(request)) return pendingResponse(route, ref, task, await runTask(task, args, options), sessionId);
  return waitedResponse(route, ref, task, await runAndWait(task, args, waitMs, options), sessionId);
}

/** The body task's success answer would carry, or null when result does not fit. For the public summary's cache. */
export function successBody(task: TaskName, result: EngineAnswer): Readonly<Record<string, unknown>> | null {
  return SPECS[task].check(result);
}
