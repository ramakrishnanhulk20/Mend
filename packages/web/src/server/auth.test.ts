// Covers the deployment settings the browser side depends on, cookie names, reading and
// writing, the owner password check, and sign-in rotation against a real Postgres
// schema. Does NOT cover: the routes (npm run prove:m7a), rate limits on sign-in
// (ratelimit.test.ts), or timing measurements of the password check (the constant-time
// property comes from crypto.timingSafeEqual on equal-length digests, not from a test).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_DIR, SCHEMA_PATH, type DevDatabase } from "../../scripts/dev-database";
import {
  baseUrl,
  cookieHeader,
  currentPrincipal,
  devMode,
  endCurrentSession,
  isLoopback,
  ownerPasswordMatches,
  readCookie,
  SECURE_SESSION_COOKIE,
  SESSION_COOKIE,
  secureCookies,
  sessionCookieName,
  startSession,
} from "./auth";
import { ConfigError } from "./config";
import { closeDatabase } from "./db";
import { createSession, readSession } from "./sessions";

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

const PASSWORD = "correct-horse-battery-staple-42";
let dev: DevDatabase;
let admin: pg.Client;
const schema = `web_auth_${process.pid}_${Date.now()}`;

function withCookie(cookie: string | null): Request {
  return new Request("http://127.0.0.1:3000/api/x", { headers: cookie === null ? {} : { cookie } });
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

beforeEach(() => {
  vi.stubEnv("MEND_DEV", "0");
  vi.stubEnv("MEND_BASE_URL", "https://mend.example");
  vi.stubEnv("MEND_OWNER_PASSWORD", PASSWORD);
});

describe("devMode", () => {
  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["0", false],
    ["false", false],
    ["", false],
  ])("reads %j as %s, as the engine does", (raw, expected) => {
    vi.stubEnv("MEND_DEV", raw);
    expect(devMode()).toBe(expected);
  });

  it("refuses anything else", () => {
    vi.stubEnv("MEND_DEV", "yes");
    expect(() => devMode()).toThrow(ConfigError);
  });
});

describe("isLoopback", () => {
  it.each([
    ["localhost", true],
    ["127.0.0.1", true],
    ["127.9.8.7", true],
    ["[::1]", true],
    ["[0:0:0:0:0:0:0:1]", true],
    ["10.0.0.1", false],
    ["localhost.evil.example", false],
    ["127.0.0.1.evil.example", false],
    ["[::2]", false],
    ["mend.example", false],
  ])("%s is %s", (host, expected) => {
    expect(isLoopback(host)).toBe(expected);
  });
});

describe("baseUrl", () => {
  it("accepts a bare https origin", () => {
    expect(baseUrl().origin).toBe("https://mend.example");
  });

  it("accepts plain http only for this machine and only in development", () => {
    vi.stubEnv("MEND_BASE_URL", "http://127.0.0.1:3000");
    expect(() => baseUrl()).toThrow(ConfigError);
    vi.stubEnv("MEND_DEV", "1");
    expect(baseUrl().origin).toBe("http://127.0.0.1:3000");
    vi.stubEnv("MEND_BASE_URL", "http://mend.example");
    expect(() => baseUrl()).toThrow(ConfigError);
  });

  it.each(["", "mend.example", "https://mend.example/app", "https://mend.example/?x=1", "https://a:b@mend.example", "https://mend.example/#top", "ftp://mend.example"])(
    "refuses %j",
    (value) => {
      vi.stubEnv("MEND_BASE_URL", value);
      expect(() => baseUrl()).toThrow(ConfigError);
    },
  );
});

describe("cookies", () => {
  it("are HttpOnly, SameSite=Lax, Path=/ and Secure on https", () => {
    expect(secureCookies()).toBe(true);
    expect(cookieHeader("mend_session", "s1.abc", 60)).toBe("mend_session=s1.abc; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure");
  });

  it("drop Secure only for plain http to this machine in development", () => {
    vi.stubEnv("MEND_DEV", "1");
    vi.stubEnv("MEND_BASE_URL", "http://127.0.0.1:3000");
    expect(cookieHeader("mend_session", "s1.abc", 60)).toBe("mend_session=s1.abc; Path=/; Max-Age=60; HttpOnly; SameSite=Lax");
  });

  it("name the session __Host-mend_session over https, and mend_session only over http to this machine in development", () => {
    expect(sessionCookieName()).toBe(SECURE_SESSION_COOKIE);
    expect(cookieHeader(SECURE_SESSION_COOKIE, "s1.abc", 60)).toBe("__Host-mend_session=s1.abc; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure");
    expect(cookieHeader(SECURE_SESSION_COOKIE, "s1.abc", 60)).not.toMatch(/Domain=/i);
    vi.stubEnv("MEND_DEV", "1");
    vi.stubEnv("MEND_BASE_URL", "http://127.0.0.1:3000");
    expect(sessionCookieName()).toBe(SESSION_COOKIE);
    vi.stubEnv("MEND_BASE_URL", "http://localhost:3000");
    expect(sessionCookieName()).toBe("mend_session");
  });

  it("refuse to write a __Host- cookie without https, since a browser would drop it", () => {
    vi.stubEnv("MEND_DEV", "1");
    vi.stubEnv("MEND_BASE_URL", "http://127.0.0.1:3000");
    expect(() => cookieHeader(SECURE_SESSION_COOKIE, "s1.abc", 60)).toThrow("__Host-");
  });

  it("refuse names and values holding characters this app never issues", () => {
    expect(() => cookieHeader("mend_session", "a;b", 60)).toThrow();
    expect(() => cookieHeader("mend session", "a", 60)).toThrow();
  });

  it("are read by exact name, and a name sent twice counts as missing", () => {
    expect(readCookie(withCookie("a=1; mend_session=s1.x; b=2"), "mend_session")).toBe("s1.x");
    expect(readCookie(withCookie("xmend_session=s1.x"), "mend_session")).toBeNull();
    expect(readCookie(withCookie("mend_session=s1.x; mend_session=s1.y"), "mend_session")).toBeNull();
    expect(readCookie(withCookie(null), "mend_session")).toBeNull();
  });
});

describe("ownerPasswordMatches", () => {
  it("accepts only the exact password", () => {
    expect(ownerPasswordMatches(PASSWORD)).toBe(true);
    for (const guess of [`${PASSWORD} `, PASSWORD.slice(0, -1), PASSWORD.toUpperCase(), "", "x".repeat(2000), 42, null, undefined]) {
      expect(ownerPasswordMatches(guess)).toBe(false);
    }
  });

  it("refuses every sign-in when the password is not set or is short", () => {
    vi.stubEnv("MEND_OWNER_PASSWORD", "");
    expect(() => ownerPasswordMatches("")).toThrow(ConfigError);
    vi.stubEnv("MEND_OWNER_PASSWORD", "fifteen-chars!!");
    expect(() => ownerPasswordMatches("fifteen-chars!!")).toThrow(ConfigError);
  });
});

describe("sessions over HTTP", () => {
  it("a request with no session cookie is anonymous", async () => {
    expect(await currentPrincipal(withCookie(null))).toEqual({ role: "anonymous" });
  });

  it("a request with a live session cookie is that session's role", async () => {
    const session = await createSession("demo");
    expect(await currentPrincipal(withCookie(`${SECURE_SESSION_COOKIE}=${session.token}`))).toMatchObject({ role: "demo", sessionId: session.sessionId });
  });

  it("over https a plain mend_session cookie signs nobody in, so a sibling host cannot plant one", async () => {
    const session = await createSession("owner");
    expect(await currentPrincipal(withCookie(`${SESSION_COOKIE}=${session.token}`))).toEqual({ role: "anonymous" });
    vi.stubEnv("MEND_DEV", "1");
    vi.stubEnv("MEND_BASE_URL", "http://127.0.0.1:3000");
    expect(await currentPrincipal(withCookie(`${SESSION_COOKIE}=${session.token}`))).toMatchObject({ role: "owner" });
  });

  it("signing in ends the browser's old session and hands out a new token", async () => {
    const before = await createSession("demo");
    const { session, cookie } = await startSession(withCookie(`${SECURE_SESSION_COOKIE}=${before.token}`), "owner");
    expect(session.token).not.toBe(before.token);
    expect(session.sessionId).not.toBe(before.sessionId);
    expect(cookie).toBe(`__Host-mend_session=${session.token}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax; Secure`);
    expect(await readSession(before.token)).toBeNull();
    expect(await readSession(session.token)).toMatchObject({ role: "owner" });
  });

  it("signing out deletes the session and clears the cookie", async () => {
    const session = await createSession("owner");
    const cookie = await endCurrentSession(withCookie(`${SECURE_SESSION_COOKIE}=${session.token}`));
    expect(cookie).toBe("__Host-mend_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure");
    expect(await readSession(session.token)).toBeNull();
  });
});
