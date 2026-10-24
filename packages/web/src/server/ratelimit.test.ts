// Covers which address a request is counted against and the counting itself, against a
// real Postgres schema, including concurrent requests. Does NOT cover: Render's proxy
// really appending the client address (unverified until deployed), the limits wired
// into each route (npm run prove:m7a sends 11 sign-ins), or attackers spread across
// many addresses (a named non-goal).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_DIR, SCHEMA_PATH, type DevDatabase } from "../../scripts/dev-database";
import { closeDatabase } from "./db";
import { clientAddress, GLOBAL, LIMITS, takeHit, UNKNOWN_ADDRESS, type Limit } from "./ratelimit";

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
    const limit: Limit = { bucket: "race", max: 10, windowMs: 60_000 };
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

  it("sweeps out rows older than every window", async () => {
    await admin.query("insert into rate_limit_hits (bucket, subject, at) values ('draft', 'old', now() - interval '25 hours')");
    await takeHit(LIMITS.draft, "a-session");
    expect(await hits("draft", "old")).toBe(0);
  });
});
