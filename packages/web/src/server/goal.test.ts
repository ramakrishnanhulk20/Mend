// Covers goal reading and planning: the one dollars-to-cents routine, clamping to each
// role's caps with every change said back, the form winning over the text, the exact
// request sent to Claude (goal text only, effort low, no sampling settings), and the
// plan route's guards, its no-key path and its daily-limit path. The engine's answers
// come from a recorder standing in for runAndWait, Claude's from a stubbed fetch, and
// sessions from a stand-in for authorize that applies the real permission table. Does
// NOT cover: the real engine or Claude (npm run prove:m6), the engine client
// (engine.test.ts), or the caps counted in Postgres (ratelimit.test.ts).
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionIdFor } from "./sessions";

const state = vi.hoisted(() => ({
  sessions: new Map<string, "owner" | "demo">(),
  refuse: [] as string[],
  hits: [] as string[],
  engineCalls: [] as { task: string; args: unknown[] }[],
  engine: {} as Record<string, (args: unknown[]) => unknown>,
  claude: [] as Record<string, unknown>[],
  claudeAnswers: [] as (() => Response)[],
}));

vi.mock("./ratelimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ratelimit")>();
  return {
    ...actual,
    takeHit: vi.fn(async (limit: { bucket: string }) => {
      state.hits.push(limit.bucket);
      return state.refuse.includes(limit.bucket) ? { allowed: false, retryAfterSeconds: 60 } : { allowed: true };
    }),
  };
});
vi.mock("./engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine")>();
  return {
    ...actual,
    runAndWait: vi.fn(async (task: string, args: unknown[]) => {
      state.engineCalls.push({ task, args });
      return { state: "finished", runId: `brn-${randomUUID()}`, status: "succeeded", result: state.engine[task](args) };
    }),
  };
});
// Claude's token budgets read and add to claude_usage; here no usage is ever stored.
vi.mock("./db", () => ({
  database: () => ({
    query: async (sql: string) => {
      if (sql.includes("claude_usage")) return { rows: [] };
      throw new Error("the goal tests have no database");
    },
  }),
}));
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
// Route modules import through the "@/" alias, which this vitest config does not map.
vi.mock("@/server/claude", async () => await import("./claude"));
vi.mock("@/server/csrf", async () => await import("./csrf"));
vi.mock("@/server/engine", async () => await import("./engine"));
vi.mock("@/server/goal", async () => await import("./goal"));
vi.mock("@/server/log", async () => await import("./log"));
vi.mock("@/server/permissions", async () => await import("./permissions"));
vi.mock("@/server/ratelimit", async () => await import("./ratelimit"));
vi.mock("@/server/runs", async () => await import("./runs"));

const { centsFromDollars, cleanGoal, fitPlan, readGoal } = await import("./goal");
const { ClaudeSession, MODEL } = await import("./claude");
const { csrfTokenForSession } = await import("./csrf");
const { POST } = await import("../app/api/campaigns/plan/route");

const BASE = "http://127.0.0.1:3000";
const CAMPAIGN = "0b6c2f8e-6a4e-4c1b-9d2a-7e5f1a3b9c4d";
const GOAL = "bring back my quiet regulars, 50 dollars";
const OWNER_LIMITS = { asOf: "2026-10-16", campaignCapMinor: 10_000, itemCapMinor: 1_000 };
const DEMO_LIMITS = { asOf: "2026-10-16", campaignCapMinor: 1000, itemCapMinor: 200 };

function claudeJson(reading: Record<string, unknown>, stopReason = "end_turn"): () => Response {
  return () =>
    Response.json({
      id: "msg_goal",
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [{ type: "text", text: JSON.stringify(reading) }],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 300, output_tokens: 40 },
    });
}

function signIn(role: "owner" | "demo"): string {
  const token = `s1.${randomBytes(32).toString("base64url")}`;
  state.sessions.set(token, role);
  return token;
}

function plan(token: string | null, body: unknown, csrf: "right" | "none" = "right"): Promise<Response> {
  const headers: Record<string, string> = { origin: BASE, "content-type": "application/json" };
  if (token !== null) {
    headers.cookie = `mend_session=${token}`;
    if (csrf === "right") headers["x-mend-csrf"] = csrfTokenForSession(sessionIdFor(token));
  }
  return POST(new Request(`${BASE}/api/campaigns/plan`, { method: "POST", headers, body: JSON.stringify(body) }));
}

beforeEach(() => {
  state.refuse = [];
  state.hits = [];
  state.engineCalls = [];
  state.claude = [];
  state.claudeAnswers = [];
  state.engine = {
    draft_limits: (args) => {
      const demo = (args[0] as { role: string }).role === "demo";
      return { ok: true, as_of: "2026-10-16", campaign_cap_minor: demo ? 1000 : 10_000, item_cap_minor: demo ? 200 : 1_000 };
    },
    draft_campaign: (args) => ({ ok: true, campaign_id: CAMPAIGN, candidates: 20, rewarded: 10, held_back: 10, total_minor: Math.min((args[0] as { budget_minor: number }).budget_minor, 100) }),
  };
  vi.stubEnv("ANTHROPIC_API_KEY", "fake-claude-key-for-tests-0123456789");
  vi.stubEnv("MEND_DEV", "1");
  vi.stubEnv("MEND_BASE_URL", BASE);
  vi.stubEnv("MEND_CSRF_SECRET", "csrf-secret-for-goal-tests-0123456789");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname !== "api.anthropic.com") throw new Error(`unexpected host ${url.hostname}`);
      state.claude.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const next = state.claudeAnswers.shift();
      if (next === undefined) throw new Error("no Claude answer left");
      return next();
    }),
  );
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("centsFromDollars", () => {
  it("reads dollars as text into whole cents and refuses what is not a plain positive amount", () => {
    expect(centsFromDollars(50)).toEqual({ cents: 5000, trimmed: false });
    expect(centsFromDollars(12.5)).toEqual({ cents: 1250, trimmed: false });
    expect(centsFromDollars(0.1)).toEqual({ cents: 10, trimmed: false });
    expect(centsFromDollars(12.345)).toEqual({ cents: 1234, trimmed: true });
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1e21, 1e-7, 0.001]) expect(centsFromDollars(bad), String(bad)).toBeNull();
  });
});

describe("fitPlan", () => {
  const read = (fields: Record<string, unknown>) => ({ budget_usd: 50, unclear: false, reason: "", ...fields });

  it("keeps an owner's $50 goal as 5000 cents and fills the defaults", () => {
    const fitted = fitPlan(GOAL, read({}), {}, OWNER_LIMITS, "owner");
    expect(fitted).toEqual({
      settings: { goalText: GOAL, asOf: "2026-10-16", budgetMinor: 5000, perRecipientMinor: 1000, holdoutShare: "0.50", maxCandidates: 40 },
      changes: [],
    });
  });

  it("clamps a demo plan to the demo caps and says so", () => {
    const fitted = fitPlan(GOAL, read({ per_recipient_usd: 5 }), {}, DEMO_LIMITS, "demo");
    expect(fitted.settings).toMatchObject({ budgetMinor: 1000, perRecipientMinor: 200, maxCandidates: 10 });
    expect(fitted.changes).toEqual([
      "Budget lowered from $50.00 to $10.00, the most one campaign may spend on this account.",
      "Most per customer lowered from $5.00 to $2.00, the cap per customer on this account.",
    ]);
  });

  it("lets the form win, clamps the held-back share and the customer count, and flags an unclear goal", () => {
    const fitted = fitPlan(GOAL, read({ unclear: true, holdout_share: 0.1, max_candidates: 1000 }), { budgetMinor: 2500 }, OWNER_LIMITS, "owner");
    expect(fitted.settings).toMatchObject({ budgetMinor: 2500, holdoutShare: "0.20", maxCandidates: 250 });
    expect(fitted.changes).toEqual([
      "The goal was not fully clear, so check these settings before approving.",
      "Held-back share changed from 0.10 to 0.20; it must be between 0.20 and 0.50.",
      "Customers considered changed from 1000 to 250; a campaign considers 2 to 250.",
    ]);
    expect(fitPlan(GOAL, read({ holdout_share: 30 }), {}, OWNER_LIMITS, "owner").settings?.holdoutShare).toBe("0.50");
    expect(fitPlan(GOAL, null, { holdoutShare: "0.3" }, OWNER_LIMITS, "owner").settings).toBeNull();
    expect(fitPlan(GOAL, read({ budget_usd: 0 }), {}, OWNER_LIMITS, "owner").settings).toBeNull();
  });

  it("fits a demo visitor's plan to at most 20 customers considered, as the engine requires", () => {
    const fitted = fitPlan(GOAL, read({ max_candidates: 250 }), {}, DEMO_LIMITS, "demo");
    expect(fitted.settings).toMatchObject({ maxCandidates: 20 });
    expect(fitted.changes).toContain("Customers considered changed from 250 to 20; a campaign considers 2 to 20.");
    expect(fitPlan(GOAL, read({}), { maxCandidates: 20 }, DEMO_LIMITS, "demo").settings).toMatchObject({ maxCandidates: 20 });
  });
});

describe("cleanGoal", () => {
  it("makes one line with no control or invisible character, no angle bracket and no email", () => {
    expect(cleanGoal("  win back\nregulars <b>now</b> and email me at boss@shop.example​ ")).toBe("win back regulars  b now /b  and email me at [email removed]");
  });
});

describe("readGoal", () => {
  it("sends only the goal text, with effort low and no sampling settings, and returns the numbers", async () => {
    state.claudeAnswers.push(claudeJson({ budget_usd: 50, unclear: false, reason: "" }));
    const session = new ClaudeSession({ role: "owner", sessionId: "e".repeat(64), expiresAt: new Date() }, randomUUID(), 5_000, "198.51.100.1");
    const outcome = await readGoal(session, GOAL);
    session.close();
    expect(outcome).toEqual({ status: "read", goal: { budget_usd: 50, unclear: false, reason: "" } });
    const [sent] = state.claude;
    expect(sent.model).toBe("claude-haiku-5-5");
    expect(sent.max_tokens).toBe(2000);
    expect(sent.messages).toEqual([{ role: "user", content: `<goal>\n${GOAL}\n</goal>` }]);
    expect((sent.output_config as { effort: string; format: { type: string } }).effort).toBe("low");
    expect((sent.output_config as { format: { type: string } }).format.type).toBe("json_schema");
    expect((sent.system as { cache_control: unknown }[])[0].cache_control).toEqual({ type: "ephemeral" });
    for (const banned of ["temperature", "top_p", "top_k", "thinking", "tool_choice"]) expect(sent, banned).not.toHaveProperty(banned);
  });

  it("reports a refusal as declined and an unreadable answer as unreadable, without retrying", async () => {
    const owner = { role: "owner" as const, sessionId: "e".repeat(64), expiresAt: new Date() };
    state.claudeAnswers.push(claudeJson({ budget_usd: 50, unclear: false, reason: "" }, "refusal"));
    const declined = new ClaudeSession(owner, randomUUID(), 5_000, "198.51.100.1");
    expect((await readGoal(declined, GOAL)).status).toBe("declined");
    state.claudeAnswers.push(() =>
      Response.json({ id: "m", type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: "not json" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    const garbled = new ClaudeSession(owner, randomUUID(), 5_000, "198.51.100.1");
    expect((await readGoal(garbled, GOAL)).status).toBe("unreadable");
    expect(state.claude).toHaveLength(2);
    declined.close();
    garbled.close();
  });
});

describe("POST /api/campaigns/plan", () => {
  it("drafts an owner's $50 goal at 5000 cents from one Claude call", async () => {
    state.claudeAnswers.push(claudeJson({ budget_usd: 50, unclear: false, reason: "" }));
    const response = await plan(signIn("owner"), { goalText: GOAL });
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(201);
    expect(body).toMatchObject({ campaignId: CAMPAIGN, rewarded: 10, aiCalls: 1, plan: { goal: "read", changes: [], notice: null, settings: { budgetMinor: 5000, maxCandidates: 40 } } });
    const draft = state.engineCalls.find((call) => call.task === "draft_campaign");
    expect(draft?.args[0]).toEqual({ goal_text: GOAL, as_of: "2026-10-16", budget_minor: 5000, per_recipient_minor: 1000, holdout_share: "0.50", max_candidates: 40 });
    expect(state.hits).toEqual(["draft", "claude_owner"]);
  });

  it("clamps a demo visitor's $50 to 1000 cents and says so, counting the Claude call on the session, its client address and every demo", async () => {
    state.claudeAnswers.push(claudeJson({ budget_usd: 50, unclear: false, reason: "" }));
    const response = await plan(signIn("demo"), { goalText: GOAL });
    const body = (await response.json()) as { plan: { settings: Record<string, unknown>; changes: string[] } };
    expect(response.status).toBe(201);
    expect(body.plan.settings).toMatchObject({ budgetMinor: 1000, perRecipientMinor: 200, maxCandidates: 10 });
    expect(body.plan.changes).toContain("Budget lowered from $50.00 to $10.00, the most one campaign may spend on this account.");
    expect((state.engineCalls.find((call) => call.task === "draft_campaign")?.args[0] as { budget_minor: number }).budget_minor).toBe(1000);
    expect(state.hits).toEqual(["draft", "claude_demo_session", "claude_demo_address", "claude_demo_all"]);
  });

  it("plans from the form with no key, and asks plainly for a budget when the form has none", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const owner = signIn("owner");
    const drafted = await plan(owner, { goalText: GOAL, budgetMinor: 3000 });
    expect(drafted.status).toBe(201);
    expect(await drafted.json()).toMatchObject({ aiCalls: 0, plan: { goal: "no_key", notice: expect.stringContaining("needs an Anthropic API key"), settings: { budgetMinor: 3000 } } });
    const missing = await plan(owner, { goalText: GOAL });
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({ error: "needs_budget", message: expect.stringContaining("Give a budget") });
    expect(state.claude).toEqual([]);
  });

  it("falls back to the form with a clear notice when the daily Claude limit is used up", async () => {
    state.refuse = ["claude_demo_session"];
    const response = await plan(signIn("demo"), { goalText: GOAL, budgetMinor: 50 });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ aiCalls: 0, plan: { goal: "limit_reached", notice: expect.stringContaining("daily limit"), settings: { budgetMinor: 50 } } });
    expect(state.claude).toEqual([]);
  });

  it("refuses a missing CSRF token, a visitor with no session and a bad body before the engine is asked", async () => {
    const owner = signIn("owner");
    expect((await plan(owner, { goalText: GOAL }, "none")).status).toBe(403);
    expect((await plan(null, { goalText: GOAL })).status).toBe(403);
    expect((await plan(owner, { goalText: GOAL, budgetMinor: 1.5 })).status).toBe(400);
    expect((await plan(owner, { goalText: "​\n " })).status).toBe(400);
    expect((await plan(owner, { goalText: GOAL, extra: 1 })).status).toBe(400);
    expect(state.engineCalls).toEqual([]);
    expect(state.claude).toEqual([]);
  });
});
