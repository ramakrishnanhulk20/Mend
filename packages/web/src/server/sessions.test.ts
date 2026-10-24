// Covers the session store against a real Postgres schema (the engine's schema.sql in a
// throwaway schema). Does NOT cover: cookies, sign-in and rotation (auth.test.ts), who
// may do what (permissions.test.ts), or the routes themselves (npm run prove:m7a).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_DIR, SCHEMA_PATH, type DevDatabase } from "../../scripts/dev-database";
import { closeDatabase, database } from "./db";
import { createSession, endSession, isSessionToken, readSession, sessionIdFor } from "./sessions";

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
const schema = `web_sessions_${process.pid}_${Date.now()}`;

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
  await admin.query("delete from sessions");
  return () => vi.restoreAllMocks();
});

async function storedRow(sessionId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await admin.query("select * from sessions where session_id = $1", [sessionId]);
  return rows[0];
}

describe("createSession", () => {
  it("gives an s1. token of 32 random bytes and stores only its SHA-256", async () => {
    const session = await createSession("demo");
    expect(session.token).toMatch(/^s1\.[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(session.token.slice(3), "base64url")).toHaveLength(32);
    expect(session.sessionId).toBe(createHash("sha256").update(session.token).digest("hex"));
    const { rows } = await admin.query("select row_to_json(s)::text as text from sessions s");
    expect(rows).toHaveLength(1);
    expect(rows[0].text).not.toContain(session.token);
    expect(rows[0].text).not.toContain(session.token.slice(3));
    const row = await storedRow(session.sessionId);
    expect(row?.role).toBe("demo");
    const lifetime = (row?.expires_at as Date).getTime() - (row?.created_at as Date).getTime();
    expect(lifetime).toBe(24 * 60 * 60 * 1000);
  });

  it("keeps the token out of JSON and object spreads, so a logged session never shows it", async () => {
    const session = await createSession("owner");
    expect(JSON.stringify(session)).not.toContain(session.token);
    expect(JSON.stringify({ ...session })).not.toContain("s1.");
  });

  it("deletes sessions past either limit while creating a new one", async () => {
    const idle = await createSession("demo");
    const old = await createSession("demo");
    await admin.query("update sessions set last_seen_at = now() - interval '3 hours' where session_id = $1", [idle.sessionId]);
    await admin.query("update sessions set expires_at = now() - interval '1 second' where session_id = $1", [old.sessionId]);
    const fresh = await createSession("demo");
    const { rows } = await admin.query("select session_id from sessions");
    expect(rows.map((row) => row.session_id)).toEqual([fresh.sessionId]);
  });
});

describe("readSession", () => {
  it("returns the live session and records the use", async () => {
    const session = await createSession("owner");
    await admin.query("update sessions set last_seen_at = now() - interval '90 minutes' where session_id = $1", [session.sessionId]);
    const read = await readSession(session.token);
    expect(read).toMatchObject({ sessionId: session.sessionId, role: "owner" });
    const row = await storedRow(session.sessionId);
    expect(Date.now() - (row?.last_seen_at as Date).getTime()).toBeLessThan(60_000);
  });

  it("refuses a session idle for more than 2 hours", async () => {
    const session = await createSession("demo");
    await admin.query("update sessions set last_seen_at = now() - interval '2 hours 1 minute' where session_id = $1", [session.sessionId]);
    expect(await readSession(session.token)).toBeNull();
  });

  it("refuses a session past its 24 hour limit even when it was used a moment ago", async () => {
    const session = await createSession("demo");
    await admin.query("update sessions set expires_at = now() - interval '1 second' where session_id = $1", [session.sessionId]);
    expect(await readSession(session.token)).toBeNull();
  });

  it("refuses the stored id itself: knowing a record id is not being the user", async () => {
    const session = await createSession("owner");
    expect(await readSession(session.sessionId)).toBeNull();
    expect(await readSession(`s1.${session.sessionId.slice(0, 43)}`)).toBeNull();
  });

  it("refuses tokens of the wrong shape before any query", async () => {
    const query = vi.spyOn(database(), "query");
    for (const token of [null, "", "s1.", "s2." + "a".repeat(43), "s1." + "a".repeat(44), "s1." + "a".repeat(42) + "=", " s1." + "a".repeat(43)]) {
      expect(await readSession(token)).toBeNull();
    }
    expect(query).not.toHaveBeenCalled();
    expect(isSessionToken(`s1.${randomBytes(32).toString("base64url")}`)).toBe(true);
  });
});

describe("endSession", () => {
  it("deletes the session so its token no longer works", async () => {
    const session = await createSession("demo");
    await endSession(session.token);
    expect(await readSession(session.token)).toBeNull();
    expect(await storedRow(sessionIdFor(session.token))).toBeUndefined();
  });
});
