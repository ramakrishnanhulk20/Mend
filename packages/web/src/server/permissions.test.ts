// Covers the permission table, authorize() against real sessions in a throwaway
// Postgres schema, and the shape of refusals. Does NOT cover: each route's choice of
// action (npm run prove:m7a calls the routes), or what the engine enforces on top for
// demo sessions (packages/engine tests/test_tasks.py).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_DIR, SCHEMA_PATH, type DevDatabase } from "../../scripts/dev-database";
import { SESSION_COOKIE } from "./auth";
import { ConfigError } from "./config";
import { closeDatabase } from "./db";
import { ACTIONS, authorize, isAllowed, refuse, reply, scrubbed, type Action, type PrincipalRole } from "./permissions";
import { createSession } from "./sessions";

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

const ROLES: readonly PrincipalRole[] = ["anonymous", "demo", "owner"];
const CSRF_SECRET = "csrf-secret-for-permission-tests-0123456789";
let dev: DevDatabase;
let admin: pg.Client;
let logLines: string[] = [];
const schema = `web_permissions_${process.pid}_${Date.now()}`;

function asSession(token: string | null): Request {
  return new Request("http://127.0.0.1:3000/api/x", { headers: token === null ? {} : { cookie: `${SESSION_COOKIE}=${token}` } });
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
  vi.stubEnv("MEND_OWNER_PASSWORD", "owner-password-for-permission-tests");
  vi.stubEnv("MEND_DEV", "1");
  vi.stubEnv("MEND_BASE_URL", "http://127.0.0.1:3000");
  vi.stubEnv("MEND_CSRF_SECRET", CSRF_SECRET);
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

beforeEach(() => {
  logLines = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    logLines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  return () => vi.restoreAllMocks();
});

describe("the permission table", () => {
  it.each(["", "admin", "admin.users", "admin.credentials", "campaign.delete", "CAMPAIGN.DRAFT", "campaign.draft ", "__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"])(
    "denies %j to every role, because it is not in the table",
    (action) => {
      for (const role of ROLES) expect(isAllowed(action, role)).toBe(false);
    },
  );

  it("never grants the scheduled jobs to a demo session or to anyone signed out", () => {
    for (const action of ["admin.events", "admin.reconcile", "admin.purge"]) {
      expect(isAllowed(action, "demo")).toBe(false);
      expect(isAllowed(action, "anonymous")).toBe(false);
      expect(isAllowed(action, "owner")).toBe(true);
    }
  });

  it("lets someone signed out do nothing but start a session and read the public shop summary", () => {
    expect(ACTIONS.filter((action) => isAllowed(action, "anonymous"))).toEqual(["session.start", "shop.summary"]);
  });

  it("needs a session to list quiet regulars or poll a run", () => {
    for (const action of ["shop.quiet_regulars", "run.read"]) {
      expect(isAllowed(action, "anonymous")).toBe(false);
      expect(isAllowed(action, "demo")).toBe(true);
      expect(isAllowed(action, "owner")).toBe(true);
    }
  });

  it("lets demo and owner plan, write notes, request approval and chat with the assistant, and nobody signed out", () => {
    for (const action of ["campaign.plan", "campaign.notes", "campaign.request_approval", "agent.chat"]) {
      expect([isAllowed(action, "anonymous"), isAllowed(action, "demo"), isAllowed(action, "owner")], action).toEqual([false, true, true]);
    }
  });

  it("gives the owner every action and the demo role every action but the scheduled jobs", () => {
    expect(ACTIONS.filter((action) => !isAllowed(action, "owner"))).toEqual([]);
    expect(ACTIONS.filter((action) => !isAllowed(action, "demo"))).toEqual(["admin.events", "admin.reconcile", "admin.purge"]);
  });
});

describe("authorize", () => {
  it("answers 401 to a signed-out caller for an action signing in would allow", async () => {
    const result = await authorize("campaign.draft", asSession(null));
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it("answers 403 to a demo session for the scheduled jobs and logs the refusal without the token", async () => {
    const demo = await createSession("demo");
    for (const action of ["admin.events", "admin.reconcile", "admin.purge"] as const) {
      expect(await authorize(action, asSession(demo.token))).toMatchObject({ ok: false, status: 403 });
    }
    const text = logLines.join("");
    expect(text).toContain('"outcome":"denied"');
    expect(text).not.toContain(demo.token);
    expect(text).not.toContain(demo.sessionId);
  });

  it("allows the owner session every action", async () => {
    const owner = await createSession("owner");
    for (const action of ACTIONS) {
      const result = await authorize(action, asSession(owner.token));
      expect(result.ok, action).toBe(true);
    }
  });

  it("denies a string outside the table even to the owner, and logs it as unknown", async () => {
    const owner = await createSession("owner");
    expect(await authorize("admin.users" as Action, asSession(owner.token))).toMatchObject({ ok: false, status: 403 });
    expect(logLines.join("")).toContain('"action":"unknown"');
  });

  it("refuses every action, even to the owner, while MEND_CSRF_SECRET is missing or under 32 bytes", async () => {
    const owner = await createSession("owner");
    for (const secret of ["", "x".repeat(31)]) {
      vi.stubEnv("MEND_CSRF_SECRET", secret);
      await expect(authorize("session.read", asSession(owner.token))).rejects.toThrow(ConfigError);
      await expect(authorize("session.start", asSession(null))).rejects.toThrow(ConfigError);
    }
    vi.stubEnv("MEND_CSRF_SECRET", CSRF_SECRET);
    expect((await authorize("session.read", asSession(owner.token))).ok).toBe(true);
  });

  it("treats an expired session as signed out", async () => {
    const demo = await createSession("demo");
    await admin.query("update sessions set expires_at = now() - interval '1 second' where session_id = $1", [demo.sessionId]);
    expect(await authorize("campaign.view", asSession(demo.token))).toMatchObject({ ok: false, status: 401 });
  });
});

describe("answers", () => {
  it("a refusal carries only the code, a generic message and the ref", async () => {
    const response = refuse("POST /api/x", "6f1c1d3e-2b9a-4f0e-9a51-3c1d2e4f5a6b", 422, "budget_over_cap", { detail: "secret detail" });
    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "budget_over_cap",
      message: "That breaks a rule for this account.",
      ref: "6f1c1d3e-2b9a-4f0e-9a51-3c1d2e4f5a6b",
    });
    expect(logLines.join("")).toContain("secret detail");
  });

  it("a reply sets every cookie given", () => {
    const response = reply(200, { ok: true }, ["a=1; Path=/", "b=2; Path=/"]);
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("log text is scrubbed of secret settings and token-shaped strings", () => {
    const text = scrubbed(`pw owner-password-for-permission-tests s1.${"a".repeat(43)} c1.${"b".repeat(43)} ${"f".repeat(64)}`);
    expect(text).toBe("pw [removed] [token] [token] [hex64]");
  });
});
