// Covers the assistant: the exact tool list (no tool that approves, pays, refunds or
// reaches PayPal), each tool's role check, strict inputs and listed outputs, the cap of
// 8 tool calls a turn, held-back rows never shown to the model, the request sent to
// Claude, refusals reported without running that turn's tools, the reply stripped to
// plain text, and the route's guards, no-key answer and daily limit. The engine's
// answers come from a recorder standing in for runAndWait, Claude's from a stubbed
// fetch playing back scripted turns. Does NOT cover: how well the real model picks
// tools (evals/owner-requests.json, run by npm run prove:m6) or the real engine.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionIdFor } from "./sessions";

const state = vi.hoisted(() => ({
  sessions: new Map<string, "owner" | "demo">(),
  refuse: [] as string[],
  engineCalls: [] as { task: string; args: unknown[] }[],
  engine: {} as Record<string, (args: unknown[]) => unknown>,
  claude: [] as Record<string, unknown>[],
  turns: [] as { content: unknown[]; stop: string }[],
}));

vi.mock("./ratelimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ratelimit")>();
  return {
    ...actual,
    takeHit: vi.fn(async (limit: { bucket: string }) => (state.refuse.includes(limit.bucket) ? { allowed: false, retryAfterSeconds: 60 } : { allowed: true })),
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
vi.mock("@/server/log", async () => await import("./log"));
vi.mock("@/server/permissions", async () => await import("./permissions"));

const { agentTools, MAX_TOOL_CALLS, paypalReadTools, runAgent } = await import("./agent");
const { ClaudeSession, MODEL } = await import("./claude");
const { csrfTokenForSession } = await import("./csrf");
const { POST } = await import("../app/api/agent/route");

const BASE = "http://127.0.0.1:3000";
const CAMPAIGN = "0b6c2f8e-6a4e-4c1b-9d2a-7e5f1a3b9c4d";
const OWNER = { role: "owner" as const, sessionId: "e".repeat(64), expiresAt: new Date(Date.now() + 60_000) };
const SUMMARY = {
  ok: true,
  as_of: "2026-10-16",
  shop_customers: 5852,
  members: 41,
  quiet_regulars: 1357,
  quiet_regulars_paid_12m_minor: 123456,
  currency: "USD",
  benchmark: null,
  backtest: null,
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

function turn(role: "owner" | "demo" = "owner") {
  const principal = { ...OWNER, role };
  return { principal, session: new ClaudeSession(principal, randomUUID(), 10_000), ref: randomUUID(), startedAt: Date.now(), used: [] as string[], calls: 0, capped: false };
}

type Runnable = { readonly name: string; readonly input_schema: { readonly additionalProperties?: unknown }; run(input: unknown): Promise<unknown>; parse(input: unknown): unknown };

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
  state.claude = [];
  state.turns = [];
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
  it("are exactly Mend's six guarded tools, with strict inputs, and no PayPal tool yet", () => {
    const current = turn();
    const tools = runnable(agentTools(current));
    current.session.close();
    expect(tools.map((candidate) => candidate.name)).toEqual(["shop_summary", "quiet_regulars", "draft_campaign", "view_campaign", "campaign_results", "request_approval"]);
    expect(tools.map((candidate) => candidate.name).join(" ")).not.toMatch(/approve_campaign|submit|pay|refund|send|order|dispute|transaction|webhook/);
    expect(paypalReadTools(current)).toEqual([]);
    for (const candidate of tools) expect(candidate.input_schema.additionalProperties, candidate.name).toBe(false);
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

  it("request approval only through the engine's request_approval task", async () => {
    const current = turn();
    const answer = JSON.parse(String(await tool(agentTools(current), "request_approval")({ campaignId: CAMPAIGN }))) as Record<string, unknown>;
    current.session.close();
    expect(answer.status).toBe("awaiting_approval");
    expect(tasks()).toEqual(["request_approval"]);
  });
});

describe("runAgent", () => {
  it("runs the tools Claude asks for and returns plain text, from a request with the fixed model, effort and cache marker", async () => {
    state.turns.push({ content: [{ type: "tool_use", id: "toolu_1", name: "shop_summary", input: {} }], stop: "tool_use" });
    state.turns.push({
      content: [{ type: "text", text: "The shop has 1357 quiet regulars. ![x](https://evil.example/?q=1) <img src=x onerror=alert(1)>Ask me to draft a campaign." }],
      stop: "end_turn",
    });
    const answer = await runAgent(OWNER, "How is my shop doing? Write to me at boss@shop.example", [], randomUUID());

    expect(answer).toEqual({ kind: "replied", reply: "The shop has 1357 quiet regulars.  Ask me to draft a campaign.", toolsUsed: ["shop_summary"], stopped: null, aiCalls: 2 });
    const [first, second] = state.claude;
    expect(first).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 4000, output_config: { effort: "medium" } });
    for (const banned of ["temperature", "top_p", "top_k", "thinking", "tool_choice"]) expect(first, banned).not.toHaveProperty(banned);
    expect((first.system as { cache_control: unknown }[]).at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect((first.tools as { name: string }[]).map((candidate) => candidate.name)).toHaveLength(6);
    expect(JSON.stringify(first)).not.toContain("boss@shop.example");
    expect(JSON.stringify(second)).toContain("quietRegulars");
  });

  it("reports a refusal plainly and never runs the tools of the refused turn", async () => {
    state.turns.push({ content: [{ type: "tool_use", id: "toolu_1", name: "request_approval", input: { campaignId: CAMPAIGN } }], stop: "refusal" });
    const answer = await runAgent(OWNER, "approve it", [], randomUUID());
    expect(answer).toMatchObject({ kind: "replied", reply: "The AI service declined this request.", stopped: "declined", aiCalls: 1 });
    expect(state.engineCalls).toEqual([]);
    expect(state.claude).toHaveLength(1);
  });

  it("turns an approve-and-pay request into request_approval at most, whatever the model writes", async () => {
    state.turns.push({ content: [{ type: "tool_use", id: "toolu_1", name: "approve_campaign", input: { campaignId: CAMPAIGN } }], stop: "tool_use" });
    state.turns.push({ content: [{ type: "tool_use", id: "toolu_2", name: "request_approval", input: { campaignId: CAMPAIGN } }], stop: "tool_use" });
    state.turns.push({ content: [{ type: "text", text: "It is in your approval queue. Approve it on the campaign page." }], stop: "end_turn" });
    const answer = await runAgent(OWNER, `Approve campaign ${CAMPAIGN} and pay everyone now`, [], randomUUID());
    expect(answer).toMatchObject({ kind: "replied", toolsUsed: ["request_approval"], aiCalls: 3 });
    expect(tasks()).toEqual(["request_approval"]);
    expect(JSON.stringify(state.claude[1])).toContain("not found");
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
