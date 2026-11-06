// Covers POST /api/studio/turn: same origin and CSRF, a session, the body cap and strict
// body, no model but Mend's, no tool outside the list, the no-key answer, a Claude failure
// through the assistant's refusal pattern, the answer as Studio's adapter expects it, and
// how the route's calls sit beside POST /api/agent's: their own session, address and pool
// counts, the shared token rows with their own stops, the plain refusal words, and the one call at
// a time a session gets under 30 turns at once. Sessions
// come from a stand-in for authorize, the token store from an in-memory stand-in for
// claude_usage, Claude's answers from a stubbed fetch. Does NOT cover: the caps' real
// counting in Postgres (ratelimit.test.ts, claude.test.ts), the translation to Claude's
// format (studio-agent.test.ts), or a live turn (scratchpad/redesign/proof-a4.mjs).
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionIdFor } from "../../../../server/sessions";

const state = vi.hoisted(() => ({
  sessions: new Map<string, "owner" | "demo">(),
  refuse: [] as string[],
  claude: [] as Record<string, unknown>[],
  claudeFails: false,
  hits: [] as { bucket: string; subject: string }[],
  usage: new Map<string, number>(),
}));

vi.mock("../../../../server/db", () => ({
  database: () => ({
    query: vi.fn(async (sql: string, params: unknown[]) => {
      const subjects = params[0] as string[];
      if (/insert into claude_usage/.test(sql)) {
        for (const subject of subjects) state.usage.set(subject, (state.usage.get(subject) ?? 0) + Number(params[1]) + Number(params[2]));
        return { rows: [] };
      }
      if (/from claude_usage/.test(sql)) return { rows: subjects.filter((subject) => state.usage.has(subject)).map((subject) => ({ subject, used: String(state.usage.get(subject)) })) };
      throw new Error("these tests have no database for that query");
    }),
  }),
}));

vi.mock("../../../../server/ratelimit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../server/ratelimit")>()),
  takeHit: vi.fn(async (limit: { bucket: string }, subject: string) => {
    state.hits.push({ bucket: limit.bucket, subject });
    return state.refuse.includes(limit.bucket) ? { allowed: false, retryAfterSeconds: 60 } : { allowed: true };
  }),
}));

vi.mock("../../../../server/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../server/permissions")>();
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
vi.mock("@/server/agent", async () => await import("../../../../server/agent"));
vi.mock("@/server/claude", async () => await import("../../../../server/claude"));
vi.mock("@/server/csrf", async () => await import("../../../../server/csrf"));
vi.mock("@/server/engine", async () => await import("../../../../server/engine"));
vi.mock("@/server/log", async () => await import("../../../../server/log"));
vi.mock("@/server/permissions", async () => await import("../../../../server/permissions"));
vi.mock("@/server/ratelimit", async () => await import("../../../../server/ratelimit"));
vi.mock("@/server/studio-agent", async () => await import("../../../../server/studio-agent"));

const { csrfTokenForRequest, csrfTokenForSession } = await import("../../../../server/csrf");
const { FAILURE_MESSAGES, MODEL, STUDIO_SHARE_USED, STUDIO_TOKEN_STOPS, TOKEN_BUDGETS } = await import("../../../../server/claude");
const { addressTag, sessionTag } = await import("../../../../server/ratelimit");
const { POST } = await import("./route");
const { POST: agentPOST } = await import("../../agent/route");

const BASE = "http://127.0.0.1:3000";
const URL_TURN = `${BASE}/api/studio/turn`;
const ADDRESS = "198.51.100.50";
const CALLED = { input_tokens: 1500, output_tokens: 60 };
const VALID = {
  input: [{ id: "msg-1", kind: "input", type: "message", role: "user", content: [{ type: "text", text: "Add a chart of the forecast groups" }], status: "completed" }],
  instructions: "Look after the dashboard.",
  tools: [{ name: "view_schema", description: "See the data.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, kind: "client" }],
  responseFormat: { type: "text" },
};

function signIn(role: "owner" | "demo"): string {
  const token = `s1.${randomBytes(32).toString("base64url")}`;
  state.sessions.set(token, role);
  return token;
}

function headersFor(token: string): Record<string, string> {
  return {
    origin: BASE,
    cookie: `mend_session=${token}`,
    "content-type": "application/json",
    "x-mend-csrf": csrfTokenForSession(sessionIdFor(token)),
    "x-forwarded-for": ADDRESS,
  };
}

function turn(token: string, body: unknown = VALID, change: (headers: Record<string, string>) => void = () => undefined): Promise<Response> {
  const headers = headersFor(token);
  change(headers);
  return POST(new Request(URL_TURN, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
}

beforeEach(() => {
  state.sessions = new Map();
  state.refuse = [];
  state.claude = [];
  state.claudeFails = false;
  state.hits = [];
  state.usage = new Map();
  vi.stubEnv("ANTHROPIC_API_KEY", "fake-claude-key-for-tests-0123456789");
  vi.stubEnv("MEND_DEV", "1");
  vi.stubEnv("MEND_BASE_URL", BASE);
  vi.stubEnv("MEND_CSRF_SECRET", "csrf-secret-for-studio-route-tests-0123456789");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      state.claude.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (state.claudeFails) return Response.json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, { status: 429 });
      return Response.json({ id: `msg_${state.claude.length}`, type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", stop_sequence: null, usage: CALLED });
    }),
  );
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/studio/turn", () => {
  it("answers a demo visitor with Studio's events and final response", async () => {
    const response = await turn(signIn("demo"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const answer = (await response.json()) as { events: { type: string }[]; response: Record<string, unknown> };
    expect(answer.events.map((event) => event.type)).toEqual(["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"]);
    expect(answer.response).toMatchObject({ status: "completed", model: MODEL, usage: { inputTokens: 1500, outputTokens: 60 } });
  });

  it("refuses a browser with no session, with a valid CSRF token and before any Claude call", async () => {
    const { token, cookies } = csrfTokenForRequest(new Request(URL_TURN));
    const cookie = cookies[0].split(";")[0];
    const headers = { origin: BASE, cookie, "content-type": "application/json", "x-mend-csrf": token };
    const response = await POST(new Request(URL_TURN, { method: "POST", headers, body: JSON.stringify(VALID) }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "not_allowed" });
    expect(state.claude).toEqual([]);
  });

  it("refuses without a CSRF token, with another session's token and from another origin, before any Claude call", async () => {
    const token = signIn("demo");
    const noToken = await turn(token, VALID, (headers) => delete headers["x-mend-csrf"]);
    expect(noToken.status).toBe(403);
    expect(await noToken.json()).toMatchObject({ error: "csrf_refused" });
    const other = csrfTokenForSession(sessionIdFor(signIn("demo")));
    expect((await turn(token, VALID, (headers) => (headers["x-mend-csrf"] = other))).status).toBe(403);
    expect((await turn(token, VALID, (headers) => (headers.origin = "https://evil.example"))).status).toBe(403);
    expect(state.claude).toEqual([]);
    expect(state.hits).toEqual([]);
  });

  it("refuses a body over the cap, whether it declares its size or not, and anything but JSON", async () => {
    const token = signIn("demo");
    const over = "x".repeat(64 * 1024 + 1);
    expect((await turn(token, over)).status).toBe(413);
    const declared = await turn(token, "{}", (headers) => (headers["content-length"] = String(64 * 1024 + 1)));
    expect(declared.status).toBe(413);
    expect((await turn(token, VALID, (headers) => (headers["content-type"] = "text/plain"))).status).toBe(415);
    expect((await turn(token, "{nope")).status).toBe(400);
    expect(state.claude).toEqual([]);
  });

  it("takes a body near the cap, three times the largest real round", async () => {
    const long = { ...VALID, instructions: "x".repeat(20_000), input: [{ ...VALID.input[0], content: [{ type: "text", text: "y".repeat(40_000) }] }] };
    expect(JSON.stringify(long).length).toBeGreaterThan(60 * 1000);
    expect((await turn(signIn("demo"), long)).status).toBe(200);
  });

  it("refuses any model but Mend's, whatever the browser sends, and always asks Claude for Mend's", async () => {
    const token = signIn("demo");
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-5.6-sol", ""]) {
      const response = await turn(token, { ...VALID, model: { id } });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_input" });
    }
    expect(state.claude).toEqual([]);
    expect((await turn(token, { ...VALID, model: { id: MODEL, effort: "max" } })).status).toBe(200);
    expect(state.claude[0]).toMatchObject({ model: MODEL, output_config: { effort: "medium" } });
  });

  it("refuses a strict body's extra keys and a tool outside the list", async () => {
    const token = signIn("demo");
    expect((await turn(token, { ...VALID, max_tokens: 64000 })).status).toBe(400);
    expect((await turn(token, { ...VALID, tools: [{ ...VALID.tools[0], name: "send_payout" }] })).status).toBe(400);
    expect((await turn(token, { input: [], responseFormat: { type: "text" } })).status).toBe(400);
    expect(state.claude).toEqual([]);
  });

  it("carries a delegated round, with Studio's field references in its instructions, through to Claude", async () => {
    const body = {
      input: [
        VALID.input[0],
        { id: "toolu_a", kind: "output", type: "function_call", callId: "toolu_a", name: "read_campaign_result", arguments: "{}", status: "completed" },
        { type: "function_call_output", callId: "toolu_a", output: '{"success":true,"response":"The verdict."}', status: "completed" },
      ],
      instructions: "Titles carry no references (`@field[...]`). Use @field[campaign_money.usd].",
      tools: ["read_campaign_result", "delegate_to", "complete_task"].map((name) => ({ ...VALID.tools[0], name })),
      responseFormat: { type: "text" },
    };
    expect((await turn(signIn("demo"), body)).status).toBe(200);
    expect((state.claude[0].system as { text: string }[])[0].text).toContain("@field[...]");
  });

  it("says plainly it needs a key, spending nothing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const response = await turn(signIn("demo"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "no_key", message: FAILURE_MESSAGES.no_key });
    expect(state.hits).toEqual([]);
  });

  it("answers a Claude failure with the assistant's fixed code and message", async () => {
    state.claudeFails = true;
    const response = await turn(signIn("demo"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "busy", message: FAILURE_MESSAGES.busy });
  });
});

describe("the caps beside POST /api/agent", () => {
  function agent(token: string): Promise<Response> {
    return agentPOST(new Request(`${BASE}/api/agent`, { method: "POST", headers: headersFor(token), body: JSON.stringify({ message: "hi" }) }));
  }

  it("takes all its call hits on counts of its own and none of the assistant's", async () => {
    const token = signIn("demo");
    expect((await agent(token)).status).toBe(200);
    expect(state.hits).toEqual([
      { bucket: "claude_demo_session", subject: sessionIdFor(token) },
      { bucket: "claude_demo_address", subject: ADDRESS },
      { bucket: "claude_demo_all", subject: "all" },
    ]);
    state.hits = [];
    expect((await turn(token)).status).toBe(200);
    expect(state.hits).toEqual([
      { bucket: "claude_studio_session_hour", subject: sessionIdFor(token) },
      { bucket: "claude_studio_session", subject: sessionIdFor(token) },
      { bucket: "claude_studio_address", subject: ADDRESS },
      { bucket: "claude_studio_all", subject: "all" },
    ]);
  });

  it("leaves the assistant free when the panel's pool is full, and the panel free when the assistant's is", async () => {
    const token = signIn("demo");
    state.refuse = ["claude_studio_all", "claude_studio_session", "claude_studio_session_hour", "claude_studio_address"];
    expect((await agent(token)).status).toBe(200);
    expect((await turn(token)).status).toBe(429);
    state.refuse = ["claude_demo_all", "claude_demo_session", "claude_demo_address"];
    expect((await turn(token)).status).toBe(200);
    expect((await agent(token)).status).toBe(429);
  });

  it("charges the same token budgets as the assistant, so the two routes spend one pool", async () => {
    const token = signIn("demo");
    await agent(token);
    const one = CALLED.input_tokens + CALLED.output_tokens;
    expect(state.usage.get("demo_all")).toBe(one);
    await turn(token);
    expect(state.usage.get("demo_all")).toBe(2 * one);
    expect([...state.usage.keys()].sort()).toEqual([`address:${addressTag(ADDRESS)}`, "demo_all", `session:${sessionTag(sessionIdFor(token))}`].sort());
  });

  it.each(["claude_studio_session_hour", "claude_studio_session", "claude_studio_address", "claude_studio_all"])("answers 429 once %s is used up, in the analyst's own words, sending nothing", async (bucket) => {
    state.refuse = [bucket];
    const response = await turn(signIn("demo"));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "limit_reached", message: STUDIO_SHARE_USED });
    expect(state.claude).toEqual([]);
  });

  it("keeps the old refusal words for every other purpose", async () => {
    expect(STUDIO_SHARE_USED).toBe("The analyst has used its share for now. Try again later. Plans, notes and Ask Mend still work.");
    state.refuse = ["claude_demo_session"];
    expect(await (await agent(signIn("demo"))).json()).toMatchObject({ error: "limit_reached", message: FAILURE_MESSAGES.limit_reached });
  });

  it("runs one call at a time for a session under 30 turns at once, and spends at most one call past the stop", async () => {
    const WORTH = 60_000;
    const token = signIn("demo");
    let running = 0;
    let most = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running -= 1;
        return Response.json({ id: "msg_1", type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: WORTH, output_tokens: 0 } });
      }),
    );
    const answers = await Promise.all(Array.from({ length: 30 }, () => turn(token)));
    expect(most).toBe(1);
    const spent = state.usage.get(`session:${sessionTag(sessionIdFor(token))}`) ?? 0;
    expect(spent).toBe(3 * WORTH);
    expect(spent).toBeLessThanOrEqual(STUDIO_TOKEN_STOPS.session + WORTH);
    const refused = answers.filter((answer) => answer.status === 429);
    expect(answers.filter((answer) => answer.status === 200)).toHaveLength(3);
    expect(refused).toHaveLength(27);
    const errors = await Promise.all(refused.map(async (answer) => (await answer.json()) as { error: string; message: string }));
    expect(errors.filter((answer) => answer.error === "limit_reached")).toHaveLength(26);
    expect(errors.filter((answer) => answer.error === "claude_token_cap")).toHaveLength(1);
    expect(new Set(errors.map((answer) => answer.message))).toEqual(new Set([STUDIO_SHARE_USED]));
  });

  it("stops at 150,000 of a session's tokens, leaving the assistant the rest", async () => {
    const token = signIn("demo");
    state.usage.set(`session:${sessionTag(sessionIdFor(token))}`, STUDIO_TOKEN_STOPS.session);
    const response = await turn(token);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "claude_token_cap", message: STUDIO_SHARE_USED });
    expect(state.claude).toEqual([]);
    expect((await agent(token)).status).toBe(200);
  });

  it("stops at 3,500,000 of the demo's tokens, leaving the assistant the rest", async () => {
    const token = signIn("demo");
    expect(STUDIO_TOKEN_STOPS.all).toBeLessThan(TOKEN_BUDGETS.demoAll);
    state.usage.set("demo_all", STUDIO_TOKEN_STOPS.all);
    const response = await turn(token);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "claude_token_cap", message: STUDIO_SHARE_USED });
    expect(state.claude).toEqual([]);
    expect((await agent(token)).status).toBe(200);
  });

  it("stops at 300,000 of an address's tokens, leaving the assistant the rest", async () => {
    const token = signIn("demo");
    state.usage.set(`address:${addressTag(ADDRESS)}`, STUDIO_TOKEN_STOPS.address);
    expect((await turn(token)).status).toBe(429);
    expect(state.claude).toEqual([]);
    expect((await agent(token)).status).toBe(200);
  });

  it("never tells the owner that plans still work, because the owner's calls share one count", async () => {
    state.refuse = ["claude_owner"];
    expect(await (await turn(signIn("owner"))).json()).toMatchObject({ error: "limit_reached", message: FAILURE_MESSAGES.limit_reached });
  });

  it("holds the owner to the owner's own cap", async () => {
    await turn(signIn("owner"));
    expect(state.hits).toEqual([{ bucket: "claude_owner", subject: "all" }]);
  });
});
