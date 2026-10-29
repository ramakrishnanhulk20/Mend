// Covers the M7b console routes as handlers: CSRF on every POST, the permission table
// on every route (demo refused on the admin jobs), input checks, the 409 on approval
// conflicts, the public summary's cache, runs answering only the session that started
// them, pulling back unclaimed rewards with the payout states in results, sign-in,
// demo sessions and sign-out on the audit record in the same transaction as the session
// write, each client address's share of demo sessions, demo approvals, demo submits and
// simulates, the owner's simulates drawing on no pool demo visitors share, approve and
// simulate checking their input before any shared pool and giving its hit back on
// not_found, a session's campaign views (60 an hour, 2 at a time), and the auditors'
// junk-approval repro. Sessions live in a throwaway Postgres schema; the engine is a
// fake dev bridge on 127.0.0.1.
// Does NOT cover: the real engine or PayPal (npm run prove:m7b drives the M7b routes
// against both; which campaigns a cancel may touch is the engine's own tests), Next.js
// routing itself, or Render's run API.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_DIR, SCHEMA_PATH, type DevDatabase } from "../../../scripts/dev-database";
import { csrfTokenFor, csrfTokenForSession } from "../../server/csrf";
import { closeDatabase } from "../../server/db";
import { addressTag, sessionTag } from "../../server/ratelimit";
import { createSession, sessionIdFor, type IssuedSession } from "../../server/sessions";

// Route modules import through the "@/" alias, which this vitest config does not map.
vi.mock("@/server/audit", async () => await import("../../server/audit"));
vi.mock("@/server/auth", async () => await import("../../server/auth"));
vi.mock("@/server/csrf", async () => await import("../../server/csrf"));
vi.mock("@/server/engine", async () => await import("../../server/engine"));
vi.mock("@/server/log", async () => await import("../../server/log"));
vi.mock("@/server/permissions", async () => await import("../../server/permissions"));
vi.mock("@/server/ratelimit", async () => await import("../../server/ratelimit"));
vi.mock("@/server/runs", async () => await import("../../server/runs"));

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

const BASE = "http://127.0.0.1:3000";
const TOKEN = "bridge-token-for-route-tests-0123456789";
const OWNER_PASSWORD = "owner-password-for-route-tests-42";
const CAMPAIGN = "0b6c2f8e-6a4e-4c1b-9d2a-7e5f1a3b9c4d";
const ENGINE_REF = "6f1c1d3e-2b9a-4f0e-9a51-3c1d2e4f5a6b";
const HASH = "e".repeat(64);
const ARM = { members: 10, real_returns: 0, real_rate: 0, simulated_returns: 1 };
const PAYOUTS = {
  items: 3,
  by_status: { SUCCESS: 1, UNCLAIMED: 1, RETURNED: 1 },
  claimed_minor: 10,
  unclaimed_minor: 10,
  returned_minor: 10,
  failed_minor: 0,
  pending_minor: 0,
  unclaimed_return_by: "2026-11-23T05:00:00+00:00",
};
const ANSWERS: Record<string, unknown> = {
  view_campaign: {
    ok: true,
    campaign_id: CAMPAIGN,
    status: "draft",
    goal_text: "Win back quiet regulars",
    as_of: "2026-10-16",
    budget_minor: 1000,
    per_recipient_minor: 100,
    holdout_share: "0.2",
    total_minor: 900,
    rows: [
      { ref: "R1", role: "holdout", rank: 1, amount_minor: null, note: null, stand_in: false },
      { ref: "R2", role: "reward", rank: 2, amount_minor: 100, note: "Thank you for shopping with us.", stand_in: true },
    ],
    review_hash: HASH,
    review_problem: null,
  },
  approve_campaign: { ok: true, campaign_id: CAMPAIGN, snapshot_hash: HASH, approved_at: "2026-10-24T05:00:00.123456+00:00" },
  submit_campaign: { ok: true, campaign_id: CAMPAIGN, status: "submitted", sent: true, payout_batch_id: "BATCH1" },
  simulate_return: { ok: true, campaign_id: CAMPAIGN, ref: "R2", paypal_order_id: "5O190127TN364715T", paypal_status: "COMPLETED" },
  results: {
    ok: true,
    campaign_id: CAMPAIGN,
    status: "submitted",
    rewarded: ARM,
    holdout: ARM,
    spend_minor: 10,
    fees_minor: 25,
    window_starts_at: "2026-10-24T05:00:00+00:00",
    window_ends_at: "2026-11-23T05:00:00+00:00",
    window_open: true,
    p_value: 0.5,
    verdict: "too early to tell",
    payouts: PAYOUTS,
    rows: [
      { ref: "R1", role: "holdout", rank: 1, stand_in: false, payout_status: null, simulated_return: false, real_return: false },
      { ref: "R2", role: "reward", rank: 2, stand_in: true, payout_status: "UNCLAIMED", simulated_return: true, real_return: false },
    ],
  },
  cancel_unclaimed: {
    ok: true,
    campaign_id: CAMPAIGN,
    cancelled: 2,
    returned_minor: 20,
    still_unclaimed: 0,
    not_cancellable: 1,
    incomplete: false,
    paypal_status: null,
    paypal_name: null,
  },
  shop_summary: {
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
  },
  quiet_regulars: {
    ok: true,
    as_of: "2026-10-16",
    total: 1357,
    rows: [{ position: 1, display_name: "Priya X.", purchase_days: 7, days_silent: 95, score: 0.08, paid_net_minor: 4821, member: true, stand_in: false }],
  },
  process_events: { ok: true, ran: true, outcomes: { "status recorded": 2 }, retrying: 0 },
  reconcile: { ok: true, ran: true, looked_at: 0, sent: 0, waiting: 0 },
  purge: { ok: true, deleted: 0 },
};

type Seen = { readonly task: string; readonly args: unknown[] };
const bridge = {
  delayMs: 0,
  overrides: {} as Record<string, unknown>,
  // An answer chosen from the call itself, ahead of overrides; undefined falls through.
  answerFor: null as ((task: string, args: unknown[]) => unknown) | null,
  seen: [] as Seen[],
};
let server: Server;
let dev: DevDatabase;
let admin: pg.Client;
const schema = `web_routes_${process.pid}_${Date.now()}`;

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
    });
    request.on("end", () => {
      const task = (request.url ?? "").replace("/tasks/", "");
      const args = (JSON.parse(text) as { args: unknown[] }).args;
      bridge.seen.push({ task, args });
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(bridge.answerFor?.(task, args) ?? bridge.overrides[task] ?? ANSWERS[task]));
      }, bridge.delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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
  vi.stubEnv("MEND_DEV", "1");
  vi.stubEnv("MEND_BASE_URL", BASE);
  vi.stubEnv("MEND_CSRF_SECRET", "csrf-secret-for-route-tests-0123456789");
  vi.stubEnv("MEND_BRIDGE_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  vi.stubEnv("MEND_BRIDGE_TOKEN", TOKEN);
  vi.stubEnv("MEND_OWNER_PASSWORD", OWNER_PASSWORD);
});

afterAll(async () => {
  await closeDatabase();
  if (admin) {
    await admin.query(`drop schema if exists ${admin.escapeIdentifier(schema)} cascade`);
    await admin.end();
  }
  await dev?.release();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

beforeEach(() => {
  bridge.delayMs = 0;
  bridge.overrides = {};
  bridge.answerFor = null;
  bridge.seen = [];
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
  return () => vi.restoreAllMocks();
});

type Options = {
  session?: Pick<IssuedSession, "token" | "sessionId"> | null;
  csrf?: string | null;
  origin?: string | null;
  body?: unknown;
  prefer?: string;
  address?: string;
};

function request(method: "GET" | "POST", url: string, options: Options = {}): Request {
  const headers: Record<string, string> = {};
  if (options.session) headers.cookie = `mend_session=${options.session.token}`;
  if (method === "POST") {
    const origin = options.origin === undefined ? BASE : options.origin;
    if (origin !== null) headers.origin = origin;
    const csrf = options.csrf === undefined ? (options.session ? csrfTokenForSession(options.session.sessionId) : null) : options.csrf;
    if (csrf !== null) headers["x-mend-csrf"] = csrf;
  }
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.prefer !== undefined) headers.prefer = options.prefer;
  if (options.address !== undefined) headers["x-forwarded-for"] = options.address;
  return new Request(`${BASE}${url}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}

// A browser not yet signed in: its anonymous id cookie and the CSRF token bound to it.
function anonymous(url: string, address: string, body?: unknown): Request {
  const id = `a1.${randomBytes(32).toString("base64url")}`;
  const headers: Record<string, string> = {
    origin: BASE,
    cookie: `mend_csrf=${id}`,
    "x-mend-csrf": csrfTokenFor({ kind: "anonymous", id: createHash("sha256").update(id).digest("hex") }),
    "x-forwarded-for": address,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${BASE}${url}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

function issuedToken(response: Response): string {
  const token = /mend_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (token === undefined) throw new Error("no session cookie was issued");
  return token;
}

async function sessionExists(token: string): Promise<boolean> {
  const { rows } = await admin.query("select 1 from sessions where session_id = $1", [sessionIdFor(token)]);
  return rows.length === 1;
}

async function sessionCount(): Promise<number> {
  const { rows } = await admin.query<{ n: number }>("select count(*)::int as n from sessions");
  return rows[0].n;
}

async function lastAuditId(): Promise<number> {
  const { rows } = await admin.query<{ id: number }>("select coalesce(max(id), 0)::int as id from audit_log");
  return rows[0].id;
}

async function auditSince(id: number): Promise<{ actor: string; action: string; detail: unknown }[]> {
  const { rows } = await admin.query("select actor, action, detail from audit_log where id > $1 order by id", [id]);
  return rows;
}

async function withAuditLogMissing<T>(work: () => Promise<T>): Promise<T> {
  await admin.query("alter table audit_log rename to audit_log_away");
  try {
    return await work();
  } finally {
    await admin.query("alter table audit_log_away rename to audit_log");
  }
}

const params = <T>(value: T) => ({ params: Promise.resolve(value) });

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function postRoutes() {
  const approve = await import("./campaigns/[id]/approve/route");
  const submit = await import("./campaigns/[id]/submit/route");
  const simulate = await import("./campaigns/[id]/simulate/route");
  const events = await import("./admin/process-events/route");
  const reconcile = await import("./admin/reconcile/route");
  const purge = await import("./admin/purge/route");
  return [
    { name: "approve", call: (r: Request) => approve.POST(r, params({ id: CAMPAIGN })), body: { presentedHash: HASH } },
    { name: "submit", call: (r: Request) => submit.POST(r, params({ id: CAMPAIGN })), body: undefined },
    { name: "simulate", call: (r: Request) => simulate.POST(r, params({ id: CAMPAIGN })), body: { ref: "R2" } },
    { name: "process-events", call: (r: Request) => events.POST(r), body: undefined },
    { name: "reconcile", call: (r: Request) => reconcile.POST(r), body: undefined },
    { name: "purge", call: (r: Request) => purge.POST(r), body: undefined },
  ];
}

describe("every POST route", () => {
  it("refuses a foreign origin, no token, and a token from another session, before the engine is asked", async () => {
    const owner = await createSession("owner");
    const other = await createSession("owner");
    for (const route of await postRoutes()) {
      for (const options of [
        { origin: "https://evil.example" },
        { csrf: null },
        { csrf: csrfTokenForSession(other.sessionId) },
        { origin: null },
      ]) {
        const response = await route.call(request("POST", "/api/x", { session: owner, body: route.body, ...options }));
        expect(response.status, `${route.name} ${JSON.stringify(options)}`).toBe(403);
        expect((await json(response)).error).toBe("csrf_refused");
      }
    }
    expect(bridge.seen).toEqual([]);
  });

  it("refuses the demo role on all three admin jobs and lets the owner run them", async () => {
    const demo = await createSession("demo");
    const owner = await createSession("owner");
    const admins = (await postRoutes()).filter((route) => ["process-events", "reconcile", "purge"].includes(route.name));
    for (const route of admins) {
      const refused = await route.call(request("POST", "/api/x", { session: demo }));
      expect(refused.status, route.name).toBe(403);
      expect(await json(refused)).toEqual({ error: "not_allowed", message: "Not allowed.", ref: expect.any(String) });
    }
    expect(bridge.seen).toEqual([]);
    const answers = await Promise.all(admins.map(async (route) => json(await route.call(request("POST", "/api/x", { session: owner })))));
    expect(answers).toEqual([{ ran: true, outcomes: { "status recorded": 2 }, retrying: 0 }, { ran: true, lookedAt: 0, sent: 0, waiting: 0 }, { deleted: 0 }]);
    // The three routes run at once, so the bridge may see them in any order.
    const seen = bridge.seen.map((call) => [call.task, call.args]);
    expect(seen).toHaveLength(3);
    expect(seen).toEqual(expect.arrayContaining([
      ["process_events", []],
      ["reconcile", []],
      ["purge", []],
    ]));
  });
});

describe("approve, submit and simulate", () => {
  it("approve sends the id, the actor and the presented hash, and answers the approval", async () => {
    const { POST } = await import("./campaigns/[id]/approve/route");
    const demo = await createSession("demo");
    const response = await POST(request("POST", "/x", { session: demo, body: { presentedHash: HASH } }), params({ id: CAMPAIGN }));
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ campaignId: CAMPAIGN, snapshotHash: HASH, approvedAt: "2026-10-24T05:00:00.123456+00:00" });
    expect(bridge.seen).toEqual([{ task: "approve_campaign", args: [CAMPAIGN, { role: "demo", session: demo.sessionId }, HASH] }]);
  });

  it.each(["hash_mismatch", "recipient_not_member", "voided"])("approve answers 409 with %s", async (code) => {
    const { POST } = await import("./campaigns/[id]/approve/route");
    bridge.overrides.approve_campaign = { ok: false, error: code, ref: ENGINE_REF };
    const response = await POST(request("POST", "/x", { session: await createSession("demo"), body: { presentedHash: HASH } }), params({ id: CAMPAIGN }));
    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({ error: code, message: expect.any(String), ref: ENGINE_REF });
  });

  it.each([
    [{ presentedHash: "E".repeat(64) }, 400],
    [{ presentedHash: HASH, extra: 1 }, 400],
    [{}, 400],
  ])("approve refuses the body %j", async (body, status) => {
    const { POST } = await import("./campaigns/[id]/approve/route");
    const response = await POST(request("POST", "/x", { session: await createSession("demo"), body }), params({ id: CAMPAIGN }));
    expect(response.status).toBe(status);
    expect(bridge.seen).toEqual([]);
  });

  it("submit and simulate pass only the id, the ref and the actor", async () => {
    const submit = await import("./campaigns/[id]/submit/route");
    const simulate = await import("./campaigns/[id]/simulate/route");
    const demo = await createSession("demo");
    const actor = { role: "demo", session: demo.sessionId };
    expect(await json(await submit.POST(request("POST", "/x", { session: demo }), params({ id: CAMPAIGN })))).toEqual({
      campaignId: CAMPAIGN,
      status: "submitted",
      sent: true,
      payoutBatchId: "BATCH1",
    });
    const bought = await simulate.POST(request("POST", "/x", { session: demo, body: { ref: "R2" } }), params({ id: CAMPAIGN }));
    expect(bought.status).toBe(201);
    expect((await simulate.POST(request("POST", "/x", { session: demo, body: { ref: "C1042" } }), params({ id: CAMPAIGN }))).status).toBe(400);
    expect((await simulate.POST(request("POST", "/x", { session: demo, body: { ref: "R2" } }), params({ id: "not-a-uuid" }))).status).toBe(404);
    expect(bridge.seen).toEqual([
      { task: "submit_campaign", args: [CAMPAIGN, actor] },
      { task: "simulate_return", args: [CAMPAIGN, "R2", actor] },
    ]);
  });
});

describe("the shop routes", () => {
  it("serve the summary with no session, from one engine run for 60 seconds, with no email or UUID in it", async () => {
    const { GET } = await import("./shop/summary/route");
    const first = await GET(request("GET", "/api/shop/summary"));
    const second = await GET(request("GET", "/api/shop/summary"));
    const body = await json(first);
    expect(first.status).toBe(200);
    expect(body).toMatchObject({ asOf: "2026-10-16", shopCustomers: 5852, quietRegulars: 1357, quietRegularsPaid12mMinor: 123456, benchmark: null, backtest: null });
    expect(await json(second)).toEqual(body);
    expect(bridge.seen).toEqual([{ task: "shop_summary", args: [] }]);
    expect(JSON.stringify(body)).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("need a session for quiet regulars, refuse a limit outside 1 to 50, and pass the actor and limit", async () => {
    const { GET } = await import("./shop/quiet-regulars/route");
    expect((await GET(request("GET", "/api/shop/quiet-regulars"))).status).toBe(401);
    const demo = await createSession("demo");
    for (const query of ["?limit=51", "?limit=0", "?limit=abc", "?limit=5&limit=6", "?limit=1e1", "?limit=-1"]) {
      expect((await GET(request("GET", `/api/shop/quiet-regulars${query}`, { session: demo }))).status, query).toBe(400);
    }
    expect(bridge.seen).toEqual([]);
    const response = await GET(request("GET", "/api/shop/quiet-regulars?limit=10", { session: demo }));
    expect(await json(response)).toEqual({
      asOf: "2026-10-16",
      total: 1357,
      rows: [{ position: 1, displayName: "Priya X.", purchaseDays: 7, daysSilent: 95, score: 0.08, paidNetMinor: 4821, member: true, standIn: false }],
    });
    await GET(request("GET", "/api/shop/quiet-regulars", { session: demo }));
    expect(bridge.seen.map((call) => call.args)).toEqual([
      [{ role: "demo", session: demo.sessionId }, 10],
      [{ role: "demo", session: demo.sessionId }, 50],
    ]);
  });

  it("refuse a quiet-regulars answer carrying an email, with a generic 500", async () => {
    const { GET } = await import("./shop/quiet-regulars/route");
    bridge.overrides.quiet_regulars = {
      ...(ANSWERS.quiet_regulars as object),
      rows: [{ position: 1, display_name: "maya@shop.example", purchase_days: 7, days_silent: 95, score: 0.08, paid_net_minor: 4821, member: true, stand_in: false }],
    };
    const response = await GET(request("GET", "/api/shop/quiet-regulars", { session: await createSession("demo") }));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("maya");
  });
});

describe("runs", () => {
  it("answer only the session that started them, with the original route's shape, and 404 for everyone else", async () => {
    const results = await import("./campaigns/[id]/results/route");
    const runs = await import("./runs/[runId]/route");
    const mine = await createSession("demo");
    const theirs = await createSession("demo");
    const owner = await createSession("owner");
    bridge.delayMs = 300;

    const started = await results.GET(request("GET", "/x", { session: mine, prefer: "respond-async" }), params({ id: CAMPAIGN }));
    expect(started.status).toBe(202);
    const { status, runId } = (await json(started)) as { status: string; runId: string };
    expect(status).toBe("running");
    expect((await runs.GET(request("GET", "/x", { session: mine }), params({ runId }))).status).toBe(202);

    const refusals = await Promise.all([
      runs.GET(request("GET", "/x", { session: theirs }), params({ runId })),
      runs.GET(request("GET", "/x", { session: owner }), params({ runId })),
      runs.GET(request("GET", "/x", { session: mine }), params({ runId: "brn-00000000-0000-4000-8000-000000000000" })),
      runs.GET(request("GET", "/x", { session: mine }), params({ runId: "../../etc" })),
    ]);
    for (const refusal of refusals) {
      expect(refusal.status).toBe(404);
      expect(Object.keys(await json(refusal)).sort()).toEqual(["error", "message", "ref"]);
    }
    expect((await runs.GET(request("GET", "/x"), params({ runId }))).status).toBe(401);

    await new Promise((resolve) => setTimeout(resolve, 600));
    const polled = await runs.GET(request("GET", "/x", { session: mine }), params({ runId }));
    bridge.delayMs = 0;
    const direct = await results.GET(request("GET", "/x", { session: mine }), params({ id: CAMPAIGN }));
    expect(polled.status).toBe(200);
    expect(await json(polled)).toEqual(await json(direct));
    const { rows } = await admin.query("select task, session_id_hash from run_owners where run_id = $1", [runId]);
    expect(rows).toEqual([{ task: "results", session_id_hash: mine.sessionId }]);
  });
});

describe("pulling back unclaimed rewards, and the payout states in results", () => {
  const CANCELLED = { campaignId: CAMPAIGN, cancelled: 2, returnedMinor: 20, stillUnclaimed: 0, notCancellable: 1, incomplete: false, paypalStatus: null, paypalName: null };

  it("lets the owner pull back unclaimed rewards, sending only the id and the actor", async () => {
    const { POST } = await import("./campaigns/[id]/cancel-unclaimed/route");
    const owner = await createSession("owner");
    const response = await POST(request("POST", "/x", { session: owner }), params({ id: CAMPAIGN }));
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual(CANCELLED);
    expect(bridge.seen).toEqual([{ task: "cancel_unclaimed", args: [CAMPAIGN, { role: "owner", session: owner.sessionId }] }]);
  });

  it("lets a demo visitor pull back its own campaign's unclaimed rewards", async () => {
    const { POST } = await import("./campaigns/[id]/cancel-unclaimed/route");
    const demo = await createSession("demo");
    const response = await POST(request("POST", "/x", { session: demo }), params({ id: CAMPAIGN }));
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual(CANCELLED);
    expect(bridge.seen).toEqual([{ task: "cancel_unclaimed", args: [CAMPAIGN, { role: "demo", session: demo.sessionId }] }]);
  });

  it("refuses a demo visitor another session's campaign with the same 404 submit gives", async () => {
    const submit = await import("./campaigns/[id]/submit/route");
    const cancel = await import("./campaigns/[id]/cancel-unclaimed/route");
    bridge.overrides.submit_campaign = { ok: false, error: "not_found", ref: ENGINE_REF };
    bridge.overrides.cancel_unclaimed = { ok: false, error: "not_found", ref: ENGINE_REF };
    const demo = await createSession("demo");
    const viaSubmit = await submit.POST(request("POST", "/x", { session: demo }), params({ id: CAMPAIGN }));
    const viaCancel = await cancel.POST(request("POST", "/x", { session: demo }), params({ id: CAMPAIGN }));
    expect([viaSubmit.status, viaCancel.status]).toEqual([404, 404]);
    expect(await json(viaCancel)).toEqual(await json(viaSubmit));
    expect(bridge.seen.at(-1)).toEqual({ task: "cancel_unclaimed", args: [CAMPAIGN, { role: "demo", session: demo.sessionId }] });
  });

  it("refuses a missing CSRF token, a foreign origin and another session's token before the engine is asked", async () => {
    const { POST } = await import("./campaigns/[id]/cancel-unclaimed/route");
    const owner = await createSession("owner");
    const other = await createSession("owner");
    for (const options of [{ csrf: null }, { origin: "https://evil.example" }, { origin: null }, { csrf: csrfTokenForSession(other.sessionId) }]) {
      const response = await POST(request("POST", "/x", { session: owner, ...options }), params({ id: CAMPAIGN }));
      expect(response.status, JSON.stringify(options)).toBe(403);
      expect((await json(response)).error).toBe("csrf_refused");
    }
    expect(bridge.seen).toEqual([]);
  });

  it("answers 409 not_submitted for a campaign never sent, and a polled run answers the same", async () => {
    const cancel = await import("./campaigns/[id]/cancel-unclaimed/route");
    const runs = await import("./runs/[runId]/route");
    bridge.overrides.cancel_unclaimed = { ok: false, error: "not_submitted", ref: ENGINE_REF };
    const demo = await createSession("demo");
    const direct = await cancel.POST(request("POST", "/x", { session: demo }), params({ id: CAMPAIGN }));
    expect(direct.status).toBe(409);
    expect(await json(direct)).toEqual({ error: "not_submitted", message: expect.any(String), ref: ENGINE_REF });

    const started = await cancel.POST(request("POST", "/x", { session: demo, prefer: "respond-async" }), params({ id: CAMPAIGN }));
    expect(started.status).toBe(202);
    const { runId } = (await json(started)) as { runId: string };
    let polled = await runs.GET(request("GET", "/x", { session: demo }), params({ runId }));
    for (let n = 0; n < 20 && polled.status === 202; n += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      polled = await runs.GET(request("GET", "/x", { session: demo }), params({ runId }));
    }
    expect(polled.status).toBe(409);
    expect(await json(polled)).toEqual({ error: "not_submitted", message: expect.any(String), ref: ENGINE_REF });
  });

  it("answers 200 with what came back, what is still out and PayPal's error code when PayPal fails one reward, not 503", async () => {
    const { POST } = await import("./campaigns/[id]/cancel-unclaimed/route");
    bridge.overrides.cancel_unclaimed = {
      ...(ANSWERS.cancel_unclaimed as object),
      cancelled: 3,
      returned_minor: 600,
      still_unclaimed: 1,
      not_cancellable: 0,
      incomplete: true,
      paypal_status: 500,
      paypal_name: "INTERNAL_SERVICE_ERROR",
    };
    const response = await POST(request("POST", "/x", { session: await createSession("demo") }), params({ id: CAMPAIGN }));
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      campaignId: CAMPAIGN,
      cancelled: 3,
      returnedMinor: 600,
      stillUnclaimed: 1,
      notCancellable: 0,
      incomplete: true,
      paypalStatus: 500,
      paypalName: "INTERNAL_SERVICE_ERROR",
    });
  });

  it("results carry the payout states, with PayPal's status names exactly as the engine sent them", async () => {
    const { GET } = await import("./campaigns/[id]/results/route");
    const response = await GET(request("GET", "/x", { session: await createSession("demo") }), params({ id: CAMPAIGN }));
    expect(response.status).toBe(200);
    expect((await json(response)).payouts).toEqual({
      items: 3,
      byStatus: { SUCCESS: 1, UNCLAIMED: 1, RETURNED: 1 },
      claimedMinor: 10,
      unclaimedMinor: 10,
      returnedMinor: 10,
      failedMinor: 0,
      pendingMinor: 0,
      unclaimedReturnBy: "2026-11-23T05:00:00+00:00",
    });
  });

  it.each([
    ["no payouts block", { payouts: undefined }],
    ["a field nobody listed", { payouts: { ...PAYOUTS, receiver: "maya@shop.example" } }],
    ["a negative amount", { payouts: { ...PAYOUTS, returned_minor: -1 } }],
    ["a fractional amount", { payouts: { ...PAYOUTS, claimed_minor: 0.5 } }],
    ["a status that is not an upper-case word", { payouts: { ...PAYOUTS, by_status: { "success<script>": 1 } } }],
    ["a return date that is not a time", { payouts: { ...PAYOUTS, unclaimed_return_by: "soon" } }],
  ])("treats a results answer with %s as an engine failure: a generic 500", async (_label, change) => {
    const { GET } = await import("./campaigns/[id]/results/route");
    bridge.overrides.results = { ...(ANSWERS.results as object), ...change };
    const response = await GET(request("GET", "/x", { session: await createSession("demo") }), params({ id: CAMPAIGN }));
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "internal", message: "Something went wrong.", ref: expect.any(String) });
    expect(text).not.toMatch(/maya|script/);
  });
});

describe("signing in and out, on the audit record", () => {
  it("records an owner sign-in, a wrong password, a demo session and a sign-out, with address and session tags and never a session id", async () => {
    const owner = await import("./session/owner/route");
    const demo = await import("./session/demo/route");
    const logout = await import("./session/logout/route");
    const before = await lastAuditId();
    const wrong = await owner.POST(anonymous("/api/session/owner", "198.51.100.20", { password: "not-the-owner-password-at-all" }));
    expect(wrong.status).toBe(401);
    const right = await owner.POST(anonymous("/api/session/owner", "198.51.100.20", { password: OWNER_PASSWORD }));
    expect(right.status).toBe(200);
    const ownerToken = issuedToken(right);
    const started = await demo.POST(anonymous("/api/session/demo", "198.51.100.21"));
    expect(started.status).toBe(200);
    const demoToken = issuedToken(started);
    const out = await logout.POST(request("POST", "/api/session/logout", { session: { token: demoToken, sessionId: sessionIdFor(demoToken) }, address: "198.51.100.21" }));
    expect(out.status).toBe(200);
    expect(await sessionExists(demoToken)).toBe(false);

    const ref = expect.stringMatching(/^[0-9a-f-]{36}$/);
    const rows = await auditSince(before);
    expect(rows).toEqual([
      { actor: "web", action: "owner_sign_in", detail: { role: "owner", outcome: "refused", reason: "wrong_password", address_tag: addressTag("198.51.100.20"), ref } },
      {
        actor: "web",
        action: "owner_sign_in",
        detail: { role: "owner", outcome: "signed_in", session_tag: sessionTag(sessionIdFor(ownerToken)), address_tag: addressTag("198.51.100.20"), ref },
      },
      { actor: "web", action: "demo_session_started", detail: { role: "demo", session_tag: sessionTag(sessionIdFor(demoToken)), address_tag: addressTag("198.51.100.21"), ref } },
      { actor: "web", action: "sign_out", detail: { role: "demo", session_tag: sessionTag(sessionIdFor(demoToken)), address_tag: addressTag("198.51.100.21"), ref } },
    ]);
    for (const secret of [sessionIdFor(ownerToken), sessionIdFor(demoToken), ownerToken, demoToken, OWNER_PASSWORD]) expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it("fails a demo session or a sign-out whose audit row cannot be written, leaving every session as it was", async () => {
    const demo = await import("./session/demo/route");
    const owner = await import("./session/owner/route");
    const logout = await import("./session/logout/route");
    const kept = await createSession("owner");
    const sessionsBefore = await sessionCount();
    const [started, signedIn, out] = await withAuditLogMissing(async () => [
      await demo.POST(anonymous("/api/session/demo", "198.51.100.22")),
      await owner.POST(anonymous("/api/session/owner", "198.51.100.22", { password: OWNER_PASSWORD })),
      await logout.POST(request("POST", "/api/session/logout", { session: kept, address: "198.51.100.22" })),
    ]);
    for (const response of [started, signedIn, out]) {
      expect(response.status).toBe(500);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(await sessionCount()).toBe(sessionsBefore);
    expect(await sessionExists(kept.token)).toBe(true);
  });
});

describe("each client address's share", () => {
  it("lets one address start 4 demo sessions an hour and 10 a day, while another address still can", async () => {
    const { POST } = await import("./session/demo/route");
    for (let n = 0; n < 4; n += 1) expect((await POST(anonymous("/api/session/demo", "198.51.100.30"))).status).toBe(200);
    const refused = await POST(anonymous("/api/session/demo", "198.51.100.30"));
    expect(refused.status).toBe(429);
    expect(await json(refused)).toMatchObject({ error: "rate_limited" });
    expect((await POST(anonymous("/api/session/demo", "198.51.100.31"))).status).toBe(200);
    await admin.query("insert into rate_limit_hits (bucket, subject, at) select 'demo_session_day', '198.51.100.32', now() - interval '3 hours' from generate_series(1, 10)");
    expect((await POST(anonymous("/api/session/demo", "198.51.100.32"))).status).toBe(429);
  });

  it("holds one address to 10 demo approvals an hour across its sessions, and leaves the owner's approvals alone", async () => {
    const { POST } = await import("./campaigns/[id]/approve/route");
    const before = await lastAuditId();
    const visits = [await createSession("demo"), await createSession("demo")];
    const approve = (session: IssuedSession, address: string) => POST(request("POST", "/x", { session, address, body: { presentedHash: HASH } }), params({ id: CAMPAIGN }));
    for (let n = 0; n < 10; n += 1) expect((await approve(visits[n % 2], "198.51.100.40")).status).toBe(200);
    expect((await approve(visits[0], "198.51.100.40")).status).toBe(429);
    expect((await approve(visits[1], "198.51.100.41")).status).toBe(200);
    expect((await approve(await createSession("owner"), "198.51.100.40")).status).toBe(200);
    expect(await auditSince(before)).toEqual([
      { actor: "web", action: "rate_limit_hit", detail: { bucket: "demo_approvals_address", per: "address", address_tag: addressTag("198.51.100.40") } },
    ]);
  });

  it("holds one address to 4 demo submits a day across its sessions, and leaves the owner's submits alone", async () => {
    const { POST } = await import("./campaigns/[id]/submit/route");
    const before = await lastAuditId();
    const visits = [await createSession("demo"), await createSession("demo")];
    const submit = (session: IssuedSession, address: string) => POST(request("POST", "/x", { session, address }), params({ id: CAMPAIGN }));
    for (let n = 0; n < 4; n += 1) expect((await submit(visits[n % 2], "198.51.100.44")).status).toBe(200);
    const refused = await submit(visits[0], "198.51.100.44");
    expect(refused.status).toBe(429);
    expect(await json(refused)).toMatchObject({ error: "rate_limited" });
    expect((await submit(visits[1], "198.51.100.45")).status).toBe(200);
    expect((await submit(await createSession("owner"), "198.51.100.44")).status).toBe(200);
    expect(bridge.seen.filter((call) => call.task === "submit_campaign")).toHaveLength(6);
    expect(await auditSince(before)).toEqual([
      { actor: "web", action: "rate_limit_hit", detail: { bucket: "demo_submits_address", per: "address", address_tag: addressTag("198.51.100.44") } },
    ]);
  });

  it("lets the owner simulate while the demo visitors' shared pool is full, and refuses a demo visitor", async () => {
    const { POST } = await import("./campaigns/[id]/simulate/route");
    await admin.query("insert into rate_limit_hits (bucket, subject) select 'simulates_all', 'all' from generate_series(1, 100)");
    try {
      const simulate = (session: IssuedSession, address: string) => POST(request("POST", "/x", { session, address, body: { ref: "R2" } }), params({ id: CAMPAIGN }));
      expect((await simulate(await createSession("owner"), "198.51.100.46")).status).toBe(201);
      const refused = await simulate(await createSession("demo"), "198.51.100.47");
      expect(refused.status).toBe(429);
      expect(await json(refused)).toMatchObject({ error: "rate_limited" });
    } finally {
      await admin.query("delete from rate_limit_hits where bucket = 'simulates_all'");
    }
  });

  it("holds one address to 10 simulates an hour across its sessions", async () => {
    const { POST } = await import("./campaigns/[id]/simulate/route");
    const before = await lastAuditId();
    const visits = [await createSession("demo"), await createSession("demo")];
    const simulate = (session: IssuedSession, address: string) => POST(request("POST", "/x", { session, address, body: { ref: "R2" } }), params({ id: CAMPAIGN }));
    for (let n = 0; n < 10; n += 1) expect((await simulate(visits[n % 2], "198.51.100.42")).status).toBe(201);
    expect((await simulate(visits[0], "198.51.100.42")).status).toBe(429);
    expect((await simulate(visits[1], "198.51.100.43")).status).toBe(201);
    expect(await auditSince(before)).toEqual([
      { actor: "web", action: "rate_limit_hit", detail: { bucket: "simulate_address", per: "address", address_tag: addressTag("198.51.100.42") } },
    ]);
  });
});

describe("the shared demo pools", () => {
  const UNKNOWN = "11111111-2222-4333-8444-555555555555";
  const POOLS = ["demo_approvals_all", "demo_approvals_address", "simulates_all", "simulate_address"];

  async function rows(bucket: string, subject?: string): Promise<number> {
    const { rows: found } = await admin.query<{ n: number }>(
      "select count(*)::int as n from rate_limit_hits where bucket = $1 and ($2::text is null or subject = $2)",
      [bucket, subject ?? null],
    );
    return found[0].n;
  }

  beforeEach(async () => {
    await admin.query("delete from rate_limit_hits where bucket = any($1)", [POOLS]);
  });

  it("are charged by approve and simulate only after the campaign id and the body check out", async () => {
    const approve = await import("./campaigns/[id]/approve/route");
    const simulate = await import("./campaigns/[id]/simulate/route");
    const demo = await createSession("demo");
    const send = (route: typeof approve, id: string, body: unknown) => route.POST(request("POST", "/x", { session: demo, address: "198.51.100.50", body }), params({ id }));
    expect((await send(approve, "not-a-uuid", { presentedHash: HASH })).status).toBe(404);
    expect((await send(approve, CAMPAIGN, { presentedHash: "x" })).status).toBe(400);
    expect((await send(simulate, "not-a-uuid", { ref: "R2" })).status).toBe(404);
    expect((await send(simulate, CAMPAIGN, { ref: "C1042" })).status).toBe(400);
    expect(await Promise.all(POOLS.map((bucket) => rows(bucket)))).toEqual([0, 0, 0, 0]);
    expect(bridge.seen).toEqual([]);
  });

  // Each engine round trip waits one 500 ms poll, so one junk approval per address reaches the engine.
  it("let an 11th address approve after 10 addresses sent 10 junk approvals each (the auditors' repro)", { timeout: 40_000 }, async () => {
    const { POST } = await import("./campaigns/[id]/approve/route");
    bridge.answerFor = (task, args) => (task === "approve_campaign" && args[0] !== CAMPAIGN ? { ok: false, error: "not_found", ref: ENGINE_REF } : undefined);
    const approve = (session: IssuedSession, address: string, id: string, body: unknown) => POST(request("POST", "/x", { session, address, body }), params({ id }));
    for (let visitor = 0; visitor < 10; visitor += 1) {
      const session = await createSession("demo");
      const address = `198.51.100.${120 + visitor}`;
      for (let n = 0; n < 10; n += 1) {
        const [id, body, status]: [string, unknown, number] =
          n < 5 ? ["not-a-uuid", { presentedHash: HASH }, 404] : n < 9 ? [CAMPAIGN, { presentedHash: "x" }, 400] : [UNKNOWN, { presentedHash: HASH }, 404];
        expect((await approve(session, address, id, body)).status, `${address} junk ${n}`).toBe(status);
      }
    }
    expect(await rows("demo_approvals_all")).toBe(0);
    const valid = await approve(await createSession("demo"), "198.51.100.130", CAMPAIGN, { presentedHash: HASH });
    expect(valid.status).toBe(200);
    expect(await rows("demo_approvals_all")).toBe(1);
  });

  it("get their hit back when the engine answers not_found, also when that answer comes after a 202", async () => {
    const approve = await import("./campaigns/[id]/approve/route");
    const simulate = await import("./campaigns/[id]/simulate/route");
    bridge.overrides.approve_campaign = { ok: false, error: "not_found", ref: ENGINE_REF };
    bridge.overrides.simulate_return = { ok: false, error: "not_found", ref: ENGINE_REF };
    const demo = await createSession("demo");
    const options = { session: demo, address: "198.51.100.51" };
    const missed = await approve.POST(request("POST", "/x", { ...options, body: { presentedHash: HASH } }), params({ id: UNKNOWN }));
    expect(missed.status).toBe(404);
    expect(await rows("demo_approvals_all", demo.sessionId)).toBe(0);

    bridge.delayMs = 300;
    const started = await approve.POST(request("POST", "/x", { ...options, prefer: "respond-async", body: { presentedHash: HASH } }), params({ id: UNKNOWN }));
    expect(started.status).toBe(202);
    expect(await rows("demo_approvals_all", demo.sessionId)).toBe(1);
    await vi.waitFor(async () => expect(await rows("demo_approvals_all", demo.sessionId)).toBe(0), { timeout: 3_000 });
    bridge.delayMs = 0;

    const bought = await simulate.POST(request("POST", "/x", { ...options, body: { ref: "R2" } }), params({ id: UNKNOWN }));
    expect(bought.status).toBe(404);
    expect(await rows("simulates_all", demo.sessionId)).toBe(0);
    // Each address's own share stays spent, so one address cannot ask the engine about unknown ids without end.
    expect([await rows("demo_approvals_address", "198.51.100.51"), await rows("simulate_address", "198.51.100.51")]).toEqual([2, 1]);
  });
});

describe("a session's campaign views", () => {
  it("are held to 60 an hour, refused before the engine is asked", async () => {
    const { GET } = await import("./campaigns/[id]/route");
    const demo = await createSession("demo");
    await admin.query("insert into rate_limit_hits (bucket, subject) select 'view_campaign', $1 from generate_series(1, 60)", [demo.sessionId]);
    const refused = await GET(request("GET", "/x", { session: demo }), params({ id: CAMPAIGN }));
    expect(refused.status).toBe(429);
    expect(await json(refused)).toMatchObject({ error: "rate_limited" });
    expect(refused.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(bridge.seen).toEqual([]);
    expect((await GET(request("GET", "/x", { session: await createSession("demo") }), params({ id: CAMPAIGN }))).status).toBe(200);
  });

  it("run 2 at a time: a third answers 429 with a fixed message at once, and the engine is not asked a third time", async () => {
    const { GET } = await import("./campaigns/[id]/route");
    const demo = await createSession("demo");
    bridge.delayMs = 500;
    const view = (session: IssuedSession) => GET(request("GET", "/x", { session }), params({ id: CAMPAIGN }));
    const running = [view(demo), view(demo)];
    await vi.waitFor(() => expect(bridge.seen).toHaveLength(2));
    const third = await view(demo);
    expect(third.status).toBe(429);
    expect(await json(third)).toEqual({ error: "too_many_running", message: "Too many requests. Try again later.", ref: expect.any(String) });
    const other = view(await createSession("demo"));
    expect((await Promise.all([...running, other])).map((response) => response.status)).toEqual([200, 200, 200]);
    expect(bridge.seen.filter((call) => call.task === "view_campaign")).toHaveLength(3);
  });
});
