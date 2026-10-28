// Covers run ownership against a real Postgres schema, how each task's engine answer
// becomes its route's response (success bodies, refusals, malformed answers, results
// with no p-value yet, and the no-email, no-UUID rule on summary and quiet-regular
// output), and the orders a session bought through simulate being remembered for that
// session alone, from the direct and the polled answer, at most 50 for 24 hours. Does
// NOT cover: the route handlers themselves (npm run prove:m7b polls a run from a second
// session), Render's own run store (engine.test.ts fakes it), or the agent reading those
// orders (agent.test.ts).
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_DIR, SCHEMA_PATH, type DevDatabase } from "../../scripts/dev-database";
import { closeDatabase } from "./db";
import type { EngineAnswer, TaskName } from "./engine";
import { finishedResponse, ownedRunTask, pendingResponse, prefersAsync, recordRun, successBody, waitedResponse } from "./runs";
import { MAX_ORDERS_PER_SESSION, ORDER_MEMORY_MS, rememberSessionOrder, sessionBoughtOrder } from "./session-orders";

// Applies the schema to its own throwaway schema; only the database server is shared.
async function holdDatabaseServer(): Promise<DevDatabase> {
  const python = path.join(ENGINE_DIR, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const code = [
    "import sys, pgserver",
    "from mend_engine.db.connect import PGDATA",
    "print(pgserver.get_server(PGDATA, cleanup_mode='stop').get_uri(), flush=True)",
    "sys.stdin.read()",
  ].join("\n");
  const child = spawn(python, ["-c", code], { cwd: ENGINE_DIR, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const exited = once(child, "exit");
  const url = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      if (out.includes("\n")) resolve(out.trim());
    });
    child.once("exit", (status) => reject(new Error(`database server holder exited with ${status}`)));
  });
  return {
    url,
    async release() {
      child.stdin.end();
      await exited;
    },
  };
}

const ROUTE = "GET /api/test";
const REF = "6f1c1d3e-2b9a-4f0e-9a51-3c1d2e4f5a6b";
const CAMPAIGN = "0b6c2f8e-6a4e-4c1b-9d2a-7e5f1a3b9c4d";
const SESSION_A = "a".repeat(64);
const SESSION_B = "b".repeat(64);
const RUN = "brn-1c9e8f00-1111-4222-8333-944445555666";
let dev: DevDatabase;
let admin: pg.Client;
let logLines: string[] = [];
const schema = `web_runs_${process.pid}_${Date.now()}`;

const QUIET_ROW = { position: 1, display_name: "Priya X.", purchase_days: 7, days_silent: 95, score: 0.0812, paid_net_minor: 48210, member: true };
const BENCHMARK = {
  source: "CDNOW sample, Fader, Hardie and Lee (2005)",
  customers: 2357,
  fitted: { r: 0.2426, alpha: 4.4136, a: 0.7929, b: 2.4259, log_likelihood: -9582.43 },
  published: { r: 0.243, alpha: 4.414, a: 0.793, b: 2.426, log_likelihood: -9582.4 },
  passed: true,
  computed_at: "2026-10-24T05:34:54.258140+00:00",
};
const BACKTEST = {
  source: "UCI Online Retail II (Chen 2012, CC BY 4.0)",
  holdout_days: 91,
  cutoffs: [{ cutoff: "2011-09-09", customers: 5256, converged: true, auc_model: 0.8007, auc_recency: 0.7626 }],
  converged: 1,
  model_wins: 1,
  mean_auc_gain: 0.0381,
  decile_cutoff: "2011-09-09",
  deciles: [{ decile: 10, customers: 525, returned_share: 0.0952 }],
  passed: true,
  computed_at: "2026-10-24T05:35:27.783038+00:00",
};
// The live segment and all customers as store_facts.py _group_fact writes them, with today's measured pooled numbers.
const HEADLINE = {
  group: "live segment",
  regular_min_days: 3,
  silent_min_days: 60,
  confidence: 0.95,
  resamples: 1000,
  valid_cutoffs: 5,
  model_wins: 3,
  mean_auc_difference: -0.005,
  interval_low: -0.024,
  interval_high: 0.016,
  cutoffs: [
    { cutoff: "2011-09-09", customers: 812, returned: 97, auc_model: 0.612, auc_recency: 0.618, difference: -0.006, interval_low: -0.031, interval_high: 0.019 },
    { cutoff: "2010-12-01", customers: 40, returned: 0, auc_model: null, auc_recency: null, difference: null, interval_low: null, interval_high: null },
  ],
};
const ALL_CUSTOMERS = {
  group: "all customers",
  regular_min_days: null,
  silent_min_days: null,
  confidence: 0.95,
  resamples: 1000,
  valid_cutoffs: 5,
  model_wins: 5,
  mean_auc_difference: 0.052,
  interval_low: 0.048,
  interval_high: 0.057,
  cutoffs: [{ cutoff: "2011-09-09", customers: 5256, returned: 1873, auc_model: 0.8007, auc_recency: 0.7626, difference: 0.0381, interval_low: 0.031, interval_high: 0.045 }],
};
const SUMMARY = {
  ok: true,
  as_of: "2026-10-16",
  shop_customers: 5852,
  members_joined: 1,
  members_seeded: 40,
  members_seeded_label: "demo stand-ins",
  quiet_regulars: 1357,
  quiet_regulars_paid_12m_minor: 123456789,
  currency: "USD",
  benchmark: BENCHMARK,
  backtest: BACKTEST,
} as const;

function finished(task: TaskName, result: EngineAnswer | undefined, status: "succeeded" | "failed" = "succeeded"): Response {
  return finishedResponse(ROUTE, REF, task, RUN, { status, result });
}

beforeAll(async () => {
  dev = await holdDatabaseServer();
  admin = new pg.Client({ connectionString: dev.url });
  await admin.connect();
  const quoted = admin.escapeIdentifier(schema);
  await admin.query(`create schema ${quoted}`);
  await admin.query(`set search_path to ${quoted}`);
  await admin.query(readFileSync(SCHEMA_PATH, "utf8"));
  const url = new URL(dev.url);
  url.searchParams.set("options", `-c search_path=${schema}`);
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  vi.stubEnv("PAYPAL_CLIENT_ID", "fake-client-id");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "fake-client-secret");
  vi.stubEnv("PAYPAL_WEBHOOK_ID", "TESTWEBHOOK1");
  vi.stubEnv("DATABASE_URL", url.href);
});

afterAll(async () => {
  await closeDatabase();
  if (admin) {
    await admin.query(`drop schema if exists ${admin.escapeIdentifier(schema)} cascade`);
    await admin.end();
  }
  await dev?.release();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  logLines = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    logLines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  return () => vi.restoreAllMocks();
});

describe("the consent the engine really sends", () => {
  it("passes the engine's own consent sentence and hash, whatever its length", () => {
    const python = path.join(ENGINE_DIR, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const code = [
      "import json",
      "from mend_engine.members.consent import DEMO_SHOP_NAME, consent_hash, consent_text_for",
      "text = consent_text_for(DEMO_SHOP_NAME)",
      "print(json.dumps({'ok': True, 'shop_name': DEMO_SHOP_NAME, 'text': text, 'hash': consent_hash(text)}))",
    ].join("; ");
    const answer = JSON.parse(execFileSync(python, ["-c", code], { cwd: ENGINE_DIR, encoding: "utf8", windowsHide: true })) as EngineAnswer;
    const response = finished("consent_text", answer);
    expect(response.status).toBe(200);
  });
});

describe("run ownership", () => {
  it("answers only the session that recorded the run, and nobody for a run never recorded", async () => {
    await recordRun(RUN, SESSION_A, "submit_campaign");
    expect(await ownedRunTask(RUN, SESSION_A)).toBe("submit_campaign");
    expect(await ownedRunTask(RUN, SESSION_B)).toBeNull();
    expect(await ownedRunTask("brn-00000000-0000-4000-8000-000000000000", SESSION_A)).toBeNull();
  });

  it("lets the same session record a run twice but never hands it to a second session", async () => {
    const run = "trn-abc123SECOND";
    await recordRun(run, SESSION_A, "view_campaign");
    await recordRun(run, SESSION_A, "view_campaign");
    await expect(recordRun(run, SESSION_B, "view_campaign")).rejects.toThrow("another session");
    await expect(recordRun(run, SESSION_A, "purge")).rejects.toThrow("another session");
    const { rows } = await admin.query("select session_id_hash, task from run_owners where run_id = $1", [run]);
    expect(rows).toEqual([{ session_id_hash: SESSION_A, task: "view_campaign" }]);
  });

  it("refuses ids of the wrong shape before touching the database", async () => {
    await expect(recordRun("run-1", SESSION_A, "purge")).rejects.toThrow();
    await expect(recordRun(RUN, "A".repeat(64), "purge")).rejects.toThrow();
    await expect(recordRun(RUN, SESSION_A, "drop_everything" as TaskName)).rejects.toThrow();
    expect(await ownedRunTask("' or 1=1 --", SESSION_A)).toBeNull();
  });

  it("records a pending run before answering 202 with only its status and id", async () => {
    const run = "brn-2c9e8f00-1111-4222-8333-944445555666";
    const response = await pendingResponse(ROUTE, REF, "results", run, SESSION_B);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "running", runId: run });
    expect(await ownedRunTask(run, SESSION_B)).toBe("results");
  });

  it("reads Prefer: respond-async however the header lists it", () => {
    const withPrefer = (value: string) => new Request("http://127.0.0.1/x", { headers: { prefer: value } });
    expect(prefersAsync(withPrefer("respond-async"))).toBe(true);
    expect(prefersAsync(withPrefer("return=minimal, Respond-Async; wait=5"))).toBe(true);
    expect(prefersAsync(withPrefer("respond-asyncx"))).toBe(false);
    expect(prefersAsync(new Request("http://127.0.0.1/x"))).toBe(false);
  });
});

describe("finished runs become each route's own response", () => {
  it("a draft answers 201 with exactly the draft's counts", async () => {
    const response = finished("draft_campaign", { ok: true, campaign_id: CAMPAIGN, candidates: 20, rewarded: 10, held_back: 10, total_minor: 100 });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ campaignId: CAMPAIGN, candidates: 20, rewarded: 10, heldBack: 10, totalMinor: 100 });
  });

  it("an approval answers 200, and a hash mismatch or a recipient who left answers 409 with its code", async () => {
    const approved = finished("approve_campaign", { ok: true, campaign_id: CAMPAIGN, snapshot_hash: "f".repeat(64), approved_at: "2026-10-24T05:00:00.123456+00:00" });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ campaignId: CAMPAIGN, snapshotHash: "f".repeat(64), approvedAt: "2026-10-24T05:00:00.123456+00:00" });
    for (const code of ["hash_mismatch", "recipient_not_member", "voided"]) {
      const refusal = finished("approve_campaign", { ok: false, error: code, ref: REF });
      expect(refusal.status).toBe(409);
      expect(await refusal.json()).toEqual({ error: code, message: expect.any(String), ref: REF });
    }
  });

  it("a submit, a simulate and the results keep their own shapes", async () => {
    const sent = finished("submit_campaign", { ok: true, campaign_id: CAMPAIGN, status: "submitted", sent: true, payout_batch_id: "X9AW6MCXMRDF4" });
    expect(await sent.json()).toEqual({ campaignId: CAMPAIGN, status: "submitted", sent: true, payoutBatchId: "X9AW6MCXMRDF4" });
    const bought = finished("simulate_return", { ok: true, campaign_id: CAMPAIGN, ref: "R3", paypal_order_id: "5O190127TN364715T", paypal_status: "COMPLETED" });
    expect(bought.status).toBe(201);
    expect(await bought.json()).toEqual({ campaignId: CAMPAIGN, ref: "R3", paypalOrderId: "5O190127TN364715T", paypalStatus: "COMPLETED" });
    const arm = { members: 10, real_returns: 0, real_rate: 0, simulated_returns: 1 };
    const results = finished("results", {
      ok: true,
      campaign_id: CAMPAIGN,
      status: "submitted",
      rewarded: arm,
      holdout: { ...arm, simulated_returns: 0 },
      spend_minor: 10,
      fees_minor: 25,
      window_starts_at: "2026-10-24T05:00:00+00:00",
      window_ends_at: "2026-11-23T05:00:00+00:00",
      window_open: true,
      p_value: 0.5,
      verdict: "too early to tell",
      payouts: {
        items: 2,
        by_status: { SUCCESS: 1, UNCLAIMED: 1 },
        claimed_minor: 5,
        unclaimed_minor: 5,
        returned_minor: 0,
        failed_minor: 0,
        pending_minor: 0,
        unclaimed_return_by: "2026-11-23T05:00:00+00:00",
      },
    });
    expect(await results.json()).toMatchObject({ rewarded: { members: 10, realReturns: 0, realRate: 0, simulatedReturns: 1 }, holdout: { simulatedReturns: 0 }, verdict: "too early to tell" });
  });

  it("the summary maps the stored facts and lists nothing the schema does not", async () => {
    const response = finished("shop_summary", SUMMARY);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["asOf", "backtest", "benchmark", "currency", "membersJoined", "membersSeeded", "membersSeededLabel", "quietRegularsPaid12mMinor", "quietRegulars", "shopCustomers"].sort());
    expect(body.benchmark.fitted).toEqual({ r: 0.2426, alpha: 4.4136, a: 0.7929, b: 2.4259, logLikelihood: -9582.43 });
    expect(body.backtest.deciles).toEqual([{ decile: 10, customers: 525, returnedShare: 0.0952 }]);
    expect((await finished("shop_summary", { ...SUMMARY, benchmark: null, backtest: null }).json()).benchmark).toBeNull();
  });

  it("the summary keeps people who joined and the demo stand-ins apart, with the stand-ins' label, and no single members count", async () => {
    const body = await finished("shop_summary", SUMMARY).json();
    expect([body.membersJoined, body.membersSeeded, body.membersSeededLabel]).toEqual([1, 40, "demo stand-ins"]);
    expect(body).not.toHaveProperty("members");
  });

  it.each([
    ["the old single members count", { members: 41 }],
    ["the old count in place of the new ones", { members: 41, members_joined: undefined, members_seeded: undefined, members_seeded_label: undefined }],
    ["no stand-in count", { members_seeded: undefined }],
    ["another label for the stand-ins", { members_seeded_label: "members" }],
    ["a joined count that is not a whole number", { members_joined: 1.5 }],
  ])("the summary's member counts are refused with 500 for %s", (_label, change) => {
    expect(finished("shop_summary", { ...SUMMARY, ...change }).status).toBe(500);
  });

  it("the summary carries the live-segment headline before the all-customer result when the row has them, and null for both from a row stored before them", async () => {
    const withGroups = await finished("shop_summary", { ...SUMMARY, backtest: { ...BACKTEST, headline: HEADLINE, all_customers: ALL_CUSTOMERS } }).json();
    expect(Object.keys(withGroups.backtest).slice(0, 4)).toEqual(["source", "holdoutDays", "headline", "allCustomers"]);
    expect(withGroups.backtest.headline).toEqual({
      group: "live segment",
      regularMinDays: 3,
      silentMinDays: 60,
      confidence: 0.95,
      resamples: 1000,
      validCutoffs: 5,
      modelWins: 3,
      meanAucDifference: -0.005,
      intervalLow: -0.024,
      intervalHigh: 0.016,
      cutoffs: [
        { cutoff: "2011-09-09", customers: 812, returned: 97, aucModel: 0.612, aucRecency: 0.618, difference: -0.006, intervalLow: -0.031, intervalHigh: 0.019 },
        { cutoff: "2010-12-01", customers: 40, returned: 0, aucModel: null, aucRecency: null, difference: null, intervalLow: null, intervalHigh: null },
      ],
    });
    expect(withGroups.backtest.allCustomers).toMatchObject({ group: "all customers", regularMinDays: null, silentMinDays: null, modelWins: 5, meanAucDifference: 0.052, intervalLow: 0.048, intervalHigh: 0.057 });
    expect(withGroups.backtest.modelWins).toBe(1);

    const before = await finished("shop_summary", SUMMARY).json();
    expect([before.backtest.headline, before.backtest.allCustomers]).toEqual([null, null]);
  });

  it.each([
    ["only the headline", { headline: HEADLINE }],
    ["only the all-customer result", { all_customers: ALL_CUSTOMERS }],
    ["a group with a field nobody listed", { headline: { ...HEADLINE, note: "x" }, all_customers: ALL_CUSTOMERS }],
    ["a group missing a field", { headline: HEADLINE, all_customers: { ...ALL_CUSTOMERS, interval_high: undefined } }],
    ["a segment rule given as text", { headline: { ...HEADLINE, regular_min_days: "3" }, all_customers: ALL_CUSTOMERS }],
    ["a difference outside -1 to 1", { headline: { ...HEADLINE, mean_auc_difference: 1.5 }, all_customers: ALL_CUSTOMERS }],
    ["a group cutoff without its returned count", { headline: { ...HEADLINE, cutoffs: [{ ...HEADLINE.cutoffs[0], returned: undefined }] }, all_customers: ALL_CUSTOMERS }],
    ["a group label holding an email", { headline: { ...HEADLINE, group: "ram@shop.example" }, all_customers: ALL_CUSTOMERS }],
  ])("the summary is refused with 500 for a backtest with %s", (_label, groups) => {
    expect(finished("shop_summary", { ...SUMMARY, backtest: { ...BACKTEST, ...groups } }).status).toBe(500);
  });

  it.each([
    ["an extra field", { ...SUMMARY, owner_email: "x" }],
    ["an email in a stored fact", { ...SUMMARY, benchmark: { ...BENCHMARK, source: "ram@shop.example" } }],
    ["a UUID in a stored fact", { ...SUMMARY, backtest: { ...BACKTEST, source: `run ${CAMPAIGN}` } }],
    ["a fact with a field nobody listed", { ...SUMMARY, backtest: { ...BACKTEST, note: "<script>" } }],
  ])("the summary is refused with 500 for %s", async (_label, answer) => {
    const response = finished("shop_summary", answer);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal", message: "Something went wrong.", ref: REF });
  });

  it("quiet regulars carry position, name, numbers and the member flag, and nothing else", async () => {
    const response = finished("quiet_regulars", { ok: true, as_of: "2026-10-16", total: 1357, rows: [QUIET_ROW] });
    const body = await response.json();
    expect(body).toEqual({
      asOf: "2026-10-16",
      total: 1357,
      rows: [{ position: 1, displayName: "Priya X.", purchaseDays: 7, daysSilent: 95, score: 0.0812, paidNetMinor: 48210, member: true }],
    });
    expect(JSON.stringify(body)).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it.each([
    ["an email for a name", { ...QUIET_ROW, display_name: "maya@shop.example" }],
    ["a UUID for a name", { ...QUIET_ROW, display_name: CAMPAIGN }],
    ["a customer ref", { ...QUIET_ROW, customer_ref: "C1042" }],
    ["a member id", { ...QUIET_ROW, member_id: CAMPAIGN }],
    ["a control character in a name", { ...QUIET_ROW, display_name: "Maya‮R." }],
  ])("quiet regulars are refused with 500 for %s", async (_label, row) => {
    const response = finished("quiet_regulars", { ok: true, as_of: "2026-10-16", total: 1, rows: [row] });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/maya|C1042|0b6c2f8e/i);
  });

  it("more than 50 quiet regulars is a malformed answer", () => {
    const rows = Array.from({ length: 51 }, (_, n) => ({ ...QUIET_ROW, position: Math.min(n + 1, 50) }));
    expect(successBody("quiet_regulars", { ok: true, as_of: "2026-10-16", total: 51, rows })).toBeNull();
  });

  it("an engine refusal keeps its code and the engine's ref; a failed run is a generic 500", async () => {
    const refused = finished("draft_campaign", { ok: false, error: "budget_over_cap", ref: REF });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "budget_over_cap", message: "That breaks a rule for this account.", ref: REF });
    const broken = finished("purge", undefined, "failed");
    expect(broken.status).toBe(500);
    expect(logLines.join("")).toContain('"reason":"run_failed"');
  });

  it("the admin jobs answer their counts", async () => {
    expect(await finished("process_events", { ok: true, ran: true, outcomes: { "status recorded": 3, "gave up": 1 }, retrying: 0 }).json()).toEqual({
      ran: true,
      outcomes: { "status recorded": 3, "gave up": 1 },
      retrying: 0,
    });
    expect(await finished("reconcile", { ok: true, ran: true, looked_at: 2, sent: 0, waiting: 1 }).json()).toEqual({ ran: true, lookedAt: 2, sent: 0, waiting: 1 });
    expect(await finished("purge", { ok: true, deleted: 4 }).json()).toEqual({ deleted: 4 });
    expect(finished("process_events", { ok: true, ran: true, outcomes: { "Robert'); drop": 1 }, retrying: 0 }).status).toBe(500);
  });

  it("the M6 tasks keep their own shapes: caps, a note context, a stored note and an approval request", async () => {
    expect(await finished("draft_limits", { ok: true, as_of: "2026-10-16", campaign_cap_minor: 100, item_cap_minor: 10 }).json()).toEqual({
      asOf: "2026-10-16",
      campaignCapMinor: 100,
      itemCapMinor: 10,
    });
    expect(
      await finished("note_context", { ok: true, shop_name: "Wolf and Wren Gifts", recent_items: ["red teapot"], days_since_last_order: 120 }).json(),
    ).toEqual({ shopName: "Wolf and Wren Gifts", recentItems: ["red teapot"], daysSinceLastOrder: 120 });
    expect(await finished("set_note", { ok: true, campaign_id: CAMPAIGN, ref: "R3", template: false }).json()).toEqual({ campaignId: CAMPAIGN, ref: "R3", template: false });
    expect(await finished("request_approval", { ok: true, campaign_id: CAMPAIGN, status: "awaiting_approval" }).json()).toEqual({
      campaignId: CAMPAIGN,
      status: "awaiting_approval",
    });
  });

  it.each([
    ["an email in an item name", { recent_items: ["mail maya@shop.example"] }],
    ["a UUID in an item name", { recent_items: [`item ${CAMPAIGN}`] }],
    ["a control character in an item name", { recent_items: ["tea\u0007pot"] }],
    ["six item names", { recent_items: ["a", "b", "c", "d", "e", "f"] }],
    ["a customer ref", { customer_ref: "C1042" }],
  ])("a note context is refused for %s, so it never reaches the model", (_label, change) => {
    expect(successBody("note_context", { ok: true, shop_name: "Shop", recent_items: ["mug"], days_since_last_order: 90, ...change })).toBeNull();
  });

  it("an approval request that reports any status but awaiting_approval is malformed", () => {
    expect(successBody("request_approval", { ok: true, campaign_id: CAMPAIGN, status: "approved" })).toBeNull();
  });

  // A regression guard: results already took a null p-value before this was asked for, so this passes before and after.
  it("results with no p-value yet answer 200 with pValue null, and every other check still holds", async () => {
    const arm = { members: 3, real_returns: 0, real_rate: 0, simulated_returns: 0 };
    const results = {
      ok: true as const,
      campaign_id: CAMPAIGN,
      status: "submitted",
      rewarded: arm,
      holdout: arm,
      spend_minor: 10,
      fees_minor: 25,
      window_starts_at: "2026-10-24T05:00:00+00:00",
      window_ends_at: "2026-11-23T05:00:00+00:00",
      window_open: true,
      p_value: null,
      verdict: "too early to tell",
      payouts: { items: 1, by_status: { UNCLAIMED: 1 }, claimed_minor: 0, unclaimed_minor: 10, returned_minor: 0, failed_minor: 0, pending_minor: 0, unclaimed_return_by: null },
    };
    const answered = finished("results", results);
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ pValue: null, verdict: "too early to tell", windowOpen: true });
    for (const change of [{ p_value: 1.5 }, { p_value: -0.1 }, { p_value: "0.5" }, { owner_email: "x" }, { verdict: "" }]) {
      expect(finished("results", { ...results, ...change }).status, JSON.stringify(change)).toBe(500);
    }
  });
});

describe("orders a session bought through simulate", () => {
  const bought = (orderId: string) => ({ ok: true as const, campaign_id: CAMPAIGN, ref: "R3", paypal_order_id: orderId, paypal_status: "COMPLETED" });

  it("are remembered for the session that asked, from the direct answer", async () => {
    const response = await waitedResponse(ROUTE, REF, "simulate_return", { state: "finished", runId: RUN, status: "succeeded", result: bought("1AB23456CD789012E") }, SESSION_A);
    expect(response.status).toBe(201);
    expect(sessionBoughtOrder(SESSION_A, "1AB23456CD789012E")).toBe(true);
    expect(sessionBoughtOrder(SESSION_B, "1AB23456CD789012E")).toBe(false);
  });

  it("are remembered for the session the run is recorded under, from the polled answer", async () => {
    const run = "brn-3c9e8f00-1111-4222-8333-944445555666";
    await recordRun(run, SESSION_B, "simulate_return");
    expect(await ownedRunTask(run, SESSION_B)).toBe("simulate_return");
    expect(finishedResponse(ROUTE, REF, "simulate_return", run, { status: "succeeded", result: bought("2CD34567EF890123G") }).status).toBe(201);
    expect(sessionBoughtOrder(SESSION_B, "2CD34567EF890123G")).toBe(true);
    expect(sessionBoughtOrder(SESSION_A, "2CD34567EF890123G")).toBe(false);
  });

  it("are not remembered from a refusal, a malformed answer, a run nobody owns or another task", async () => {
    const session = "f".repeat(64);
    finishedResponse(ROUTE, REF, "simulate_return", RUN, { status: "succeeded", result: { ok: false, error: "over_cap", ref: REF } }, session);
    finishedResponse(ROUTE, REF, "simulate_return", RUN, { status: "succeeded", result: { ...bought("3EF45678GH901234J"), extra: 1 } }, session);
    finishedResponse(ROUTE, REF, "simulate_return", "brn-4c9e8f00-1111-4222-8333-944445555666", { status: "succeeded", result: bought("4GH56789JK012345L") });
    finishedResponse(ROUTE, REF, "submit_campaign", RUN, { status: "succeeded", result: { ok: true, campaign_id: CAMPAIGN, status: "submitted", sent: true, payout_batch_id: "5JK67890LM123456N" } }, session);
    for (const order of ["3EF45678GH901234J", "4GH56789JK012345L", "5JK67890LM123456N"]) expect(sessionBoughtOrder(session, order), order).toBe(false);
  });

  it("keep at most 50 per session, each for 24 hours from when it was bought", () => {
    const session = "c".repeat(64);
    const start = Date.now();
    const order = (n: number) => `ORDER${String(n).padStart(12, "0")}`;
    for (let n = 0; n <= MAX_ORDERS_PER_SESSION; n += 1) rememberSessionOrder(session, order(n), start + n);
    expect(sessionBoughtOrder(session, order(0), start + 100)).toBe(false);
    expect(sessionBoughtOrder(session, order(1), start + 100)).toBe(true);
    expect(sessionBoughtOrder(session, order(MAX_ORDERS_PER_SESSION), start + 100)).toBe(true);
    expect(sessionBoughtOrder(session, order(1), start + ORDER_MEMORY_MS + 1)).toBe(false);
    expect(sessionBoughtOrder(session, order(MAX_ORDERS_PER_SESSION), start + ORDER_MEMORY_MS + MAX_ORDERS_PER_SESSION - 1)).toBe(true);
    expect([MAX_ORDERS_PER_SESSION, ORDER_MEMORY_MS]).toEqual([50, 24 * 60 * 60 * 1000]);
  });
});
