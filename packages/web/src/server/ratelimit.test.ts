// Covers which address a request is counted against, its short tag, the counting itself
// against a real Postgres schema, including concurrent requests, each shared demo pool's
// last part kept for sessions that have not drawn, a hit given back, each bucket swept
// at its own window, the one audit row each window's first refusal leaves and the cap of
// 20 such rows per bucket a minute, and, from the real constants, how long 50 addresses
// can hold a shared pool closed. Does NOT cover: Render's proxy really appending the
// client address (unverified until deployed; the tag in the webhook log line is how to
// check it), the limits wired into each route (console-routes.test.ts, npm run
// prove:m7a), or attackers who keep a pool closed by drawing again every window.
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_DIR, SCHEMA_PATH, type DevDatabase } from "../../scripts/dev-database";
import { auditRows, JOIN_LIMITS, WEBHOOK_LIMITS } from "./address-limits";
import { closeDatabase } from "./db";
import {
  addressTag,
  clientAddress,
  GLOBAL,
  LIMITS,
  recordLimitHit,
  returnHit,
  sessionTag,
  takeHit,
  UNKNOWN_ADDRESS,
  writeSuppressedAudit,
  type Limit,
} from "./ratelimit";
import { SESSION_ABSOLUTE_MS } from "./sessions";
import { CERTIFICATE_LIMITS } from "./webhook-signature";

// dev_url applies the schema to the shared public schema, and two of those running at
// once can deadlock (schema.sql takes its lock after its first table locks), so this
// file only keeps the database server running and applies the schema to its own
// throwaway schema below.
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

const SECRET = "csrf-secret-for-ratelimit-tests-0123456789";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
let dev: DevDatabase;
let admin: pg.Client;
const schema = `web_ratelimit_${process.pid}_${Date.now()}`;

function forwarded(value: string | null): Headers {
  return new Headers(value === null ? {} : { "x-forwarded-for": value });
}

async function hits(bucket: string, subject: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>("select count(*)::int as n from rate_limit_hits where bucket = $1 and subject = $2", [bucket, subject]);
  return rows[0].n;
}

async function poolHits(bucket: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>("select count(*)::int as n from rate_limit_hits where bucket = $1", [bucket]);
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

async function refusedAfterFilling(limit: Limit, subject: string): Promise<boolean> {
  for (let n = 0; n < limit.max; n += 1) await takeHit(limit, subject);
  return !(await takeHit(limit, subject)).allowed;
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
  vi.stubEnv("MEND_CSRF_SECRET", SECRET);
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

beforeEach(async () => {
  await admin.query("delete from rate_limit_hits");
  auditRows.clear();
});

describe("clientAddress", () => {
  it.each([
    ["198.51.100.7", "198.51.100.7"],
    ["203.0.113.50, 198.51.100.7", "198.51.100.7"],
    ["203.0.113.50,198.51.100.7 ", "198.51.100.7"],
    ["::ffff:127.0.0.1", "127.0.0.1"],
    ["::FFFF:198.51.100.7", "198.51.100.7"],
    ["2001:db8:abcd:12::1", "2001:db8:abcd:12::/64"],
    ["[2001:db8:abcd:12:ffff:1:2:3]", "2001:db8:abcd:12::/64"],
    ["::1", "0:0:0:0::/64"],
  ])("counts %j as %s", (header, expected) => {
    expect(clientAddress(forwarded(header))).toBe(expected);
  });

  it.each([null, "", "not-an-ip", "198.51.100.7, garbage", "198.51.100.300", "fe80::1%eth0"])("counts %j as the shared unknown address", (header) => {
    expect(clientAddress(forwarded(header))).toBe(UNKNOWN_ADDRESS);
  });

  it("puts every address in one IPv6 /64 in the same count", () => {
    expect(clientAddress(forwarded("2001:db8:1:2::aaaa"))).toBe(clientAddress(forwarded("2001:db8:1:2:ffff:ffff:ffff:ffff")));
    expect(clientAddress(forwarded("2001:db8:1:2::1"))).not.toBe(clientAddress(forwarded("2001:db8:1:3::1")));
  });
});

describe("addressTag", () => {
  it("is the first 12 hex characters of HMAC-SHA256(MEND_CSRF_SECRET, address), one per address", () => {
    expect(addressTag("198.51.100.7")).toBe(createHmac("sha256", SECRET).update("198.51.100.7").digest("hex").slice(0, 12));
    expect(addressTag("198.51.100.7")).toMatch(/^[0-9a-f]{12}$/);
    expect(addressTag("198.51.100.8")).not.toBe(addressTag("198.51.100.7"));
    expect(sessionTag("d".repeat(64))).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("takeHit", () => {
  it("lets ten sign-ins through in 15 minutes and refuses the eleventh with a wait", async () => {
    const results = [];
    for (let n = 0; n < 11; n += 1) results.push(await takeHit(LIMITS.signIn, "198.51.100.7"));
    expect(results.slice(0, 10).every((result) => result.allowed)).toBe(true);
    const last = results[10];
    expect(last.allowed).toBe(false);
    expect(!last.allowed && last.retryAfterSeconds > 0 && last.retryAfterSeconds <= 900).toBe(true);
    expect(await hits("sign_in", "198.51.100.7")).toBe(10);
  });

  it("counts each subject and each bucket apart", async () => {
    for (let n = 0; n < 10; n += 1) await takeHit(LIMITS.signIn, "198.51.100.7");
    expect((await takeHit(LIMITS.signIn, "198.51.100.8")).allowed).toBe(true);
    expect((await takeHit(LIMITS.demoSession, "198.51.100.7")).allowed).toBe(true);
  });

  it("forgets requests older than the window", async () => {
    for (let n = 0; n < 10; n += 1) await takeHit(LIMITS.signIn, "198.51.100.7");
    await admin.query("update rate_limit_hits set at = at - interval '15 minutes 1 second'");
    expect((await takeHit(LIMITS.signIn, "198.51.100.7")).allowed).toBe(true);
  });

  it("cannot be raced: 25 requests at once let exactly the limit through", async () => {
    const limit: Limit = { bucket: "race", max: 10, windowMs: 60_000, per: "address" };
    const results = await Promise.all(Array.from({ length: 25 }, () => takeHit(limit, "198.51.100.9")));
    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    expect(await hits("race", "198.51.100.9")).toBe(10);
  });

  it("gives every limit its own bucket, so no two limits share a count by accident", () => {
    const buckets = Object.values(LIMITS).map((limit) => limit.bucket);
    expect(new Set(buckets).size).toBe(buckets.length);
    expect(Object.values(LIMITS).every((limit) => limit.max >= 1 && limit.windowMs <= 24 * 60 * 60 * 1000)).toBe(true);
  });

  it("refuses the 41st demo Claude call of a rolling day, counting calls from hours ago", async () => {
    await admin.query(
      "insert into rate_limit_hits (bucket, subject, at) select 'claude_demo_session', 'one-session', now() - interval '20 hours' from generate_series(1, 39)",
    );
    expect((await takeHit(LIMITS.claudeDemoSession, "one-session")).allowed).toBe(true);
    expect((await takeHit(LIMITS.claudeDemoSession, "one-session")).allowed).toBe(false);
    expect((await takeHit(LIMITS.claudeDemoSession, "another-session")).allowed).toBe(true);
    expect(await hits("claude_demo_session", "one-session")).toBe(40);
  });

  it("counts a global limit across every session: the 101st demo approval in an hour is refused for anyone", async () => {
    for (let n = 0; n < 100; n += 1) expect((await takeHit(LIMITS.demoApprovals, GLOBAL, { session: `visitor-${n}` })).allowed).toBe(true);
    expect((await takeHit(LIMITS.demoApprovals, GLOBAL, { session: "visitor-new" })).allowed).toBe(false);
    expect((await takeHit(LIMITS.approve, "a-session")).allowed).toBe(true);
    expect(await poolHits("demo_approvals_all")).toBe(100);
  });

  it("keeps a shared demo pool's last part for sessions that have not drawn on it in the window", async () => {
    const pool = LIMITS.demoApprovals;
    const open = pool.max - pool.keptForNewSessions;
    await admin.query("insert into rate_limit_hits (bucket, subject) select $1, 'drawn-' || (n % 8) from generate_series(1, $2) as n", [pool.bucket, open - 2]);
    // Below the line a session may draw again.
    for (let n = 0; n < 2; n += 1) expect((await takeHit(pool, GLOBAL, { session: "drawn-1" })).allowed).toBe(true);
    expect((await takeHit(pool, GLOBAL, { session: "drawn-1" })).allowed).toBe(false);
    // A caller that names no session cannot show it has not drawn, so it gets none of the reserve.
    expect((await takeHit(pool, GLOBAL)).allowed).toBe(false);
    expect((await takeHit(pool, GLOBAL, { session: "fresh-0" })).allowed).toBe(true);
    expect((await takeHit(pool, GLOBAL, { session: "fresh-0" })).allowed).toBe(false);
    for (let n = 1; n < pool.keptForNewSessions; n += 1) expect((await takeHit(pool, GLOBAL, { session: `fresh-${n}` })).allowed).toBe(true);
    const full = await takeHit(pool, GLOBAL, { session: "fresh-last" });
    expect(!full.allowed && full.retryAfterSeconds > 0 && full.retryAfterSeconds <= 3600).toBe(true);
    expect(await poolHits(pool.bucket)).toBe(pool.max);
    // One window on, every draw has aged out and a session that drew before may draw again.
    await admin.query("update rate_limit_hits set at = at - make_interval(secs => $1)", [pool.windowMs / 1000 + 1]);
    expect((await takeHit(pool, GLOBAL, { session: "drawn-1" })).allowed).toBe(true);
  });

  it("lets a fresh session finish a 10 call dashboard question with the pool at its keep line, and no more", async () => {
    const pool = LIMITS.claudeStudioAll;
    const line = pool.max - pool.keptForNewSessions;
    await admin.query("insert into rate_limit_hits (bucket, subject) select $1, 'drawn-' || (n % 8) from generate_series(1, $2) as n", [pool.bucket, line]);
    expect((await takeHit(pool, GLOBAL, { session: "drawn-1" })).allowed).toBe(false);
    expect((await takeHit(pool, GLOBAL)).allowed).toBe(false);
    for (let n = 0; n < 10; n += 1) expect((await takeHit(pool, GLOBAL, { session: "fresh-question" })).allowed).toBe(true);
    expect((await takeHit(pool, GLOBAL, { session: "fresh-question" })).allowed).toBe(false);
    for (let n = 0; n < 10; n += 1) expect((await takeHit(pool, GLOBAL, { session: "fresh-second" })).allowed).toBe(true);
    expect((await takeHit(pool, GLOBAL, { session: "fresh-third" })).allowed).toBe(false);
    expect(await poolHits(pool.bucket)).toBe(pool.max);
  });

  it("gives a hit back: the pool draw a session made leaves the count, as if it was never taken", async () => {
    const pool = LIMITS.simulates;
    expect((await takeHit(pool, GLOBAL, { session: "s-1" })).allowed).toBe(true);
    expect((await takeHit(pool, GLOBAL, { session: "s-2" })).allowed).toBe(true);
    await returnHit(pool, GLOBAL, { session: "s-1" });
    expect([await hits(pool.bucket, "s-1"), await hits(pool.bucket, "s-2")]).toEqual([0, 1]);
    await returnHit(pool, GLOBAL, { session: "s-1" });
    expect(await poolHits(pool.bucket)).toBe(1);
    expect((await takeHit(LIMITS.draft, "a-session")).allowed).toBe(true);
    await returnHit(LIMITS.draft, "a-session");
    expect(await hits("draft", "a-session")).toBe(0);
  });

  it("lets a session pull back unclaimed rewards 10 times an hour, counted apart from its submits", async () => {
    for (let n = 0; n < 10; n += 1) expect((await takeHit(LIMITS.cancelUnclaimed, "a-session")).allowed).toBe(true);
    const refused = await takeHit(LIMITS.cancelUnclaimed, "a-session");
    expect(!refused.allowed && refused.retryAfterSeconds <= 3600).toBe(true);
    expect((await takeHit(LIMITS.submit, "a-session")).allowed).toBe(true);
    expect((await takeHit(LIMITS.cancelUnclaimed, "another-session")).allowed).toBe(true);
  });

  it("gives each client address its own share of the demo: 4 demo sessions an hour and 10 a day, 80 demo Claude calls and 60 dashboard calls a day, 10 demo approvals and 10 simulates an hour", () => {
    expect(LIMITS.demoSession).toEqual({ bucket: "demo_session", max: 4, windowMs: HOUR_MS, per: "address" });
    expect(LIMITS.demoSessionDay).toEqual({ bucket: "demo_session_day", max: 10, windowMs: DAY_MS, per: "address" });
    expect(LIMITS.claudeDemoAddress).toEqual({ bucket: "claude_demo_address", max: 80, windowMs: DAY_MS, per: "address" });
    expect(LIMITS.claudeStudioAddress).toEqual({ bucket: "claude_studio_address", max: 60, windowMs: DAY_MS, per: "address" });
    expect(LIMITS.demoApprovalsAddress).toEqual({ bucket: "demo_approvals_address", max: 10, windowMs: HOUR_MS, per: "address" });
    expect(LIMITS.simulateAddress).toEqual({ bucket: "simulate_address", max: 10, windowMs: HOUR_MS, per: "address" });
  });

  it("lets 50 addresses hold no shared pool closed for longer than its window, at most an hour, and lets no one address close one alone", () => {
    const ATTACKERS = 50;
    expect(LIMITS.claudeDemoAll).toEqual({ bucket: "claude_demo_all", max: 50, windowMs: HOUR_MS, per: "all", keptForNewSessions: 10 });
    expect(LIMITS.claudeStudioAll).toEqual({ bucket: "claude_studio_all", max: 120, windowMs: HOUR_MS, per: "all", keptForNewSessions: 20, keptDraws: 10 });
    expect(LIMITS.claudeStudioSession).toEqual({ bucket: "claude_studio_session", max: 30, windowMs: DAY_MS, per: "session" });
    expect(LIMITS.claudeStudioSessionHour).toEqual({ bucket: "claude_studio_session_hour", max: 24, windowMs: HOUR_MS, per: "session" });
    expect(LIMITS.demoApprovals).toEqual({ bucket: "demo_approvals_all", max: 100, windowMs: HOUR_MS, per: "all", keptForNewSessions: 20 });
    expect(LIMITS.simulates).toEqual({ bucket: "simulates_all", max: 100, windowMs: HOUR_MS, per: "all", keptForNewSessions: 20 });
    expect([LIMITS.claudeDemoSession.max, LIMITS.claudeDemoAddress.max]).toEqual([40, 80]);
    expect(LIMITS.demoSubmitsAddress).toEqual({ bucket: "demo_submits_address", max: 4, windowMs: DAY_MS, per: "address" });
    // 1000 is the engine's DEMO_CAMPAIGN_CAP_MINOR and 5000 its DEMO_DAILY_CAP_MINOR (tasks.py),
    // a pool the engine counts over the same rolling 24 hours.
    expect(LIMITS.demoSubmitsAddress.max * 1000).toBeLessThan(5000);

    // A session lives at most a day, so an address holds at most demoSessionDay.max live sessions.
    expect(SESSION_ABSOLUTE_MS).toBeLessThanOrEqual(LIMITS.demoSessionDay.windowMs);
    const liveSessions = LIMITS.demoSessionDay.max;
    const demoPools: readonly (readonly [Limit, Limit & { readonly keptForNewSessions: number }])[] = [
      [LIMITS.claudeDemoAddress, LIMITS.claudeDemoAll],
      [LIMITS.claudeStudioAddress, LIMITS.claudeStudioAll],
      [LIMITS.demoApprovalsAddress, LIMITS.demoApprovals],
      [LIMITS.simulateAddress, LIMITS.simulates],
    ];
    for (const [share, pool] of demoPools) {
      expect([share.per, pool.per], pool.bucket).toEqual(["address", "all"]);
      expect(pool.keptForNewSessions, pool.bucket).toBeGreaterThanOrEqual(liveSessions);
      // One address's draws in one window of the pool: its share over that window, and past
      // the pool's open part only the kept draws of each live session.
      const shareInWindow = share.max * Math.ceil(pool.windowMs / share.windowMs);
      const keptDraws = pool.keptDraws ?? 1;
      const oneAddress = Math.min(shareInWindow, pool.max - pool.keptForNewSessions + liveSessions * keptDraws - 1);
      expect(oneAddress, pool.bucket).toBeLessThan(pool.max);
      // Fifty addresses together can fill it, but each draw counts only inside the pool's
      // window, so the longest it stays closed after their last draw is that window.
      const fiftyAddresses = Math.min(ATTACKERS * shareInWindow, pool.max - pool.keptForNewSessions + ATTACKERS * liveSessions * keptDraws);
      expect(fiftyAddresses, pool.bucket).toBeGreaterThanOrEqual(pool.max);
      expect(pool.windowMs, pool.bucket).toBeLessThanOrEqual(HOUR_MS);
    }
    // Every pool shared by visitors is in the list above; claude_owner is the owner's alone.
    const pools = Object.values(LIMITS).filter((limit) => limit.per === "all").map((limit) => limit.bucket);
    expect(pools.sort()).toEqual([...demoPools.map(([, pool]) => pool.bucket), LIMITS.claudeOwner.bucket].sort());

    // The pools traffic nobody authenticated draws on are counted in memory, outside LIMITS.
    expect([CERTIFICATE_LIMITS.address.max, CERTIFICATE_LIMITS.all.max]).toEqual([2, 10]);
    for (const { address: share, all: pool } of [WEBHOOK_LIMITS, CERTIFICATE_LIMITS, JOIN_LIMITS.start, JOIN_LIMITS.callback, JOIN_LIMITS.consent]) {
      expect([share.per, pool.per], pool.bucket).toEqual(["address", "all"]);
      expect(share.windowMs, pool.bucket).toBe(pool.windowMs);
      expect(share.max, pool.bucket).toBeLessThan(pool.max);
      expect(pool.windowMs, pool.bucket).toBeLessThanOrEqual(HOUR_MS);
    }
  });

  // The sweep lock is database-wide and other test files run at the same time, so a call
  // that finds it taken skips the sweep, as it should; a later call sweeps.
  async function sweepUntil(done: () => Promise<boolean>): Promise<void> {
    for (let call = 0; call < 20 && !(await done()); call += 1) await takeHit(LIMITS.draft, `a-session-${call}`);
  }

  it("sweeps each bucket's rows, and its first-refusal marker, once older than that bucket's own window", async () => {
    await admin.query(
      `insert into rate_limit_hits (bucket, subject, at) values
         ('sign_in', '198.51.100.7', now() - interval '16 minutes'),
         ('first:refused:sign_in', '198.51.100.7', now() - interval '16 minutes'),
         ('sign_in', '198.51.100.8', now() - interval '14 minutes'),
         ('draft', 'old', now() - interval '16 minutes'),
         ('draft', 'older', now() - interval '61 minutes'),
         ('legacy_bucket', 'x', now() - interval '25 hours'),
         ('legacy_bucket', 'y', now() - interval '23 hours')`,
    );
    await sweepUntil(async () => (await hits("sign_in", "198.51.100.7")) === 0);
    expect(await hits("sign_in", "198.51.100.7")).toBe(0);
    expect(await hits("first:refused:sign_in", "198.51.100.7")).toBe(0);
    expect(await hits("sign_in", "198.51.100.8")).toBe(1);
    expect([await hits("draft", "old"), await hits("draft", "older")]).toEqual([1, 0]);
    expect([await hits("legacy_bucket", "x"), await hits("legacy_bucket", "y")]).toEqual([0, 1]);
  });
});

describe("limit hits on the audit record", () => {
  it("records only the first refusal in each window for each bucket and address, with the address tag", async () => {
    const before = await lastAuditId();
    expect(await refusedAfterFilling(LIMITS.signIn, "198.51.100.7")).toBe(true);
    for (let n = 0; n < 3; n += 1) expect((await takeHit(LIMITS.signIn, "198.51.100.7")).allowed).toBe(false);
    expect(await refusedAfterFilling(LIMITS.signIn, "198.51.100.8")).toBe(true);
    const first = { actor: "web", action: "rate_limit_hit", detail: { bucket: "sign_in", per: "address", address_tag: addressTag("198.51.100.7") } };
    const other = { actor: "web", action: "rate_limit_hit", detail: { bucket: "sign_in", per: "address", address_tag: addressTag("198.51.100.8") } };
    expect(await auditSince(before)).toEqual([first, other]);

    await admin.query("update rate_limit_hits set at = at - interval '15 minutes 1 second'");
    expect(await refusedAfterFilling(LIMITS.signIn, "198.51.100.7")).toBe(true);
    expect(await auditSince(before)).toEqual([first, other, first]);
  });

  it("records a session's refusal by its tag, never its id, and a global one by its bucket alone", async () => {
    const before = await lastAuditId();
    const sessionId = "d".repeat(64);
    await admin.query("insert into rate_limit_hits (bucket, subject) select 'claude_demo_session', $1 from generate_series(1, 40)", [sessionId]);
    expect((await takeHit(LIMITS.claudeDemoSession, sessionId)).allowed).toBe(false);
    await admin.query("insert into rate_limit_hits (bucket, subject) select 'demo_approvals_all', 'all' from generate_series(1, 100)");
    expect((await takeHit(LIMITS.demoApprovals, GLOBAL)).allowed).toBe(false);
    const rows = await auditSince(before);
    expect(rows).toEqual([
      { actor: "web", action: "rate_limit_hit", detail: { bucket: "claude_demo_session", per: "session", session_tag: sessionTag(sessionId) } },
      { actor: "web", action: "rate_limit_hit", detail: { bucket: "demo_approvals_all", per: "all" } },
    ]);
    expect(JSON.stringify(rows)).not.toContain(sessionId);
  });

  it("writes at most 20 limit-hit rows per bucket a minute across the process, then one audit_rows_suppressed row holding the count", async () => {
    const before = await lastAuditId();
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(start);
      for (let n = 0; n < 23; n += 1) await recordLimitHit(LIMITS.signIn, `198.51.100.${100 + n}`);
      await recordLimitHit(LIMITS.draft, "d".repeat(64));
      vi.setSystemTime(start + 61_000);
      await writeSuppressedAudit();
      await writeSuppressedAudit();
      await recordLimitHit(LIMITS.signIn, "198.51.100.200");
    } finally {
      vi.useRealTimers();
    }
    const rows = await auditSince(before);
    const signIns = rows.filter((row) => row.action === "rate_limit_hit" && (row.detail as { bucket: string }).bucket === "sign_in");
    expect(signIns).toHaveLength(21);
    expect(rows.filter((row) => row.action === "rate_limit_hit" && (row.detail as { bucket: string }).bucket === "draft")).toHaveLength(1);
    expect(rows.filter((row) => row.action === "audit_rows_suppressed")).toEqual([
      { actor: "web", action: "audit_rows_suppressed", detail: { action: "rate_limit_hit", reason: "sign_in", suppressed: 3 } },
    ]);
    expect(rows.at(-1)).toEqual({ actor: "web", action: "rate_limit_hit", detail: { bucket: "sign_in", per: "address", address_tag: addressTag("198.51.100.200") } });
  });

  it("refuses the same way when the audit row cannot be written, and logs one line saying so", async () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    await admin.query("alter table audit_log rename to audit_log_away");
    try {
      expect(await refusedAfterFilling(LIMITS.signIn, "198.51.100.9")).toBe(true);
    } finally {
      await admin.query("alter table audit_log_away rename to audit_log");
      vi.restoreAllMocks();
    }
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ kind: "audit", outcome: "not_written", action: "rate_limit_hit", reason: "db_error" }),
    ]);
  });
});
