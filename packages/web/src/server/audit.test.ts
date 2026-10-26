// Covers appendAudit and inTransaction against a real Postgres schema (the engine's
// schema.sql in a throwaway schema): the row each call writes, the detail rule that
// refuses emails, tokens, long hex ids, free text and secret values before anything is
// written, the transaction form failing with its caller, and the best-effort form never
// throwing. Does NOT cover: which actions each route records (console-routes,
// ratelimit, webhooks and agent tests), or the app's limited database role being
// refused an UPDATE (the engine's test_app_role.py).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ENGINE_DIR, SCHEMA_PATH, type DevDatabase } from "../../scripts/dev-database";
import { appendAudit, AuditRefused, inTransaction, type AuditDetail } from "./audit";
import { closeDatabase, database } from "./db";

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

const SECRET = "csrf-secret-for-audit-tests-0123456789";
let dev: DevDatabase;
let admin: pg.Client;
const schema = `web_audit_${process.pid}_${Date.now()}`;

async function lastAuditId(): Promise<number> {
  const { rows } = await admin.query<{ id: number }>("select coalesce(max(id), 0)::int as id from audit_log");
  return rows[0].id;
}

async function auditSince(id: number): Promise<{ actor: string; action: string; detail: unknown }[]> {
  const { rows } = await admin.query("select actor, action, detail from audit_log where id > $1 order by id", [id]);
  return rows;
}

async function probeRows(): Promise<number> {
  const { rows } = await admin.query<{ n: number }>("select count(*)::int as n from rate_limit_hits where bucket = 'audit_probe'");
  return rows[0].n;
}

function captureLog(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  return lines;
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("appendAudit with a client", () => {
  it("writes one row with actor web inside the caller's transaction, and nothing once that transaction rolls back", async () => {
    const before = await lastAuditId();
    const client = await database().connect();
    try {
      await client.query("begin");
      await appendAudit("sign_out", { role: "demo", reason: "rolled_back" }, { client });
      await client.query("rollback");
      await client.query("begin");
      await appendAudit("sign_out", { role: "demo", session_tag: "0123456789ab", calls: 3, first: true, reason: null }, { client });
      await client.query("commit");
    } finally {
      client.release();
    }
    expect(await auditSince(before)).toEqual([
      { actor: "web", action: "sign_out", detail: { role: "demo", session_tag: "0123456789ab", calls: 3, first: true, reason: null } },
    ]);
  });

  it.each([
    ["an email address", { who: "maya@shop.example" }],
    ["a session token", { token: `s1.${"a".repeat(43)}` }],
    ["a CSRF token", { token: `c2.${"b".repeat(43)}` }],
    ["a 64-hex session id", { session: "f".repeat(64) }],
    ["a secret setting's value", { reason: SECRET }],
    ["free text", { note: "Thank you for the mug" }],
    ["a key that is not a plain name", { "Who Asked": "owner" }],
    ["a number that is not finite", { calls: Number.NaN }],
  ] as const)("refuses %s before writing anything", async (_label, detail) => {
    const before = await lastAuditId();
    const client = await database().connect();
    const query = vi.spyOn(client, "query");
    try {
      await expect(appendAudit("probe", detail as AuditDetail, { client })).rejects.toThrow(AuditRefused);
      expect(query).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
      client.release();
    }
    expect(await auditSince(before)).toEqual([]);
  });

  it("refuses an action that is not a plain name", async () => {
    const client = await database().connect();
    try {
      await expect(appendAudit("sign in\nforged", { role: "owner" }, { client })).rejects.toThrow(AuditRefused);
    } finally {
      client.release();
    }
  });
});

describe("appendAudit without a client", () => {
  it("writes the row on its own connection", async () => {
    const before = await lastAuditId();
    await appendAudit("rate_limit_hit", { bucket: "sign_in", per: "address", address_tag: "a1b2c3d4e5f6" });
    expect(await auditSince(before)).toEqual([
      { actor: "web", action: "rate_limit_hit", detail: { bucket: "sign_in", per: "address", address_tag: "a1b2c3d4e5f6" } },
    ]);
  });

  it("never throws: a refused detail or a missing table writes one error log line each, without the refused value", async () => {
    const lines = captureLog();
    await expect(appendAudit("probe", { who: "maya@shop.example" })).resolves.toBeUndefined();
    await admin.query("alter table audit_log rename to audit_log_away");
    try {
      await expect(appendAudit("probe", { role: "demo" })).resolves.toBeUndefined();
    } finally {
      await admin.query("alter table audit_log_away rename to audit_log");
    }
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toEqual([
      expect.objectContaining({ kind: "audit", outcome: "not_written", action: "probe", reason: "refused" }),
      expect.objectContaining({ kind: "audit", outcome: "not_written", action: "probe", reason: "db_error", code: "42P01" }),
    ]);
    expect(lines.join("")).not.toContain("maya");
  });
});

describe("inTransaction", () => {
  it("commits the work and its audit row together, or neither when the audit row is refused", async () => {
    const before = await lastAuditId();
    await expect(
      inTransaction(async (client) => {
        await client.query("insert into rate_limit_hits (bucket, subject) values ('audit_probe', 'x')");
        await appendAudit("probe", { who: "maya@shop.example" }, { client });
      }),
    ).rejects.toThrow(AuditRefused);
    expect(await probeRows()).toBe(0);
    expect(await auditSince(before)).toEqual([]);

    const answer = await inTransaction(async (client) => {
      await client.query("insert into rate_limit_hits (bucket, subject) values ('audit_probe', 'x')");
      await appendAudit("probe", { role: "demo" }, { client });
      return "done";
    });
    expect(answer).toBe("done");
    expect(await probeRows()).toBe(1);
    expect(await auditSince(before)).toEqual([{ actor: "web", action: "probe", detail: { role: "demo" } }]);
  });

  it("leaves every written row as it is: the database refuses to change or delete one", async () => {
    await appendAudit("probe", { role: "owner" });
    await expect(admin.query("update audit_log set action = 'changed'")).rejects.toThrow();
    await expect(admin.query("delete from audit_log")).rejects.toThrow();
  });
});
