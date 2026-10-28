// Covers claude.ts with the real SDK talking to a fake Anthropic API through a stubbed
// fetch, the call caps replaced by a recorder, and the daily token budgets counted in a
// throwaway Postgres schema: the fixed host and model, the outbound email refusal (every
// address the engine's receiver rule accepts, as the engine itself judges them), the
// secret refusal (the listed settings and every setting whose name says it is secret,
// with the minimum length the log scrubber and the audit rule share), one hit on each
// call cap per HTTP call including each tool-runner round, the token budgets per demo
// session, demo address, all demo traffic and the owner, each call's usage added in one
// statement, error codes, and token logging without content. Does NOT cover:
// the real API (npm run prove:m6), the call caps counted in Postgres (ratelimit.test.ts),
// or the prompts each caller builds (goal, notes and agent tests).
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ENGINE_DIR, SCHEMA_PATH, type DevDatabase } from "../../scripts/dev-database";
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

const { ClaudeKeyMissing, ClaudeSession, ClaudeStopped, FAILURE_MESSAGES, MODEL, claudeClient, failureOf, failureStatus, hasClaudeKey, outboundProblem, plainText, withoutEmails } =
  await import("./claude");
const { MIN_SECRET_CHARS, scrubbed } = await import("./permissions");
const { secretValues } = await import("./secrets");
const { appendAudit } = await import("./audit");
const { closeDatabase, database } = await import("./db");
const { addressTag, sessionTag } = await import("./ratelimit");

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

const PYTHON = path.join(ENGINE_DIR, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const KEY = "fake-claude-key-for-tests-0123456789";
const DEMO: SignedIn = { role: "demo", sessionId: "d".repeat(64), expiresAt: new Date(Date.now() + 60_000) };
const OWNER: SignedIn = { role: "owner", sessionId: "e".repeat(64), expiresAt: new Date(Date.now() + 60_000) };
const REF = "4b0f6a52-3c1d-4e5f-8a9b-0c1d2e3f4a5b";
const ADDRESS = "198.51.100.70";
const TODAY = "(now() at time zone 'utc')::date";
const schema = `web_claude_${process.pid}_${Date.now()}`;
let dev: DevDatabase;
let admin: pg.Client;
let schemaUrl = "";

type Sent = { readonly url: string; readonly body: Record<string, unknown>; readonly headers: Headers };
let sent: Sent[] = [];
let answers: ((init?: RequestInit) => Response | Promise<Response>)[] = [];
let logged: string[] = [];

function message(content: unknown[], stopReason = "end_turn", usage: Readonly<Record<string, number>> = { input_tokens: 12, output_tokens: 3 }): Response {
  return Response.json(
    { id: "msg_1", type: "message", role: "assistant", model: MODEL, content, stop_reason: stopReason, stop_sequence: null, usage },
    { headers: { "request-id": "req_test" } },
  );
}

function visitor(): SignedIn {
  return { role: "demo", sessionId: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 60_000) };
}

function ask(session: InstanceType<typeof ClaudeSession>, content = "hi") {
  return claudeClient(session, "goal").messages.create({ model: MODEL, max_tokens: 100, messages: [{ role: "user", content }] });
}

/** What ask() settles to: the error a refused call throws, or null for an answered one. */
async function outcome(session: InstanceType<typeof ClaudeSession>): Promise<unknown> {
  return ask(session).then(
    () => null,
    (caught: unknown) => caught,
  );
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
  schemaUrl = url.href;
});

afterAll(async () => {
  await closeDatabase();
  if (admin) {
    await admin.query(`drop schema if exists ${admin.escapeIdentifier(schema)} cascade`);
    await admin.end();
  }
  await dev?.release();
});

beforeEach(async () => {
  sent = [];
  answers = [];
  logged = [];
  state.hits = [];
  state.refuse = null;
  await admin.query("delete from claude_usage");
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  vi.stubEnv("PAYPAL_CLIENT_ID", "fake-client-id");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "fake-client-secret");
  vi.stubEnv("PAYPAL_WEBHOOK_ID", "TESTWEBHOOK1");
  vi.stubEnv("DATABASE_URL", schemaUrl);
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
  it("goes to api.anthropic.com whatever the environment says, counts on all three demo caps, and logs tokens but no content", async () => {
    answers.push(() => message([{ type: "text", text: "Fine thanks" }]));
    const session = new ClaudeSession(DEMO, REF, 5_000, ADDRESS);
    await claudeClient(session, "goal").messages.create({ model: MODEL, max_tokens: 100, messages: [{ role: "user", content: "a private goal text" }] });
    session.close();

    expect(sent.map((call) => call.url)).toEqual(["https://api.anthropic.com/v1/messages"]);
    expect(sent[0].body.model).toBe("claude-haiku-5-5");
    expect(sent[0].headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(state.hits).toEqual([
      { bucket: "claude_demo_session", subject: DEMO.sessionId },
      { bucket: "claude_demo_address", subject: ADDRESS },
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
    const session = new ClaudeSession(OWNER, REF, 5_000, ADDRESS);
    await claudeClient(session, "agent").messages.create({ model: MODEL, max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    session.close();
    expect(state.hits).toEqual([{ bucket: "claude_owner", subject: "all" }]);
  });

  it.each([
    ["an email address", "please write to maya@shop.example"],
    ["an email address with an invisible mark inside", "please write to maya​@shop.example"],
    ["a server secret", "the secret is csrf-secret-for-claude-tests-0123456789"],
    ["the API key itself", `key ${KEY}`],
  ])("is refused before anything is sent or counted when the body holds %s", async (_what, content) => {
    const session = new ClaudeSession(DEMO, REF, 5_000, ADDRESS);
    const call = claudeClient(session, "goal").messages.create({ model: MODEL, max_tokens: 100, messages: [{ role: "user", content }] });
    await expect(call).rejects.toBeInstanceOf(ClaudeStopped);
    session.close();
    expect(sent).toEqual([]);
    expect(state.hits).toEqual([]);
    expect(session.stopped).toBe("outbound_refused");
    expect(logged.join("")).not.toContain("maya");
  });

  it.each(["claude_demo_session", "claude_demo_address", "claude_demo_all"])("is refused without being sent once %s is used up", async (bucket) => {
    state.refuse = bucket;
    const session = new ClaudeSession(DEMO, REF, 5_000, ADDRESS);
    const call = claudeClient(session, "note", "R3").messages.create({ model: MODEL, max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    const error = await call.catch((caught: unknown) => caught);
    session.close();
    expect(error).toBeInstanceOf(ClaudeStopped);
    expect(failureOf(error, session)).toBe("limit_reached");
    expect(sent).toEqual([]);
    expect(session.calls).toBe(0);
    expect(logged.join("")).toContain(`"reason":"${bucket}"`);
  });
});

describe("the daily token budgets", () => {
  it("refuse the next call by claude_token_cap once one call reports 1,000,000 input tokens (the audit's repro)", async () => {
    const demo = visitor();
    answers.push(() => message([{ type: "text", text: "ok" }], "end_turn", { input_tokens: 1_000_000, output_tokens: 3 }));
    const first = new ClaudeSession(demo, REF, 5_000, "198.51.100.71");
    expect(await outcome(first)).toBeNull();
    first.close();

    const second = new ClaudeSession(demo, REF, 5_000, "198.51.100.71");
    const error = await outcome(second);
    second.close();
    expect(error).toBeInstanceOf(ClaudeStopped);
    expect(failureOf(error, second)).toBe("claude_token_cap");
    expect(second.stopped).toBe("claude_token_cap");
    expect(FAILURE_MESSAGES.claude_token_cap).toContain("token budget");
    expect(failureStatus("claude_token_cap")).toBe(429);
    expect(sent).toHaveLength(1);
    // The refused call took no hit on the call caps either.
    expect(state.hits).toHaveLength(3);
    expect(logged.join("")).toContain('"outcome":"refused","reason":"tokens_demo_session"');
  });

  it("hold the owner to 2,000,000 tokens a day", async () => {
    for (let n = 0; n < 2; n += 1) {
      answers.push(() => message([{ type: "text", text: "ok" }], "end_turn", { input_tokens: 999_999, output_tokens: 1 }));
      const session = new ClaudeSession(OWNER, REF, 5_000, ADDRESS);
      expect(await outcome(session)).toBeNull();
      session.close();
    }
    const third = new ClaudeSession(OWNER, REF, 5_000, ADDRESS);
    expect(failureOf(await outcome(third), third)).toBe("claude_token_cap");
    third.close();
    expect(sent).toHaveLength(2);
    expect(logged.join("")).toContain('"reason":"tokens_owner"');
  });

  it("count a demo address across its sessions and every demo together, and never charge the owner for either", async () => {
    const address = "198.51.100.72";
    await admin.query(`insert into claude_usage (day, subject, input_tokens, output_tokens) values (${TODAY}, $1, 399999, 1)`, [`address:${addressTag(address)}`]);
    const sameAddress = new ClaudeSession(visitor(), REF, 5_000, address);
    expect(failureOf(await outcome(sameAddress), sameAddress)).toBe("claude_token_cap");
    sameAddress.close();

    answers.push(() => message([{ type: "text", text: "ok" }]));
    const elsewhere = new ClaudeSession(visitor(), REF, 5_000, "198.51.100.73");
    expect(await outcome(elsewhere)).toBeNull();
    elsewhere.close();

    await admin.query(
      `insert into claude_usage (day, subject, input_tokens, output_tokens) values (${TODAY}, 'demo_all', 5000000, 0)
       on conflict (day, subject) do update set input_tokens = 5000000, output_tokens = 0`,
    );
    const anyDemo = new ClaudeSession(visitor(), REF, 5_000, "198.51.100.74");
    expect(failureOf(await outcome(anyDemo), anyDemo)).toBe("claude_token_cap");
    anyDemo.close();

    answers.push(() => message([{ type: "text", text: "ok" }]));
    const owner = new ClaudeSession(OWNER, REF, 5_000, address);
    expect(await outcome(owner)).toBeNull();
    owner.close();
    expect(sent).toHaveLength(2);
    const lines = logged.join("");
    expect(lines).toContain('"reason":"tokens_demo_address"');
    expect(lines).toContain('"reason":"tokens_demo_all"');
  });

  it("add each call's tokens to every subject it counts on in one statement, cache reads and writes as input, under today's UTC date", async () => {
    await admin.query(`insert into claude_usage (day, subject, input_tokens, output_tokens) values (${TODAY} - 1, 'owner', 2000000, 0)`);
    const demo = visitor();
    const address = "198.51.100.75";
    const query = vi.spyOn(database(), "query");
    answers.push(() => message([{ type: "text", text: "ok" }], "end_turn", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 1000 }));
    const session = new ClaudeSession(demo, REF, 5_000, address);
    expect(await outcome(session)).toBeNull();
    session.close();

    const writes = query.mock.calls.filter(([sql]) => typeof sql === "string" && /insert into claude_usage/.test(sql));
    expect(writes).toHaveLength(1);
    const { rows } = await admin.query(`select subject, input_tokens::int as input, output_tokens::int as output from claude_usage where day = ${TODAY} order by subject`);
    expect(rows).toEqual([
      { subject: `address:${addressTag(address)}`, input: 1110, output: 5 },
      { subject: "demo_all", input: 1110, output: 5 },
      { subject: `session:${sessionTag(demo.sessionId)}`, input: 1110, output: 5 },
    ]);

    // Yesterday's usage does not count against today.
    answers.push(() => message([{ type: "text", text: "ok" }]));
    const owner = new ClaudeSession(OWNER, REF, 5_000, ADDRESS);
    expect(await outcome(owner)).toBeNull();
    owner.close();
  });
});

describe("the tool runner", () => {
  it("counts every round it sends, not just the first", async () => {
    answers.push(() => message([{ type: "tool_use", id: "toolu_1", name: "echo", input: { text: "x" } }], "tool_use"));
    answers.push(() => message([{ type: "text", text: "done" }]));
    const echo = betaZodTool({ name: "echo", description: "Echo text", inputSchema: z.object({ text: z.string() }), run: async ({ text }) => text });
    const session = new ClaudeSession(DEMO, REF, 5_000, ADDRESS);
    const runner = claudeClient(session, "agent").beta.messages.toolRunner({ model: MODEL, max_tokens: 100, messages: [{ role: "user", content: "go" }], tools: [echo] });
    const seen: (string | null)[] = [];
    for await (const reply of runner) seen.push(reply.stop_reason);
    session.close();
    expect(seen).toEqual(["tool_use", "end_turn"]);
    expect(sent).toHaveLength(2);
    expect(session.calls).toBe(2);
    expect(state.hits).toHaveLength(6);
  });
});

describe("failureOf", () => {
  it("turns each SDK error into its fixed code, most specific first, and rethrows anything else", async () => {
    const asked = async (session: InstanceType<typeof ClaudeSession>) =>
      claudeClient(session, "goal")
        .messages.create({ model: MODEL, max_tokens: 100, messages: [{ role: "user", content: "hi" }] }, { signal: session.signal })
        .catch((caught: unknown) => caught);

    answers.push(() => Response.json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, { status: 429, headers: { "x-should-retry": "false" } }));
    const busy = new ClaudeSession(OWNER, REF, 5_000, ADDRESS);
    expect(failureOf(await asked(busy), busy)).toBe("busy");

    answers.push(() => Response.json({ type: "error", error: { type: "api_error", message: "boom" } }, { status: 500, headers: { "x-should-retry": "false" } }));
    const down = new ClaudeSession(OWNER, REF, 5_000, ADDRESS);
    expect(failureOf(await asked(down), down)).toBe("unavailable");

    // An answer that never comes, given up only when the request's signal aborts, as real fetch does.
    answers.push(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
    );
    const slow = new ClaudeSession(OWNER, REF, 300, ADDRESS);
    expect(failureOf(await asked(slow), slow)).toBe("timed_out");

    const other = new ClaudeSession(OWNER, REF, 5_000, ADDRESS);
    expect(() => failureOf(new TypeError("a bug"), other)).toThrow(TypeError);
    for (const session of [busy, down, slow, other]) session.close();
  });
});

// Addresses the engine's receiver rule (payouts.py EMAIL_SHAPE, at most MAX_RECEIVER_CHARS
// characters) accepts, most of which a pattern of letters, digits and ._%+- misses.
const ENGINE_ADDRESSES = [
  "maya@shop.example",
  "a!@c.d",
  '"quoted"@shop.example',
  "o'brien@shop.example",
  "!#$%&'*+-/=?^_`{|}~@shop.example",
  "user@[192.0.2.1]",
  "x@a_b.example",
  "x@b.c",
  "x@-.-",
  "x@b..c",
  "x@b.c.",
  "UPPER@CASE.EXAMPLE",
  "a(b)@c.d",
  "a,b;c:d@e.f",
  "a<b>@c.d",
  "a\\b@c.d",
  "a]b[@c.d",
  `${"l".repeat(60)}@${"d".repeat(62)}.com`,
];

/** The engine's own verdict on each address: its normaliser, then EMAIL_SHAPE and MAX_RECEIVER_CHARS. */
function engineAccepts(addresses: readonly string[]): boolean[] {
  const code = [
    "import json, sys",
    "from mend_engine.paypal.payouts import EMAIL_SHAPE, MAX_RECEIVER_CHARS, normalise_email",
    "values = [normalise_email(address) for address in json.load(sys.stdin)]",
    "print(json.dumps([len(value) <= MAX_RECEIVER_CHARS and EMAIL_SHAPE.fullmatch(value) is not None for value in values]))",
  ].join("\n");
  const run = spawnSync(PYTHON, ["-c", code], { cwd: ENGINE_DIR, input: JSON.stringify(addresses), encoding: "utf8", windowsHide: true });
  if (run.status !== 0) throw new Error(`the engine's receiver rule could not be run: ${run.stderr}`);
  return JSON.parse(run.stdout) as boolean[];
}

describe("helpers", () => {
  it("say plainly when no key is set and refuse to build a client", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(hasClaudeKey()).toBe(false);
    const session = new ClaudeSession(DEMO, REF, 5_000, ADDRESS);
    expect(() => claudeClient(session, "goal")).toThrow(ClaudeKeyMissing);
    session.close();
  });

  it("strip markdown images, HTML and emails from model text, and redact emails from typed text", () => {
    const reply = plainText('Hi ![x](https://evil.example/?d=1) <img src=x onerror=alert(1)> <b>bold</b> mail a@b.example\u0007 ok', 200);
    expect(reply).toBe("Hi   bold mail [email removed] ok");
    expect(withoutEmails("send to evil@example.com now")).toBe("send to [email removed] now");
    expect(outboundProblem('{"text":"no address here"}')).toBeNull();
    expect(outboundProblem('{"text":"meet @ noon at the shop."}')).toBeNull();
  });

  it("flag every address the engine's receiver rule accepts, as the engine itself judges them, wherever one sits", () => {
    expect(engineAccepts(ENGINE_ADDRESSES)).toEqual(ENGINE_ADDRESSES.map(() => true));
    for (const address of ENGINE_ADDRESSES) {
      const body = JSON.stringify({ model: MODEL, messages: [{ role: "user", content: `please write to ${address} today` }] });
      expect(outboundProblem(body), address).toBe("email");
      expect(withoutEmails(`write to ${address} today`), address).toBe("write to [email removed] today");
      expect(plainText(`write to ${address} today`, 400), address).not.toContain("@");
    }
  });

  it("strip Unicode format characters and every control but newline and tab before removing emails, so a hidden mark cannot keep an address", () => {
    expect(plainText("mail boss​@shop.example now", 200)).toBe("mail [email removed] now");
    expect(plainText("a​b⁠c‮d﻿e­f", 200)).toBe("abcdef");
    expect(plainText("tab\tline\nC1\u0085end", 200)).toBe("tab\tline\nC1end");
    expect(withoutEmails("mail boss⁠@shop.example now")).toBe("mail [email removed] now");
  });

  it("refuse and scrub a secret's value from 6 characters up, the one minimum both checks share", () => {
    expect(MIN_SECRET_CHARS).toBe(6);
    vi.stubEnv("RENDER_API_KEY", "k7Qz9w");
    expect(outboundProblem('{"text":"use k7Qz9w"}')).toBe("secret");
    expect(scrubbed("use k7Qz9w")).toBe("use [removed]");
    vi.stubEnv("RENDER_API_KEY", "k7Qz9");
    expect(outboundProblem('{"text":"use k7Qz9"}')).toBeNull();
    expect(scrubbed("use k7Qz9")).toBe("use k7Qz9");
  });

  it("refuse, scrub and keep out of the audit log the value of every setting whose name says it is secret, not only the listed ones", async () => {
    const named: Readonly<Record<string, string>> = {
      MEND_NEW_SERVICE_TOKEN: "tok-9f8e7d6c5b4a",
      STRIPE_SECRET: "sec-1a2b3c4d5e",
      MAPS_API_KEY: "key-5e6f7a8b9c",
      MEND_APP_DB_PASSWORD: "pw-0d1e2f3a4b",
      lower_case_password: "pw-lower-77aa",
    };
    for (const [name, value] of Object.entries(named)) {
      vi.stubEnv(name, value);
      expect(outboundProblem(JSON.stringify({ text: `use ${value}` })), name).toBe("secret");
      expect(scrubbed(`use ${value} now`), name).toBe("use [removed] now");
      expect(secretValues(), name).toContain(value);
    }
    vi.stubEnv("MEND_BALANCE_FLOOR_MINOR", "25000123");
    expect(outboundProblem('{"text":"floor 25000123"}')).toBeNull();
    expect(scrubbed("floor 25000123")).toBe("floor 25000123");
    // A value that holds another, such as a URL holding a password, is removed whole.
    vi.stubEnv("DATABASE_URL", "postgresql://mend_app:pw-0d1e2f3a4b@db.internal/mend");
    expect(scrubbed("url postgresql://mend_app:pw-0d1e2f3a4b@db.internal/mend")).toBe("url [removed]");

    await appendAudit("secret_probe", { value: "tok-9f8e7d6c5b4a" });
    expect(logged.join("")).toContain('"outcome":"not_written","action":"secret_probe","reason":"refused","problem":"secret"');
  });
});
