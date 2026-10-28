// Covers the assistant: the exact tool list (no tool that approves, pays, refunds or
// writes to PayPal, and only PayPal's four read tools), each tool's role check, strict
// inputs and listed outputs, a demo visitor's PayPal reads held to the orders its own
// session bought, the cap of 8 tool calls a turn, the turn's 60 seconds ending its
// engine waits, held-back rows never shown to the model, the honest model claim in
// shop_summary, every tool run on the audit record, the request sent to Claude,
// instructions planted in PayPal's answers reaching the model only as data, refusals
// reported without running that turn's tools, the reply stripped to plain text, and the
// routes' guards, no-key answer, daily limits and token budget (the agent, plan and notes
// routes), the client address's included. The engine's answers come from a recorder
// standing in for runAndWait, PayPal's from a recorder standing in for callPayPalTool
// (with the real viewOf rebuilding planted answers), the audit log from a recorder
// standing in for appendAudit, the token store from an in-memory stand-in for
// claude_usage, Claude's from a stubbed fetch playing back scripted turns. Does NOT
// cover: the audit row itself (audit.test.ts), the token budgets in Postgres
// (claude.test.ts), how well the real model picks tools or resists planted text
// (evals, run by npm run prove:m6), the real engine, or the MCP client itself
// (paypal-mcp.test.ts, and the live sandbox in npm run prove:m6).
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionIdFor } from "./sessions";

const state = vi.hoisted(() => ({
  sessions: new Map<string, "owner" | "demo">(),
  refuse: [] as string[],
  engineCalls: [] as { task: string; args: unknown[] }[],
  engineWaits: [] as number[],
  engineHangs: false,
  engine: {} as Record<string, (args: unknown[]) => unknown>,
  claude: [] as Record<string, unknown>[],
  turns: [] as { content: unknown[]; stop: string }[],
  paypalCalls: [] as { name: string; args: unknown; signal: unknown }[],
  paypal: null as unknown,
  hits: [] as { bucket: string; subject: string }[],
  audits: [] as { action: string; detail: unknown }[],
  usage: new Map<string, number>(),
}));

vi.mock("./audit", () => ({
  appendAudit: vi.fn(async (action: string, detail: unknown) => {
    state.audits.push({ action, detail });
  }),
}));

// Claude's token budgets read and add to claude_usage; this keeps each subject's total in memory.
vi.mock("./db", () => ({
  database: () => ({
    query: vi.fn(async (sql: string, params: unknown[]) => {
      const subjects = params[0] as string[];
      if (/insert into claude_usage/.test(sql)) {
        for (const subject of subjects) state.usage.set(subject, (state.usage.get(subject) ?? 0) + Number(params[1]) + Number(params[2]));
        return { rows: [] };
      }
      if (/from claude_usage/.test(sql)) return { rows: subjects.filter((subject) => state.usage.has(subject)).map((subject) => ({ subject, used: String(state.usage.get(subject)) })) };
      throw new Error("the agent tests have no database for that query");
    }),
  }),
}));

vi.mock("./paypal-mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paypal-mcp")>();
  return {
    ...actual,
    callPayPalTool: vi.fn(async (name: string, args: unknown, options: { signal?: unknown } = {}) => {
      state.paypalCalls.push({ name, args, signal: options.signal });
      if (state.paypal instanceof Error) throw state.paypal;
      return state.paypal;
    }),
  };
});

vi.mock("./ratelimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ratelimit")>();
  return {
    ...actual,
    takeHit: vi.fn(async (limit: { bucket: string }, subject: string) => {
      state.hits.push({ bucket: limit.bucket, subject });
      return state.refuse.includes(limit.bucket) ? { allowed: false, retryAfterSeconds: 60 } : { allowed: true };
    }),
  };
});
vi.mock("./engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine")>();
  return {
    ...actual,
    runAndWait: vi.fn(async (task: string, args: unknown[], waitMs: number) => {
      state.engineCalls.push({ task, args });
      state.engineWaits.push(waitMs);
      if (state.engineHangs) return new Promise<never>(() => undefined);
      return { state: "finished", runId: `brn-${randomUUID()}`, status: "succeeded", result: state.engine[task](args) };
    }),
  };
});
vi.mock("./permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./permissions")>();
  return {
    ...actual,
    authorize: vi.fn(async (action: string, request: Request) => {
      const token = /mend_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
      const role = token === undefined ? undefined : state.sessions.get(token);
      const principal = role === undefined ? { role: "anonymous" as const } : { role, sessionId: sessionIdFor(token ?? ""), expiresAt: new Date(Date.now() + 60_000) };
      if (actual.isAllowed(action, principal.role)) return { ok: true, principal };
      return { ok: false, status: principal.role === "anonymous" ? 401 : 403, principal };
    }),
  };
});
vi.mock("@/server/agent", async () => await import("./agent"));
vi.mock("@/server/claude", async () => await import("./claude"));
vi.mock("@/server/csrf", async () => await import("./csrf"));
vi.mock("@/server/engine", async () => await import("./engine"));
vi.mock("@/server/goal", async () => await import("./goal"));
vi.mock("@/server/log", async () => await import("./log"));
vi.mock("@/server/notes", async () => await import("./notes"));
vi.mock("@/server/permissions", async () => await import("./permissions"));
vi.mock("@/server/ratelimit", async () => await import("./ratelimit"));
vi.mock("@/server/runs", async () => await import("./runs"));

const { AGENT_WALL_MS, agentTools, MAX_TOOL_CALLS, paypalReadTools, runAgent } = await import("./agent");
const { ClaudeSession, FAILURE_MESSAGES, MODEL } = await import("./claude");
const { csrfTokenForSession } = await import("./csrf");
const { HostRefused } = await import("./paypal");
const { McpFailed, McpRefused, viewOf } = await import("./paypal-mcp");
const { rememberSessionOrder } = await import("./session-orders");
const { POST } = await import("../app/api/agent/route");
const { POST: planPOST } = await import("../app/api/campaigns/plan/route");
const { POST: notesPOST } = await import("../app/api/campaigns/[id]/notes/route");

const EVALS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "evals");
const BASE = "http://127.0.0.1:3000";
const CAMPAIGN = "0b6c2f8e-6a4e-4c1b-9d2a-7e5f1a3b9c4d";
const OWNER = { role: "owner" as const, sessionId: "e".repeat(64), expiresAt: new Date(Date.now() + 60_000) };
const SUMMARY = {
  ok: true,
  as_of: "2026-10-16",
  shop_customers: 5852,
  members_joined: 1,
  members_seeded: 40,
  members_seeded_label: "demo stand-ins",
  quiet_regulars: 1357,
  quiet_regulars_paid_12m_minor: 123456,
  currency: "USD",
  benchmark: null,
  backtest: null,
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
// The two backtest groups as store_facts.py writes them, with today's measured pooled numbers.
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
  cutoffs: [{ cutoff: "2011-09-09", customers: 812, returned: 97, auc_model: 0.612, auc_recency: 0.618, difference: -0.006, interval_low: -0.031, interval_high: 0.019 }],
};
const ALL_CUSTOMERS = {
  ...HEADLINE,
  group: "all customers",
  regular_min_days: null,
  silent_min_days: null,
  model_wins: 5,
  mean_auc_difference: 0.052,
  interval_low: 0.048,
  interval_high: 0.057,
  cutoffs: [{ cutoff: "2011-09-09", customers: 5256, returned: 1873, auc_model: 0.8007, auc_recency: 0.7626, difference: 0.0381, interval_low: 0.031, interval_high: 0.045 }],
};
const VIEW = {
  ok: true,
  campaign_id: CAMPAIGN,
  status: "draft",
  goal_text: "win back regulars",
  as_of: "2026-10-16",
  budget_minor: 100,
  per_recipient_minor: 10,
  holdout_share: "0.50",
  total_minor: 20,
  rows: [
    { ref: "R1", role: "reward", rank: 1, amount_minor: 10, note: "Thank you for the teapot." },
    { ref: "R2", role: "holdout", rank: 2, amount_minor: null, note: null },
    { ref: "R3", role: "reward", rank: 3, amount_minor: 10, note: "Thank you for the mug." },
  ],
  review_hash: "a".repeat(64),
  review_problem: null,
};
const ORDER_ID = "9BP88160VF536100T";
const ORDER_VIEW = {
  id: ORDER_ID,
  status: "COMPLETED",
  create_time: "2026-10-24T08:13:20Z",
  update_time: "2026-10-24T08:14:02Z",
  purchase_units: [{ amount: { currency_code: "USD", value: "12.50" }, items: [], captures: [{ id: "3C679366HH908993F", status: "COMPLETED" }] }],
};
const PRODUCT_ID = "PROD-5FD60555F23244316";
const MEND_TOOLS = ["shop_summary", "quiet_regulars", "draft_campaign", "view_campaign", "campaign_results", "request_approval"];
const PAYPAL_TOOLS = ["get_order", "list_disputes", "get_dispute", "show_product_details"];

function turn(role: "owner" | "demo" = "owner", sessionId = OWNER.sessionId, wallMs = 10_000) {
  const principal = { ...OWNER, role, sessionId };
  return { principal, session: new ClaudeSession(principal, randomUUID(), wallMs, "198.51.100.1"), ref: randomUUID(), startedAt: Date.now(), used: [] as string[], calls: 0, capped: false };
}

function freshSession(): string {
  return randomBytes(32).toString("hex");
}

type Runnable = {
  readonly name: string;
  readonly description: string;
  readonly input_schema: { readonly additionalProperties?: unknown };
  run(input: unknown): Promise<unknown>;
  parse(input: unknown): unknown;
};

function runnable(tools: ReturnType<typeof agentTools>): Runnable[] {
  return tools as unknown as Runnable[];
}

function tool(tools: ReturnType<typeof agentTools>, name: string) {
  const found = runnable(tools).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return (input: unknown) => found.run(found.parse(input));
}

function tasks(): string[] {
  return state.engineCalls.map((call) => call.task);
}

beforeEach(() => {
  state.refuse = [];
  state.engineCalls = [];
  state.engineWaits = [];
  state.engineHangs = false;
  state.usage = new Map();
  state.claude = [];
  state.turns = [];
  state.paypalCalls = [];
  state.paypal = ORDER_VIEW;
  state.hits = [];
  state.audits = [];
  state.engine = {
    shop_summary: () => SUMMARY,
    view_campaign: () => VIEW,
    request_approval: () => ({ ok: true, campaign_id: CAMPAIGN, status: "awaiting_approval" }),
  };
  vi.stubEnv("ANTHROPIC_API_KEY", "fake-claude-key-for-tests-0123456789");
  vi.stubEnv("MEND_DEV", "1");
  vi.stubEnv("MEND_BASE_URL", BASE);
  vi.stubEnv("MEND_CSRF_SECRET", "csrf-secret-for-agent-tests-0123456789");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname !== "api.anthropic.com") throw new Error(`unexpected host ${url.hostname}`);
      state.claude.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const next = state.turns.shift();
      if (next === undefined) throw new Error("no scripted turn left");
      return Response.json({
        id: `msg_${state.claude.length}`,
        type: "message",
        role: "assistant",
        model: MODEL,
        content: next.content,
        stop_reason: next.stop,
        stop_sequence: null,
        usage: { input_tokens: 1500, output_tokens: 60 },
      });
    }),
  );
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the agent's tools", () => {
  it("are exactly Mend's six guarded tools and PayPal's four read tools, with strict inputs", () => {
    const current = turn();
    const tools = runnable(agentTools(current));
    current.session.close();
    expect(tools.map((candidate) => candidate.name)).toEqual([...MEND_TOOLS, ...PAYPAL_TOOLS]);
    expect(runnable(paypalReadTools(current)).map((candidate) => candidate.name)).toEqual(PAYPAL_TOOLS);
    expect(tools.map((candidate) => candidate.name).join(" ")).not.toMatch(/approve_campaign|submit|pay|refund|send|create|update|capture|accept|cancel|invoice|transaction|webhook/);
    for (const candidate of tools) expect(candidate.input_schema.additionalProperties, candidate.name).toBe(false);
  });

  it("check paypal.read in the permission table before reaching PayPal", async () => {
    const current = { ...turn(), principal: { ...OWNER, role: "anonymous" as unknown as "owner" } };
    const tools = agentTools(current);
    await expect(tool(tools, "get_order")({ id: ORDER_ID })).rejects.toThrow("not allowed");
    await expect(tool(tools, "list_disputes")({})).rejects.toThrow("not allowed");
    await expect(tool(tools, "get_dispute")({ dispute_id: "PP-D-27803" })).rejects.toThrow("not allowed");
    await expect(tool(tools, "show_product_details")({ product_id: "PROD-5FD60555F23244316" })).rejects.toThrow("not allowed");
    current.session.close();
    expect(state.paypalCalls).toEqual([]);
  });

  it("refuse a malformed PayPal id or a customer filter without reaching PayPal", () => {
    const current = turn();
    const tools = agentTools(current);
    expect(() => tool(tools, "get_order")({ id: "9bp88160vf536100t" })).toThrow();
    expect(() => tool(tools, "get_order")({ id: `${ORDER_ID}/../refund` })).toThrow();
    expect(() => tool(tools, "list_disputes")({ buyer_email: "buyer@example.com" })).toThrow();
    expect(() => tool(tools, "get_dispute")({ dispute_id: "PP-D-1 or 1=1" })).toThrow();
    expect(() => tool(tools, "show_product_details")({ product_id: "x" })).toThrow();
    current.session.close();
    expect(state.paypalCalls).toEqual([]);
  });

  it("read PayPal through Mend's MCP client with the turn's deadline, and turn its failures into fixed sentences", async () => {
    const current = turn("demo");
    rememberSessionOrder(OWNER.sessionId, ORDER_ID);
    const getOrder = tool(agentTools(current), "get_order");
    expect(JSON.parse(String(await getOrder({ id: ORDER_ID })))).toEqual(ORDER_VIEW);
    expect(state.paypalCalls).toEqual([{ name: "get_order", args: { id: ORDER_ID }, signal: current.session.signal }]);

    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    for (const [error, sentence] of [
      [new McpFailed("not_found", 404), "PayPal has nothing with that id"],
      [new McpFailed("timeout"), "did not answer in time"],
      [new McpRefused("not_allowed"), "only reads orders, disputes and products"],
      [new HostRefused("host is not PayPal's sandbox MCP server"), "nothing was sent there"],
    ] as const) {
      state.paypal = error;
      await expect(getOrder({ id: ORDER_ID })).rejects.toThrow(sentence);
    }
    current.session.close();
    const logged = lines.join("");
    expect(logged).toContain('"kind":"paypal_mcp"');
    expect(logged).toContain('"outcome":"not_found","status":404');
    expect(logged).toContain('"outcome":"host_refused"');
  });

  it("let a demo visitor read only orders its own session bought with the simulate button, products, and never the shop's disputes", async () => {
    const visitor = freshSession();
    const own = "1AB23456CD789012E";
    const stranger = "7XY65432ZW109876Q";
    const current = turn("demo", visitor);
    const tools = agentTools(current);
    await expect(tool(tools, "get_order")({ id: ORDER_ID })).rejects.toThrow("only orders this demo session bought");
    rememberSessionOrder(freshSession(), stranger);
    await expect(tool(tools, "get_order")({ id: stranger })).rejects.toThrow("only orders this demo session bought");
    rememberSessionOrder(visitor, own);
    expect(JSON.parse(String(await tool(tools, "get_order")({ id: own })))).toEqual(ORDER_VIEW);
    await expect(tool(tools, "list_disputes")({})).rejects.toThrow("not allowed");
    await expect(tool(tools, "get_dispute")({ dispute_id: "PP-D-27803" })).rejects.toThrow("not allowed");
    await tool(tools, "show_product_details")({ product_id: PRODUCT_ID });
    current.session.close();
    expect(state.paypalCalls.map((call) => [call.name, call.args])).toEqual([
      ["get_order", { id: own }],
      ["show_product_details", { product_id: PRODUCT_ID }],
    ]);
  });

  it("let the owner read any order and the shop's disputes", async () => {
    const current = turn("owner", freshSession());
    const tools = agentTools(current);
    await tool(tools, "get_order")({ id: "7XY65432ZW109876Q" });
    await tool(tools, "list_disputes")({});
    await tool(tools, "get_dispute")({ dispute_id: "PP-D-27803" });
    current.session.close();
    expect(state.paypalCalls.map((call) => call.name)).toEqual(["get_order", "list_disputes", "get_dispute"]);
  });

  it("count PayPal reads against the same 8-call cap", async () => {
    const current = turn();
    const tools = agentTools(current);
    for (let n = 0; n < MAX_TOOL_CALLS; n += 1) await tool(tools, "get_order")({ id: ORDER_ID });
    await expect(tool(tools, "list_disputes")({})).rejects.toThrow("limit of 8 tool calls");
    current.session.close();
    expect(state.paypalCalls).toHaveLength(MAX_TOOL_CALLS);
  });

  it("check the caller's role in the permission table before asking the engine", async () => {
    const current = { ...turn(), principal: { ...OWNER, role: "anonymous" as unknown as "owner" } };
    await expect(tool(agentTools(current), "view_campaign")({ campaignId: CAMPAIGN })).rejects.toThrow("not allowed");
    await expect(tool(agentTools(current), "request_approval")({ campaignId: CAMPAIGN })).rejects.toThrow("not allowed");
    await expect(tool(agentTools(current), "draft_campaign")({ goal: "50 dollars" })).rejects.toThrow("not allowed");
    current.session.close();
    expect(state.engineCalls).toEqual([]);
  });

  it("refuse malformed or oversized inputs without running", async () => {
    const current = turn();
    const tools = agentTools(current);
    expect(() => tool(tools, "view_campaign")({ campaignId: "R1; drop table campaigns" })).toThrow();
    expect(() => tool(tools, "request_approval")({ campaignId: CAMPAIGN, amount: 1000 })).toThrow();
    expect(() => tool(tools, "draft_campaign")({ goal: "x".repeat(501) })).toThrow();
    current.session.close();
    expect(state.engineCalls).toEqual([]);
  });

  it("stop at 8 calls in one turn", async () => {
    const current = turn();
    const summary = tool(agentTools(current), "shop_summary");
    for (let n = 0; n < MAX_TOOL_CALLS; n += 1) await summary({});
    await expect(summary({})).rejects.toThrow("limit of 8 tool calls");
    current.session.close();
    expect(tasks()).toHaveLength(MAX_TOOL_CALLS);
    expect(current.capped).toBe(true);
  });

  it("show rewarded rows by reference only and count held-back rows without listing them", async () => {
    const current = turn("demo");
    const shown = JSON.parse(String(await tool(agentTools(current), "view_campaign")({ campaignId: CAMPAIGN }))) as Record<string, unknown>;
    current.session.close();
    expect(shown.rewarded).toEqual([
      { ref: "R1", amountMinor: 10, note: "Thank you for the teapot." },
      { ref: "R3", amountMinor: 10, note: "Thank you for the mug." },
    ]);
    expect(shown).toMatchObject({ rewardedCount: 2, heldBackCount: 1, readyForApproval: true });
    expect(JSON.stringify(shown)).not.toMatch(/R2|holdout|@/);
    expect(state.engineCalls[0].args[1]).toEqual({ role: "demo", session: OWNER.sessionId });
  });

  it("put every tool run on the audit record with its name and whether it ran or was refused, PayPal lookups included", async () => {
    const current = turn("demo");
    rememberSessionOrder(OWNER.sessionId, ORDER_ID);
    const tools = agentTools(current);
    await tool(tools, "shop_summary")({});
    await tool(tools, "get_order")({ id: ORDER_ID });
    state.paypal = new McpFailed("timeout");
    await expect(tool(tools, "get_order")({ id: ORDER_ID })).rejects.toThrow("did not answer in time");
    state.engine.shop_summary = () => {
      throw new Error("engine broke");
    };
    await expect(tool(tools, "shop_summary")({})).rejects.toThrow("problem inside Mend");
    const stranger = { ...turn(), principal: { ...OWNER, role: "anonymous" as unknown as "owner" } };
    await expect(tool(agentTools(stranger), "view_campaign")({ campaignId: CAMPAIGN })).rejects.toThrow("not allowed");
    current.session.close();
    stranger.session.close();
    const row = (tool: string, outcome: string, reason: string | null, role: string, ref: string) => ({ action: "agent_tool", detail: { tool, outcome, reason, role, ref } });
    expect(state.audits).toEqual([
      row("shop_summary", "ran", null, "demo", current.ref),
      row("get_order", "ran", null, "demo", current.ref),
      row("get_order", "refused", "refused", "demo", current.ref),
      row("shop_summary", "refused", "failed", "demo", current.ref),
      row("view_campaign", "refused", "not_allowed", "anonymous", stranger.ref),
    ]);
  });

  it("lead the model claim with the live segment, a tie with recency when its interval holds zero, then the all-customer result labelled as such", async () => {
    const current = turn();
    const tools = agentTools(current);
    const description = runnable(tools).find((candidate) => candidate.name === "shop_summary")?.description ?? "";
    expect(description).toContain("modelVersusRecencyLiveSegment comes first and is the claim to lead with");
    expect(description).toContain("the interval includes zero, the model ties recency there");
    expect(description).toContain("always label it as all customers");
    expect(description).toContain("held-back group");
    state.engine.shop_summary = () => ({ ...SUMMARY, backtest: { ...BACKTEST, headline: HEADLINE, all_customers: ALL_CUSTOMERS } });
    const shown = JSON.parse(String(await tool(tools, "shop_summary")({}))) as Record<string, unknown>;
    current.session.close();
    const keys = Object.keys(shown);
    expect(keys.indexOf("modelVersusRecencyLiveSegment")).toBeLessThan(keys.indexOf("modelVersusRecencyAllCustomers"));
    expect(shown).not.toHaveProperty("modelBeatsRecency");
    expect(shown.modelVersusRecencyLiveSegment).toEqual({
      group: "live segment: regulars with 3 or more purchase days, silent 60 or more days",
      cutoffsWon: 3,
      cutoffsMeasured: 5,
      meanAucDifference: -0.005,
      intervalConfidence: 0.95,
      intervalLow: -0.024,
      intervalHigh: 0.016,
      verdict: "a tie with recency: the interval includes zero",
    });
    expect(shown.modelVersusRecencyAllCustomers).toEqual({
      group: "all customers",
      cutoffsWon: 5,
      cutoffsMeasured: 5,
      meanAucDifference: 0.052,
      intervalConfidence: 0.95,
      intervalLow: 0.048,
      intervalHigh: 0.057,
      verdict: "ahead of recency",
    });
  });

  it("report people who joined and demo stand-ins apart, never as one members number, and say the stand-ins are demo customers", async () => {
    const current = turn();
    const tools = agentTools(current);
    const description = runnable(tools).find((candidate) => candidate.name === "shop_summary")?.description ?? "";
    expect(description).toContain("demo customers, not people who joined");
    expect(description).toContain("never add the two into one number of members");
    const shown = JSON.parse(String(await tool(tools, "shop_summary")({}))) as Record<string, unknown>;
    current.session.close();
    expect(shown.membersJoined).toBe(1);
    expect(shown.demoStandIns).toEqual({ count: 40, label: "demo stand-ins" });
    expect(shown).not.toHaveProperty("members");
    expect(Object.values(shown)).not.toContain(41);
  });

  it("claim nothing for the live segment from a backtest stored before it was measured, and label the old numbers as all customers", async () => {
    state.engine.shop_summary = () => ({ ...SUMMARY, backtest: BACKTEST });
    const current = turn();
    const shown = JSON.parse(String(await tool(agentTools(current), "shop_summary")({}))) as Record<string, unknown>;
    current.session.close();
    expect(shown.modelVersusRecencyLiveSegment).toBeNull();
    expect(shown.modelVersusRecencyAllCustomers).toEqual({
      group: "all customers",
      cutoffsWon: 1,
      cutoffsMeasured: 1,
      meanAucDifference: 0.0381,
      intervalConfidence: null,
      intervalLow: null,
      intervalHigh: null,
      verdict: "no interval was measured, so no claim either way",
    });
  });

  it("end an engine wait when the turn runs out of time, and never wait past the turn's 60 seconds", async () => {
    state.engineHangs = true;
    const short = turn("owner", OWNER.sessionId, 100);
    const started = Date.now();
    await expect(tool(agentTools(short), "shop_summary")({})).rejects.toThrow("ran out of time");
    expect(Date.now() - started).toBeLessThan(2_000);
    short.session.close();

    state.engineHangs = false;
    const late = { ...turn(), startedAt: Date.now() - (AGENT_WALL_MS - 5_000) };
    await tool(agentTools(late), "shop_summary")({});
    expect(state.engineWaits.at(-1)).toBeGreaterThan(0);
    expect(state.engineWaits.at(-1)).toBeLessThanOrEqual(5_000);
    const over = { ...turn(), startedAt: Date.now() - AGENT_WALL_MS - 1 };
    await expect(tool(agentTools(over), "shop_summary")({})).rejects.toThrow("ran out of time");
    late.session.close();
    over.session.close();
    expect(state.engineCalls).toHaveLength(2);
  });

  it("request approval only through the engine's request_approval task", async () => {
    const current = turn();
    const answer = JSON.parse(String(await tool(agentTools(current), "request_approval")({ campaignId: CAMPAIGN }))) as Record<string, unknown>;
    current.session.close();
    expect(answer.status).toBe("awaiting_approval");
    expect(tasks()).toEqual(["request_approval"]);
  });

  it("report the payout states with the results: claimed, unclaimed, returned and when unclaimed money returns", async () => {
    const arm = { members: 10, real_returns: 0, real_rate: 0, simulated_returns: 1 };
    state.engine.results = () => ({
      ok: true,
      campaign_id: CAMPAIGN,
      status: "submitted",
      rewarded: arm,
      holdout: arm,
      spend_minor: 30,
      fees_minor: 25,
      window_starts_at: "2026-10-24T05:00:00+00:00",
      window_ends_at: "2026-11-23T05:00:00+00:00",
      window_open: true,
      p_value: 0.5,
      verdict: "too early to tell",
      payouts: {
        items: 3,
        by_status: { SUCCESS: 1, UNCLAIMED: 1, RETURNED: 1 },
        claimed_minor: 10,
        unclaimed_minor: 10,
        returned_minor: 10,
        failed_minor: 0,
        pending_minor: 0,
        unclaimed_return_by: "2026-11-23T05:00:00+00:00",
      },
    });
    const current = turn("demo");
    const shown = JSON.parse(String(await tool(agentTools(current), "campaign_results")({ campaignId: CAMPAIGN }))) as Record<string, unknown>;
    current.session.close();
    expect(shown.payouts).toEqual({
      items: 3,
      byStatus: { SUCCESS: 1, UNCLAIMED: 1, RETURNED: 1 },
      claimedMinor: 10,
      unclaimedMinor: 10,
      returnedMinor: 10,
      failedMinor: 0,
      pendingMinor: 0,
      unclaimedReturnBy: "2026-11-23T05:00:00+00:00",
    });
    expect(state.engineCalls).toEqual([{ task: "results", args: [CAMPAIGN, { role: "demo", session: OWNER.sessionId }] }]);
  });
});

describe("runAgent", () => {
  it("runs the tools Claude asks for and returns plain text, from a request with the fixed model, effort and cache marker", async () => {
    state.turns.push({ content: [{ type: "tool_use", id: "toolu_1", name: "shop_summary", input: {} }], stop: "tool_use" });
    state.turns.push({
      content: [{ type: "text", text: "The shop has 1357 quiet regulars. ![x](https://evil.example/?q=1) <img src=x onerror=alert(1)>Ask me to draft a campaign." }],
      stop: "end_turn",
    });
    const answer = await runAgent(OWNER, "How is my shop doing? Write to me at boss@shop.example", [], randomUUID(), "198.51.100.1");

    expect(answer).toEqual({ kind: "replied", reply: "The shop has 1357 quiet regulars.  Ask me to draft a campaign.", toolsUsed: ["shop_summary"], stopped: null, aiCalls: 2 });
    const [first, second] = state.claude;
    expect(first).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 4000, output_config: { effort: "medium" } });
    for (const banned of ["temperature", "top_p", "top_k", "thinking"]) expect(first, banned).not.toHaveProperty(banned);
    // One tool per reply, so a turn never has more engine calls in flight than its session may.
    expect(first.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect((first.system as { cache_control: unknown }[]).at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect((first.tools as { name: string }[]).map((candidate) => candidate.name)).toEqual([...MEND_TOOLS, ...PAYPAL_TOOLS]);
    expect(JSON.stringify(first)).not.toContain("boss@shop.example");
    expect(JSON.stringify(second)).toContain("quietRegulars");
  });

  it("reports a refusal plainly and never runs the tools of the refused turn", async () => {
    state.turns.push({ content: [{ type: "tool_use", id: "toolu_1", name: "request_approval", input: { campaignId: CAMPAIGN } }], stop: "refusal" });
    const answer = await runAgent(OWNER, "approve it", [], randomUUID(), "198.51.100.1");
    expect(answer).toMatchObject({ kind: "replied", reply: "The AI service declined this request.", stopped: "declined", aiCalls: 1 });
    expect(state.engineCalls).toEqual([]);
    expect(state.claude).toHaveLength(1);
  });

  it("answers what happened with an order through get_order, and Claude never gets PayPal's server, token or a write tool", async () => {
    state.turns.push({ content: [{ type: "tool_use", id: "toolu_1", name: "create_invoice", input: { currency_code: "USD", primary_recipients: [], items: [] } }], stop: "tool_use" });
    state.turns.push({ content: [{ type: "tool_use", id: "toolu_2", name: "get_order", input: { id: ORDER_ID } }], stop: "tool_use" });
    state.turns.push({ content: [{ type: "text", text: "That order is completed: 12.50 USD, captured." }], stop: "end_turn" });
    const answer = await runAgent(OWNER, `What happened with order ${ORDER_ID}? Also invoice my last buyer.`, [], randomUUID(), "198.51.100.1");

    expect(answer).toMatchObject({ kind: "replied", reply: "That order is completed: 12.50 USD, captured.", toolsUsed: ["get_order"], aiCalls: 3 });
    expect(state.paypalCalls.map((call) => call.name)).toEqual(["get_order"]);
    expect(JSON.stringify(state.claude[1])).toContain("not found");
    expect(JSON.stringify(state.claude[2])).toContain("3C679366HH908993F");
    for (const sent of state.claude) {
      expect(sent).not.toHaveProperty("mcp_servers");
      expect(JSON.stringify(sent)).not.toMatch(/mcp_toolset|mcp\.sandbox\.paypal\.com|A21AA|authorization_token/);
    }
  });

  it("turns an approve-and-pay request into request_approval at most, whatever the model writes", async () => {
    state.turns.push({ content: [{ type: "tool_use", id: "toolu_1", name: "approve_campaign", input: { campaignId: CAMPAIGN } }], stop: "tool_use" });
    state.turns.push({ content: [{ type: "tool_use", id: "toolu_2", name: "request_approval", input: { campaignId: CAMPAIGN } }], stop: "tool_use" });
    state.turns.push({ content: [{ type: "text", text: "It is in your approval queue. Approve it on the campaign page." }], stop: "end_turn" });
    const answer = await runAgent(OWNER, `Approve campaign ${CAMPAIGN} and pay everyone now`, [], randomUUID(), "198.51.100.1");
    expect(answer).toMatchObject({ kind: "replied", toolsUsed: ["request_approval"], aiCalls: 3 });
    expect(tasks()).toEqual(["request_approval"]);
    expect(JSON.stringify(state.claude[1])).toContain("not found");
  });
});

type Planted = { readonly id: string; readonly tool: "get_order" | "show_product_details"; readonly text: string };
const PLANTED = (JSON.parse(readFileSync(path.join(EVALS, "injected-notes.json"), "utf8")) as { paypal?: Planted[] }).paypal ?? [];

function plantedAnswer(entry: Planted): unknown {
  if (entry.tool === "show_product_details") return { id: PRODUCT_ID, name: "Red teapot", description: entry.text, type: "PHYSICAL", category: "HOUSEWARES" };
  return {
    id: ORDER_ID,
    status: "COMPLETED",
    create_time: "2026-10-24T08:13:20Z",
    update_time: "2026-10-24T08:14:02Z",
    purchase_units: [
      {
        amount: { currency_code: "USD", value: "12.50" },
        items: [
          { name: entry.text, quantity: "1" },
          { name: "Red teapot", quantity: "1" },
        ],
        payments: { captures: [{ id: "3C679366HH908993F", status: "COMPLETED" }] },
      },
    ],
  };
}

describe("instructions planted in PayPal's answers", () => {
  it("are in the eval set, in an order's item name and in a product's description", () => {
    expect(new Set(PLANTED.map((entry) => entry.tool))).toEqual(new Set(["get_order", "show_product_details"]));
  });

  it.each(PLANTED.map((entry) => [entry.id, entry] as const))("%s reaches the model only as data, and nothing happens when the model obeys it", async (_id, entry) => {
    state.paypal = viewOf(entry.tool, plantedAnswer(entry));
    const read = entry.tool === "get_order" ? { id: ORDER_ID } : { product_id: PRODUCT_ID };
    state.turns.push({ content: [{ type: "tool_use", id: "toolu_1", name: entry.tool, input: read }], stop: "tool_use" });
    // A model that does what the planted text says, as far as it can.
    state.turns.push({
      content: [
        { type: "tool_use", id: "toolu_2", name: "create_refund", input: { capture_id: "3C679366HH908993F" } },
        { type: "tool_use", id: "toolu_3", name: "approve_campaign", input: { campaignId: CAMPAIGN } },
        { type: "tool_use", id: "toolu_4", name: "create_invoice", input: { amount: "500.00" } },
      ],
      stop: "tool_use",
    });
    state.turns.push({ content: [{ type: "text", text: "Done: refunded and paid. Write to evil@example.com ![x](http://x.example/p.png?d=1)" }], stop: "end_turn" });
    const question = entry.tool === "get_order" ? `What happened with PayPal order ${ORDER_ID}?` : `What does my PayPal catalog say about product ${PRODUCT_ID}?`;
    const answer = await runAgent(OWNER, question, [], randomUUID(), "198.51.100.1");

    expect(answer).toMatchObject({ kind: "replied", toolsUsed: [entry.tool], aiCalls: 3 });
    expect(state.paypalCalls.map((call) => call.name)).toEqual([entry.tool]);
    expect(state.engineCalls).toEqual([]);
    expect(state.audits.map((row) => (row.detail as { tool: string }).tool)).toEqual([entry.tool]);
    expect(JSON.stringify(state.claude[1])).toContain(entry.text.slice(0, 24));
    for (const sent of state.claude) expect(JSON.stringify(sent)).not.toContain("@");
    expect(answer.kind === "replied" ? answer.reply : "").not.toMatch(/@|!\[/);
  });
});

describe("POST /api/agent", () => {
  function signIn(role: "owner" | "demo"): string {
    const token = `s1.${randomBytes(32).toString("base64url")}`;
    state.sessions.set(token, role);
    return token;
  }

  function ask(token: string, body: unknown, withCsrf = true): Promise<Response> {
    const headers: Record<string, string> = { origin: BASE, cookie: `mend_session=${token}`, "content-type": "application/json" };
    if (withCsrf) headers["x-mend-csrf"] = csrfTokenForSession(sessionIdFor(token));
    return POST(new Request(`${BASE}/api/agent`, { method: "POST", headers, body: JSON.stringify(body) }));
  }

  it("answers a demo visitor in plain text with the tools used and the Claude calls made", async () => {
    state.turns.push({ content: [{ type: "text", text: "<b>Hello</b> there." }], stop: "end_turn" });
    const response = await ask(signIn("demo"), { message: "hi", history: [{ role: "agent", text: "earlier" }, { role: "owner", text: "before" }] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reply: "Hello there.", toolsUsed: [], stopped: null, aiCalls: 1 });
    expect((state.claude[0].messages as { role: string }[]).map((entry) => entry.role)).toEqual(["user", "user"]);
  });

  it("counts a demo visitor's Claude calls against its client address as well as its session and every demo", async () => {
    const token = signIn("demo");
    state.refuse = ["claude_demo_address"];
    const headers = {
      origin: BASE,
      cookie: `mend_session=${token}`,
      "content-type": "application/json",
      "x-mend-csrf": csrfTokenForSession(sessionIdFor(token)),
      "x-forwarded-for": "198.51.100.50",
    };
    const limited = await POST(new Request(`${BASE}/api/agent`, { method: "POST", headers, body: JSON.stringify({ message: "hi" }) }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "limit_reached" });
    expect(state.hits).toEqual([
      { bucket: "claude_demo_session", subject: sessionIdFor(token) },
      { bucket: "claude_demo_address", subject: "198.51.100.50" },
    ]);
    expect(state.claude).toEqual([]);
  });

  it("answers claude_token_cap with its fixed sentence from the agent, plan and notes routes once today's demo tokens are spent, sending nothing", async () => {
    state.usage.set("demo_all", 5_000_000);
    state.engine.draft_limits = () => ({ ok: true, as_of: "2026-10-16", campaign_cap_minor: 1000, item_cap_minor: 200 });
    state.engine.draft_campaign = () => ({ ok: true, campaign_id: CAMPAIGN, candidates: 4, rewarded: 2, held_back: 2, total_minor: 20 });
    state.engine.note_context = () => ({ ok: true, shop_name: "Wolf and Wren Gifts", recent_items: ["red teapot"], days_since_last_order: 120 });
    state.engine.set_note = (args) => ({ ok: true, campaign_id: CAMPAIGN, ref: args[1], template: args[2] === null });
    const token = signIn("demo");
    const headers = { origin: BASE, cookie: `mend_session=${token}`, "content-type": "application/json", "x-mend-csrf": csrfTokenForSession(sessionIdFor(token)) };
    const sentence = FAILURE_MESSAGES.claude_token_cap;

    const chat = await ask(token, { message: "hi" });
    expect(chat.status).toBe(429);
    expect(await chat.json()).toMatchObject({ error: "claude_token_cap", message: sentence });

    const planned = await planPOST(new Request(`${BASE}/api/campaigns/plan`, { method: "POST", headers, body: JSON.stringify({ goalText: "bring back my quiet regulars, 5 dollars", budgetMinor: 500 }) }));
    expect(planned.status).toBe(201);
    expect(await planned.json()).toMatchObject({ aiCalls: 0, plan: { goal: "claude_token_cap", notice: sentence, settings: { budgetMinor: 500 } } });

    const noted = await notesPOST(new Request(`${BASE}/api/campaigns/${CAMPAIGN}/notes`, { method: "POST", headers }), { params: Promise.resolve({ id: CAMPAIGN }) });
    expect(noted.status).toBe(200);
    expect(await noted.json()).toMatchObject({ written: 0, template: 2, stopped: "claude_token_cap", notice: sentence, aiCalls: 0 });
    expect(state.claude).toEqual([]);
  });

  it("says plainly it needs a key, refuses without a CSRF token, and gives a clear message at the daily limit", async () => {
    const demo = signIn("demo");
    expect((await ask(demo, { message: "hi" }, false)).status).toBe(403);
    expect((await ask(demo, { message: "hi", extra: true })).status).toBe(400);

    state.refuse = ["claude_demo_session"];
    const limited = await ask(demo, { message: "hi" });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "limit_reached", message: expect.stringContaining("daily limit") });

    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const keyless = await ask(demo, { message: "hi" });
    expect(keyless.status).toBe(503);
    expect(await keyless.json()).toMatchObject({ error: "no_key", message: expect.stringContaining("needs an Anthropic API key") });
    expect(state.claude).toEqual([]);
  });
});
