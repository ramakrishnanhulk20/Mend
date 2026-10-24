// Covers claude.ts with the real SDK talking to a fake Anthropic API through a stubbed
// fetch, and the Postgres caps replaced by a recorder: the fixed host and model, the
// outbound email and secret refusal, one cap hit per HTTP call including each
// tool-runner round, error codes, and token logging without content. Does NOT cover:
// the real API (npm run prove:m6), the caps counted in Postgres (ratelimit.test.ts),
// or the prompts each caller builds (goal, notes and agent tests).
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SignedIn } from "./permissions";

const state = vi.hoisted(() => ({ hits: [] as { bucket: string; subject: string }[], refuse: null as string | null }));

vi.mock("./ratelimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ratelimit")>();
  return {
    ...actual,
    takeHit: vi.fn(async (limit: { bucket: string }, subject: string) => {
      state.hits.push({ bucket: limit.bucket, subject });
      return limit.bucket === state.refuse ? { allowed: false, retryAfterSeconds: 60 } : { allowed: true };
    }),
  };
});

const { ClaudeKeyMissing, ClaudeSession, ClaudeStopped, MODEL, claudeClient, failureOf, hasClaudeKey, outboundProblem, plainText, withoutEmails } =
  await import("./claude");

const KEY = "fake-claude-key-for-tests-0123456789";
const DEMO: SignedIn = { role: "demo", sessionId: "d".repeat(64), expiresAt: new Date(Date.now() + 60_000) };
const OWNER: SignedIn = { role: "owner", sessionId: "e".repeat(64), expiresAt: new Date(Date.now() + 60_000) };
const REF = "4b0f6a52-3c1d-4e5f-8a9b-0c1d2e3f4a5b";

type Sent = { readonly url: string; readonly body: Record<string, unknown>; readonly headers: Headers };
let sent: Sent[] = [];
let answers: ((init?: RequestInit) => Response | Promise<Response>)[] = [];
let logged: string[] = [];

function message(content: unknown[], stopReason = "end_turn", usage = { input_tokens: 12, output_tokens: 3 }): Response {
  return Response.json(
    { id: "msg_1", type: "message", role: "assistant", model: MODEL, content, stop_reason: stopReason, stop_sequence: null, usage },
    { headers: { "request-id": "req_test" } },
  );
}

beforeEach(() => {
  sent = [];
  answers = [];
  logged = [];
  state.hits = [];
  state.refuse = null;
  vi.stubEnv("ANTHROPIC_API_KEY", KEY);
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://evil.example");
  vi.stubEnv("MEND_CSRF_SECRET", "csrf-secret-for-claude-tests-0123456789");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      sent.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>, headers: new Headers(init?.headers) });
      const next = answers.shift();
      if (next === undefined) throw new Error("the fake API has no answer left");
      return next(init);
    }),
  );
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
    logged.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a Claude call", () => {
  it("goes to api.anthropic.com whatever the environment says, counts on both demo caps, and logs tokens but no content", async () => {
    answers.push(() => message([{ type: "text", text: "Fine thanks" }]));
    const session = new ClaudeSession(DEMO, REF, 5_000);
    await claudeClient(session, "goal").messages.create({ model: MODEL, max_tokens: 100, messages: [{ role: "user", content: "a private goal text" }] });
    session.close();

    expect(sent.map((call) => call.url)).toEqual(["https://api.anthropic.com/v1/messages"]);
    expect(sent[0].body.model).toBe("claude-haiku-5-5");
    expect(sent[0].headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(state.hits).toEqual([
      { bucket: "claude_demo_session", subject: DEMO.sessionId },
      { bucket: "claude_demo_all", subject: "all" },
    ]);
    expect([session.calls, session.inputTokens, session.outputTokens]).toEqual([1, 12, 3]);
    const lines = logged.join("");
    expect(lines).toContain('"input_tokens":12');
    expect(lines).not.toContain("private goal");
    expect(lines).not.toContain("Fine thanks");
    expect(lines).not.toContain(KEY);
  });

  it("counts an owner call once, on the shared owner cap", async () => {
    answers.push(() => message([{ type: "text", text: "ok" }]));
    const session = new ClaudeSession(OWNER, REF, 5_000);
    await claudeClient(session, "agent").messages.create({ model: MODEL, max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    session.close();
    expect(state.hits).toEqual([{ bucket: "claude_owner", subject: "all" }]);
  });

  it.each([
    ["an email address", "please write to maya@shop.example"],
    ["a server secret", "the secret is csrf-secret-for-claude-tests-0123456789"],
    ["the API key itself", `key ${KEY}`],
  ])("is refused before anything is sent or counted when the body holds %s", async (_what, content) => {
    const session = new ClaudeSession(DEMO, REF, 5_000);
    const call = claudeClient(session, "goal").messages.create({ model: MODEL, max_tokens: 100, messages: [{ role: "user", content }] });
    await expect(call).rejects.toBeInstanceOf(ClaudeStopped);
    session.close();
    expect(sent).toEqual([]);
    expect(state.hits).toEqual([]);
    expect(session.stopped).toBe("outbound_refused");
    expect(logged.join("")).not.toContain("maya@");
  });

  it("is refused without being sent once a daily cap is used up", async () => {
    state.refuse = "claude_demo_all";
    const session = new ClaudeSession(DEMO, REF, 5_000);
    const call = claudeClient(session, "note", "R3").messages.create({ model: MODEL, max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    const error = await call.catch((caught: unknown) => caught);
    session.close();
    expect(error).toBeInstanceOf(ClaudeStopped);
    expect(failureOf(error, session)).toBe("limit_reached");
    expect(sent).toEqual([]);
    expect(session.calls).toBe(0);
    expect(logged.join("")).toContain('"reason":"claude_demo_all"');
  });
});

describe("the tool runner", () => {
  it("counts every round it sends, not just the first", async () => {
    answers.push(() => message([{ type: "tool_use", id: "toolu_1", name: "echo", input: { text: "x" } }], "tool_use"));
    answers.push(() => message([{ type: "text", text: "done" }]));
    const echo = betaZodTool({ name: "echo", description: "Echo text", inputSchema: z.object({ text: z.string() }), run: async ({ text }) => text });
    const session = new ClaudeSession(DEMO, REF, 5_000);
    const runner = claudeClient(session, "agent").beta.messages.toolRunner({ model: MODEL, max_tokens: 100, messages: [{ role: "user", content: "go" }], tools: [echo] });
    const seen: (string | null)[] = [];
    for await (const reply of runner) seen.push(reply.stop_reason);
    session.close();
    expect(seen).toEqual(["tool_use", "end_turn"]);
    expect(sent).toHaveLength(2);
    expect(session.calls).toBe(2);
    expect(state.hits).toHaveLength(4);
  });
});

describe("failureOf", () => {
  it("turns each SDK error into its fixed code, most specific first, and rethrows anything else", async () => {
    const ask = async (session: InstanceType<typeof ClaudeSession>) =>
      claudeClient(session, "goal")
        .messages.create({ model: MODEL, max_tokens: 100, messages: [{ role: "user", content: "hi" }] }, { signal: session.signal })
        .catch((caught: unknown) => caught);

    answers.push(() => Response.json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, { status: 429, headers: { "x-should-retry": "false" } }));
    const busy = new ClaudeSession(OWNER, REF, 5_000);
    expect(failureOf(await ask(busy), busy)).toBe("busy");

    answers.push(() => Response.json({ type: "error", error: { type: "api_error", message: "boom" } }, { status: 500, headers: { "x-should-retry": "false" } }));
    const down = new ClaudeSession(OWNER, REF, 5_000);
    expect(failureOf(await ask(down), down)).toBe("unavailable");

    // An answer that never comes, given up only when the request's signal aborts, as real fetch does.
    answers.push(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
    );
    const slow = new ClaudeSession(OWNER, REF, 50);
    expect(failureOf(await ask(slow), slow)).toBe("timed_out");

    const other = new ClaudeSession(OWNER, REF, 5_000);
    expect(() => failureOf(new TypeError("a bug"), other)).toThrow(TypeError);
    for (const session of [busy, down, slow, other]) session.close();
  });
});

describe("helpers", () => {
  it("say plainly when no key is set and refuse to build a client", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(hasClaudeKey()).toBe(false);
    const session = new ClaudeSession(DEMO, REF, 5_000);
    expect(() => claudeClient(session, "goal")).toThrow(ClaudeKeyMissing);
    session.close();
  });

  it("strip markdown images, HTML and emails from model text, and redact emails from typed text", () => {
    const reply = plainText('Hi ![x](https://evil.example/?d=1) <img src=x onerror=alert(1)> <b>bold</b> mail a@b.example\u0007 ok', 200);
    expect(reply).toBe("Hi   bold mail [email removed] ok");
    expect(withoutEmails("send to evil@example.com now")).toBe("send to [email removed] now");
    expect(outboundProblem('{"text":"no address here"}')).toBeNull();
  });
});
