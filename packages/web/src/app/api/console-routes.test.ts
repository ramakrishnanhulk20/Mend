// Covers the M7b console routes as handlers: CSRF on every POST, the permission table
// on every route (demo refused on the admin jobs), input checks, the 409 on approval
// conflicts, the public summary's cache, and runs answering only the session that
// started them. Sessions live in a throwaway Postgres schema; the engine is a fake dev
// bridge on 127.0.0.1. Does NOT cover: the real engine or PayPal (npm run prove:m7b
// drives these routes against both), Next.js routing itself, or Render's run API.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_DIR, SCHEMA_PATH, type DevDatabase } from "../../../scripts/dev-database";
import { csrfTokenForSession } from "../../server/csrf";
import { closeDatabase } from "../../server/db";
import { createSession, type IssuedSession } from "../../server/sessions";

// Route modules import through the "@/" alias, which this vitest config does not map.
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
const CAMPAIGN = "0b6c2f8e-6a4e-4c1b-9d2a-7e5f1a3b9c4d";
const ENGINE_REF = "6f1c1d3e-2b9a-4f0e-9a51-3c1d2e4f5a6b";
const HASH = "e".repeat(64);
const ARM = { members: 10, real_returns: 0, real_rate: 0, simulated_returns: 1 };
const ANSWERS: Record<string, unknown> = {
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
  },
  shop_summary: {
    ok: true,
    as_of: "2026-10-16",
    shop_customers: 5852,
    members: 41,
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
    rows: [{ position: 1, display_name: "Priya X.", purchase_days: 7, days_silent: 95, score: 0.08, paid_net_minor: 4821, member: true }],
  },
  process_events: { ok: true, ran: true, outcomes: { "status recorded": 2 }, retrying: 0 },
  reconcile: { ok: true, ran: true, looked_at: 0, sent: 0, waiting: 0 },
  purge: { ok: true, deleted: 0 },
};

type Seen = { readonly task: string; readonly args: unknown[] };
const bridge = { delayMs: 0, overrides: {} as Record<string, unknown>, seen: [] as Seen[] };
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
      bridge.seen.push({ task, args: (JSON.parse(text) as { args: unknown[] }).args });
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(bridge.overrides[task] ?? ANSWERS[task]));
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
  bridge.seen = [];
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
  return () => vi.restoreAllMocks();
});

type Options = { session?: IssuedSession | null; csrf?: string | null; origin?: string | null; body?: unknown; prefer?: string };

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
  return new Request(`${BASE}${url}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
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
      rows: [{ position: 1, displayName: "Priya X.", purchaseDays: 7, daysSilent: 95, score: 0.08, paidNetMinor: 4821, member: true }],
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
      rows: [{ position: 1, display_name: "maya@shop.example", purchase_days: 7, days_silent: 95, score: 0.08, paid_net_minor: 4821, member: true }],
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
