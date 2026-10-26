// Covers which address a request is counted against, its short tag, the counting itself
// against a real Postgres schema, including concurrent requests, and the one audit row
// each window's first refusal leaves. Does NOT cover: Render's proxy really appending
// the client address (unverified until deployed; the tag in the webhook log line is how
// to check it), the limits wired into each route (console-routes.test.ts, npm run
// prove:m7a), or attackers spread across many addresses (a named non-goal).
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_DIR, SCHEMA_PATH, type DevDatabase } from "../../scripts/dev-database";
import { closeDatabase } from "./db";
import { addressTag, clientAddress, GLOBAL, LIMITS, sessionTag, takeHit, UNKNOWN_ADDRESS, type Limit } from "./ratelimit";

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
    for (let n = 0; n < 100; n += 1) await takeHit(LIMITS.demoApprovals, GLOBAL);
    expect((await takeHit(LIMITS.demoApprovals, GLOBAL)).allowed).toBe(false);
    expect((await takeHit(LIMITS.approve, "a-session")).allowed).toBe(true);
  });

  it("lets 20 join starts and 20 join returns through per address in a minute, each counted apart", async () => {
    for (let n = 0; n < 20; n += 1) expect((await takeHit(LIMITS.joinStart, "198.51.100.7")).allowed).toBe(true);
    const refused = await takeHit(LIMITS.joinStart, "198.51.100.7");
    expect(!refused.allowed && refused.retryAfterSeconds <= 60).toBe(true);
    expect((await takeHit(LIMITS.joinCallback, "198.51.100.7")).allowed).toBe(true);
    expect((await takeHit(LIMITS.joinStart, "198.51.100.8")).allowed).toBe(true);
    await admin.query("update rate_limit_hits set at = at - interval '61 seconds'");
    expect((await takeHit(LIMITS.joinStart, "198.51.100.7")).allowed).toBe(true);
    expect(LIMITS.joinCallback).toEqual({ bucket: "join_callback", max: 20, windowMs: 60_000, per: "address" });
  });

  it("lets 60 consent reads through per address in a minute and refuses the 61st", async () => {
    await admin.query(
      "insert into rate_limit_hits (bucket, subject, at) select 'join_consent', '198.51.100.7', now() - interval '30 seconds' from generate_series(1, 59)",
    );
    expect((await takeHit(LIMITS.joinConsent, "198.51.100.7")).allowed).toBe(true);
    const refused = await takeHit(LIMITS.joinConsent, "198.51.100.7");
    expect(!refused.allowed && refused.retryAfterSeconds <= 60).toBe(true);
    expect((await takeHit(LIMITS.joinConsent, "198.51.100.8")).allowed).toBe(true);
    expect(await hits("join_consent", "198.51.100.7")).toBe(60);
  });

  it("lets a session pull back unclaimed rewards 10 times an hour, counted apart from its submits", async () => {
    for (let n = 0; n < 10; n += 1) expect((await takeHit(LIMITS.cancelUnclaimed, "a-session")).allowed).toBe(true);
    const refused = await takeHit(LIMITS.cancelUnclaimed, "a-session");
    expect(!refused.allowed && refused.retryAfterSeconds <= 3600).toBe(true);
    expect((await takeHit(LIMITS.submit, "a-session")).allowed).toBe(true);
    expect((await takeHit(LIMITS.cancelUnclaimed, "another-session")).allowed).toBe(true);
  });

  it("gives each client address its own share of the demo: 4 demo sessions an hour and 10 a day, 80 demo Claude calls a day, 10 demo approvals and 10 simulates an hour", () => {
    expect(LIMITS.demoSession).toEqual({ bucket: "demo_session", max: 4, windowMs: HOUR_MS, per: "address" });
    expect(LIMITS.demoSessionDay).toEqual({ bucket: "demo_session_day", max: 10, windowMs: DAY_MS, per: "address" });
    expect(LIMITS.claudeDemoAddress).toEqual({ bucket: "claude_demo_address", max: 80, windowMs: DAY_MS, per: "address" });
    expect(LIMITS.demoApprovalsAddress).toEqual({ bucket: "demo_approvals_address", max: 10, windowMs: HOUR_MS, per: "address" });
    expect(LIMITS.simulateAddress).toEqual({ bucket: "simulate_address", max: 10, windowMs: HOUR_MS, per: "address" });
  });

  it("sweeps out rows older than every window", async () => {
    await admin.query("insert into rate_limit_hits (bucket, subject, at) values ('draft', 'old', now() - interval '25 hours')");
    // The sweep lock is database-wide and other test files run at the same time, so a
    // call that finds it taken skips the sweep, as it should; a later call sweeps.
    for (let call = 0; call < 20 && (await hits("draft", "old")) > 0; call += 1) await takeHit(LIMITS.draft, `a-session-${call}`);
    expect(await hits("draft", "old")).toBe(0);
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
