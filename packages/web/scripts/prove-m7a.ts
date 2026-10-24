/**
 * M7a local proof: sign-in, roles, CSRF, rate limits and the engine task layer, end to
 * end on this machine. Starts the engine's dev bridge and a production build of the web
 * app, both pointed at a throwaway schema in the local dev database that holds a copy
 * of the demo shop, then drives the real routes over HTTP the way a browser would.
 *
 * Run from packages/web: npm run prove:m7a. Prints PASS or FAIL per line and ends with
 * "M7A RESULT: PASS" only if every line passed. Calls no PayPal API and moves no money.
 * Always stops the server and the bridge, drops the schema and releases the database,
 * even on failure.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import pg from "pg";
import { closeDatabase } from "../src/server/db";
import { ACTIONS, authorize, isAllowed, type Action, type PrincipalRole } from "../src/server/permissions";
import { ENGINE_DIR, holdDevDatabase, SCHEMA_PATH } from "./dev-database";

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.resolve(WEB_DIR, "..", "..", ".env");
const NEXT_BIN = path.join(WEB_DIR, "node_modules", "next", "dist", "bin", "next");
const DIST_DIR = ".next-verify";
const PYTHON = path.join(ENGINE_DIR, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
// The web config needs a webhook id to load; this proof registers no webhook and calls no PayPal API.
const UNUSED_WEBHOOK_ID = "M7APROOFNOWEBHOOK";
const DEMO_DRAFT = {
  goalText: "Bring back our quiet regulars with a small thank-you",
  asOf: "2026-10-16",
  budgetMinor: 100,
  perRecipientMinor: 10,
  holdoutShare: "0.50",
  maxCandidates: 20,
};
const LEAK_SHAPES = /Traceback|psycopg|select |column|session_id|File "|line \d|\.py/i;

class ProofFailed extends Error {}

let allPassed = true;

function line(passed: boolean, text: string): void {
  if (!passed) allPassed = false;
  console.log(`${passed ? "PASS" : "FAIL"}  ${text}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const cleanups: { label: string; run: () => Promise<void> }[] = [];

function onCleanup(label: string, run: () => Promise<void>): void {
  cleanups.push({ label, run });
}

async function cleanUp(): Promise<void> {
  while (cleanups.length > 0) {
    const step = cleanups.pop();
    if (step === undefined) break;
    try {
      await step.run();
    } catch (error) {
      line(false, `cleanup: ${step.label} failed (${error instanceof Error ? error.message : "unknown error"})`);
    }
  }
}

function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return Promise.resolve();
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
  return Promise.race([exited, sleep(10_000)]);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(what: string, timeoutMs: number, everyMs: number, attempt: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const result = await attempt();
      if (result !== null) return result;
    } catch (error) {
      if (error instanceof ProofFailed) throw error;
    }
    if (Date.now() > deadline) throw new ProofFailed(`${what} did not happen within ${Math.round(timeoutMs / 1000)} s`);
    await sleep(everyMs);
  }
}

function readEnv(): Record<string, string | undefined> {
  const fromFile = parseEnv(readFileSync(ENV_PATH, "utf8").replace(/^﻿/, ""));
  const merged: Record<string, string | undefined> = { ...fromFile };
  for (const name of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "MEND_OWNER_PASSWORD"]) {
    if (process.env[name] !== undefined) merged[name] = process.env[name];
  }
  return merged;
}

/** The environment a child process starts from, with every setting this proof controls removed. */
function inheritedEnv(): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  for (const name of Object.keys(inherited)) {
    if (name.startsWith("PAYPAL_") || name.startsWith("MEND_") || name.startsWith("RENDER_") || name === "DATABASE_URL") delete inherited[name];
  }
  return inherited;
}

let serverOutput = "";
let bridgeOutput = "";
const responseText: string[] = [];

function capture(child: ChildProcess, sink: (chunk: string) => void): void {
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", sink);
  }
}

function build(): void {
  const result = spawnSync(process.execPath, [NEXT_BIN, "build"], {
    cwd: WEB_DIR,
    env: { ...inheritedEnv(), NEXT_DIST_DIR: DIST_DIR, NEXT_TELEMETRY_DISABLED: "1" },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const tail = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).slice(-15).join("\n");
    throw new ProofFailed(`next build failed:\n${tail}`);
  }
}

async function startBridge(env: Record<string, string>): Promise<{ readonly child: ChildProcess; readonly url: string }> {
  const child = spawn(PYTHON, ["-m", "mend_engine.dev_bridge", "--port", "0"], {
    cwd: ENGINE_DIR,
    env: { ...inheritedEnv(), ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  capture(child, (chunk) => {
    bridgeOutput += chunk;
  });
  onCleanup("stop the dev bridge", () => stopProcess(child));
  const port = await waitFor("dev bridge start", 60_000, 200, async () => {
    if (child.exitCode !== null) throw new ProofFailed(`dev bridge exited: ${bridgeOutput.trim().split(/\r?\n/).at(-1)}`);
    return /dev bridge listening on 127\.0\.0\.1:(\d+)/.exec(bridgeOutput)?.[1] ?? null;
  });
  return { child, url: `http://127.0.0.1:${port}` };
}

async function startServer(port: number, env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: WEB_DIR,
    env: { ...inheritedEnv(), ...env, NEXT_DIST_DIR: DIST_DIR, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  capture(child, (chunk) => {
    serverOutput += chunk;
  });
  onCleanup("stop the server", () => stopProcess(child));
  await waitFor("server start", 60_000, 500, async () => {
    if (child.exitCode !== null) throw new ProofFailed("server exited during start");
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    return response.status === 200 && (await response.text()) === "ok" ? true : null;
  });
  return child;
}

type Answer = { readonly status: number; readonly body: Record<string, unknown>; readonly text: string; readonly setCookies: string[]; readonly headers: Headers };

/** One browser: a cookie jar and the CSRF token its pages would hold. Every answer is kept for the secrets check. */
class Browser {
  readonly cookies = new Map<string, string>();
  csrf = "";
  readonly issuedTokens: string[] = [];

  constructor(private readonly base: string) {}

  async send(
    method: "GET" | "POST",
    route: string,
    options: { body?: unknown; origin?: string | null; csrf?: string | null; forwardedFor?: string; cookie?: string } = {},
  ): Promise<Answer> {
    const headers: Record<string, string> = {};
    const jar = options.cookie ?? [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    if (jar !== "") headers.cookie = jar;
    if (method === "POST") {
      const origin = options.origin === undefined ? this.base : options.origin;
      if (origin !== null) headers.origin = origin;
      const csrf = options.csrf === undefined ? this.csrf : options.csrf;
      if (csrf !== null) headers["x-mend-csrf"] = csrf;
    }
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.forwardedFor !== undefined) headers["x-forwarded-for"] = options.forwardedFor;
    const response = await fetch(new URL(route, this.base), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "manual",
    });
    const text = await response.text();
    const setCookies = response.headers.getSetCookie();
    const visibleHeaders = [...response.headers].filter(([name]) => name !== "set-cookie").map(([name, value]) => `${name}: ${value}`);
    responseText.push(text, ...visibleHeaders);
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (/Max-Age=0\b/.test(cookie) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
      if (name === "mend_session" && value !== "") this.issuedTokens.push(value);
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (typeof body.csrf === "string") this.csrf = body.csrf;
    return { status: response.status, body, text, setCookies, headers: response.headers };
  }

  get token(): string {
    return this.cookies.get("mend_session") ?? "";
  }
}

async function bridgeCall(bridgeUrl: string, token: string, task: string, args: unknown[]): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(`/tasks/${task}`, bridgeUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "x-mend-bridge-token": token },
    body: JSON.stringify({ args }),
  });
  const text = await response.text();
  responseText.push(text);
  return JSON.parse(text) as Record<string, unknown>;
}

function genericRefusal(answer: Answer, error: string): boolean {
  const keys = Object.keys(answer.body).sort().join(",");
  return keys === "error,message,ref" && answer.body.error === error && /^[0-9a-f-]{36}$/.test(String(answer.body.ref));
}

async function main(): Promise<void> {
  const env = readEnv();
  const clientId = env.PAYPAL_CLIENT_ID ?? "";
  const clientSecret = env.PAYPAL_CLIENT_SECRET ?? "";
  const ownerPassword = env.MEND_OWNER_PASSWORD ?? "";
  if (clientId === "" || clientSecret === "") throw new ProofFailed("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be in .env");
  if (ownerPassword.length < 16) throw new ProofFailed("MEND_OWNER_PASSWORD must be in .env, at least 16 characters");

  const database = await holdDevDatabase();
  onCleanup("release the dev database", () => database.release());
  const db = new pg.Client({ connectionString: database.url });
  await db.connect();
  onCleanup("close the proof's database connection", () => db.end());

  const schema = `m7a_proof_${Date.now()}`;
  const quoted = db.escapeIdentifier(schema);
  await db.query(`create schema ${quoted}`);
  onCleanup("drop the proof schema", async () => {
    await db.query(`drop schema if exists ${quoted} cascade`);
  });
  await db.query(`set search_path to ${quoted}`);
  await db.query(readFileSync(SCHEMA_PATH, "utf8"));
  // The demo shop's records and members, copied so nothing this proof does touches the shared schema.
  await db.query("insert into shop_customers (customer_ref, display_name, email, country) select customer_ref, display_name, email, country from public.shop_customers");
  await db.query("insert into shop_orders (order_ref, customer_ref, ordered_at, total_minor, currency) select order_ref, customer_ref, ordered_at, total_minor, currency from public.shop_orders");
  await db.query("insert into shop_refunds (refund_ref, customer_ref, refunded_at, amount_minor) select refund_ref, customer_ref, refunded_at, amount_minor from public.shop_refunds");
  await db.query(
    `insert into members (member_id, paypal_email, paypal_payer_id, email_verified, consent_version, consent_text_sha256, client_id, joined_at)
     select member_id, paypal_email, paypal_payer_id, email_verified, consent_version, consent_text_sha256, client_id, joined_at from public.members`,
  );
  const copied = (await db.query<{ orders: number; members: number }>("select (select count(*)::int from shop_orders) as orders, (select count(*)::int from members) as members")).rows[0];
  if (copied.orders === 0 || copied.members < 2) throw new ProofFailed("the dev database has no demo shop; run prove_m2 and prove_m4a in packages/engine first");
  line(true, `database: throwaway schema ${schema} with the demo shop copied in (${copied.orders} orders, ${copied.members} members)`);

  // Percent-encoded by hand: libpq, which the engine uses, does not read "+" as a space.
  const schemaUrl = new URL(`${database.url}${database.url.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`);
  const bridgeToken = randomBytes(32).toString("base64url");
  const bridge = await startBridge({
    PAYPAL_ENV: "sandbox",
    PAYPAL_CLIENT_ID: clientId,
    PAYPAL_CLIENT_SECRET: clientSecret,
    MEND_DEV: "1",
    DATABASE_URL: schemaUrl.href,
    MEND_BRIDGE_TOKEN: bridgeToken,
  });
  line(true, `bridge: dev bridge listening on ${bridge.url} (127.0.0.1 only, token required)`);

  build();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const appEnv: Record<string, string> = {
    PAYPAL_ENV: "sandbox",
    PAYPAL_CLIENT_ID: clientId,
    PAYPAL_CLIENT_SECRET: clientSecret,
    PAYPAL_WEBHOOK_ID: UNUSED_WEBHOOK_ID,
    DATABASE_URL: schemaUrl.href,
    MEND_DEV: "1",
    MEND_BASE_URL: base,
    MEND_OWNER_PASSWORD: ownerPassword,
    MEND_CSRF_SECRET: randomBytes(32).toString("base64url"),
    MEND_BRIDGE_URL: bridge.url,
    MEND_BRIDGE_TOKEN: bridgeToken,
    MEND_WORKFLOW_SLUG: "mend-engine",
  };
  await startServer(port, appEnv);
  line(true, `server: next start on ${base}, engine tasks through the dev bridge, no RENDER_API_KEY set`);

  const campaigns = async (): Promise<number> => (await db.query<{ n: number }>("select count(*)::int as n from campaigns")).rows[0].n;

  // Demo session.
  const first = new Browser(base);
  const opened = await first.send("GET", "/api/session");
  const demo = await first.send("POST", "/api/session/demo");
  const demoCookie = demo.setCookies.find((cookie) => cookie.startsWith("mend_session=")) ?? "";
  const cookieShape = /^mend_session=s1\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=86400; HttpOnly; SameSite=Lax$/.test(demoCookie);
  const firstToken = first.token;
  const firstRow = await db.query("select role from sessions where session_id = $1", [sha256(firstToken)]);
  const tokenStored = await db.query("select 1 from sessions where session_id = $1 union all select 1 from campaign_owners where session_id = $1", [firstToken]);
  line(
    opened.status === 200 && opened.body.signedIn === false && demo.status === 200 && demo.body.role === "demo" && cookieShape && firstRow.rows[0]?.role === "demo" && tokenStored.rowCount === 0,
    "demo session: created; cookie is s1.-prefixed, HttpOnly, SameSite=Lax",
  );

  // Owner sign-in, starting from a demo session so rotation shows.
  const owner = new Browser(base);
  await owner.send("GET", "/api/session");
  await owner.send("POST", "/api/session/demo");
  const before = owner.token;
  const wrong = await owner.send("POST", "/api/session/owner", { body: { password: `${ownerPassword}x` } });
  const stillDemo = owner.token === before;
  const right = await owner.send("POST", "/api/session/owner", { body: { password: ownerPassword } });
  const after = owner.token;
  const oldToken = await owner.send("GET", "/api/session", { cookie: `mend_session=${before}` });
  const rows = await db.query<{ session_id: string; role: string }>("select session_id, role from sessions where session_id = any($1)", [[sha256(before), sha256(after)]]);
  line(
    wrong.status === 401 &&
      genericRefusal(wrong, "sign_in_refused") &&
      stillDemo &&
      right.status === 200 &&
      right.body.role === "owner" &&
      after !== before &&
      /^s1\.[A-Za-z0-9_-]{43}$/.test(after) &&
      oldToken.body.signedIn === false &&
      rows.rows.length === 1 &&
      rows.rows[0].session_id === sha256(after) &&
      rows.rows[0].role === "owner",
    "owner sign-in: wrong password refused; right password gives an owner session; the session id rotated",
  );

  // A demo draft through the engine.
  const bridgeLinesBefore = (bridgeOutput.match(/"kind": "dev_bridge", "status": 200, "task": "draft_campaign"/g) ?? []).length;
  const draftStarted = Date.now();
  const drafted = await first.send("POST", "/api/campaigns", { body: DEMO_DRAFT });
  const draftMs = Date.now() - draftStarted;
  const campaignId = String(drafted.body.campaignId ?? "");
  const ownerRow = await db.query<{ role: string; session_id: string }>("select role, session_id from campaign_owners where campaign_id::text = $1", [campaignId]);
  const amounts = await db.query<{ amount_minor: number }>("select amount_minor from campaign_members where campaign_id::text = $1 and role = 'reward'", [campaignId]);
  const bridgeLinesAfter = (bridgeOutput.match(/"kind": "dev_bridge", "status": 200, "task": "draft_campaign"/g) ?? []).length;
  line(
    drafted.status === 201 &&
      Number(drafted.body.totalMinor) > 0 &&
      Number(drafted.body.totalMinor) <= 100 &&
      ownerRow.rows[0]?.role === "demo" &&
      ownerRow.rows[0]?.session_id === sha256(firstToken) &&
      amounts.rows.length > 0 &&
      amounts.rows.every((row) => row.amount_minor <= 10) &&
      bridgeLinesAfter === bridgeLinesBefore + 1,
    `draft: a demo session drafted a campaign through the engine task (bridge), under demo caps (${String(drafted.body.rewarded)} rewarded, ${String(drafted.body.totalMinor)} cents)`,
  );

  // Demo caps.
  const campaignsBefore = await campaigns();
  const overCap = await first.send("POST", "/api/campaigns", { body: { ...DEMO_DRAFT, budgetMinor: 101 } });
  line(
    overCap.status === 422 && genericRefusal(overCap, "budget_over_cap") && (await campaigns()) === campaignsBefore,
    "demo caps: a demo draft over 100 cents is refused",
  );

  // Isolation.
  const second = new Browser(base);
  await second.send("GET", "/api/session");
  await second.send("POST", "/api/session/demo");
  const viewStarted = Date.now();
  const own = await first.send("GET", `/api/campaigns/${campaignId}`);
  const viewMs = Date.now() - viewStarted;
  const reviewHash = String(own.body.reviewHash ?? "");
  const foreign = await second.send("GET", `/api/campaigns/${campaignId}`);
  const missing = await second.send("GET", `/api/campaigns/${randomUUID()}`);
  const approveAsSecond = await bridgeCall(bridge.url, bridgeToken, "approve_campaign", [campaignId, { role: "demo", session: sha256(second.token) }, reviewHash]);
  const untouched = await db.query("select status from campaigns where campaign_id::text = $1", [campaignId]);
  const notApproved = await db.query("select 1 from approved_snapshots where campaign_id::text = $1", [campaignId]);
  const approveAsFirst = await bridgeCall(bridge.url, bridgeToken, "approve_campaign", [campaignId, { role: "demo", session: sha256(firstToken) }, reviewHash]);
  line(
    own.status === 200 &&
      /^[0-9a-f]{64}$/.test(reviewHash) &&
      foreign.status === 404 &&
      genericRefusal(foreign, "not_found") &&
      genericRefusal(missing, "not_found") &&
      !foreign.text.includes(DEMO_DRAFT.goalText) &&
      !foreign.text.includes(reviewHash) &&
      !/"R1"/.test(foreign.text) &&
      approveAsSecond.ok === false &&
      approveAsSecond.error === "not_found" &&
      Object.keys(approveAsSecond).sort().join(",") === "error,ok,ref" &&
      untouched.rows[0]?.status === "draft" &&
      notApproved.rowCount === 0 &&
      approveAsFirst.ok === true,
    "isolation: a second demo session cannot view or approve the first one's campaign (404 or 403, nothing leaked)",
  );

  // Permissions, checked in this process against the same database the server uses.
  process.env.PAYPAL_ENV = "sandbox";
  process.env.PAYPAL_CLIENT_ID = clientId;
  process.env.PAYPAL_CLIENT_SECRET = clientSecret;
  process.env.PAYPAL_WEBHOOK_ID = UNUSED_WEBHOOK_ID;
  process.env.DATABASE_URL = schemaUrl.href;
  process.env.MEND_DEV = "1";
  process.env.MEND_BASE_URL = base;
  process.env.MEND_CSRF_SECRET = appEnv.MEND_CSRF_SECRET;
  onCleanup("close the in-process database pool", () => closeDatabase());
  const roles: PrincipalRole[] = ["anonymous", "demo", "owner"];
  const unknownActions = ["admin.users", "admin.credentials", "admin.caps", "campaign.delete", "webhooks.change", "", "__proto__", "constructor", "toString"];
  const unknownDenied = unknownActions.every((action) => roles.every((role) => !isAllowed(action, role)));
  const jobs: Action[] = ["admin.events", "admin.reconcile", "admin.purge"];
  const asCookie = (token: string) => new Request(`${base}/api/x`, { headers: { cookie: `mend_session=${token}` } });
  const demoDenied = await Promise.all(jobs.map((action) => authorize(action, asCookie(firstToken))));
  const ownerAllowed = await Promise.all(jobs.map((action) => authorize(action, asCookie(after))));
  const unknownLive = await authorize("admin.users" as Action, asCookie(after));
  line(
    unknownDenied &&
      jobs.every((action) => !isAllowed(action, "demo") && !isAllowed(action, "anonymous")) &&
      demoDenied.every((result) => !result.ok && result.status === 403) &&
      ownerAllowed.every((result) => result.ok) &&
      !unknownLive.ok &&
      ACTIONS.length === 19,
    "permissions: every action not in the table is denied; demo is denied admin.events, admin.reconcile and admin.purge",
  );

  // CSRF.
  const beforeCsrf = await campaigns();
  const foreignOrigin = await first.send("POST", "/api/campaigns", { body: DEMO_DRAFT, origin: "https://evil.example" });
  const noToken = await first.send("POST", "/api/campaigns", { body: DEMO_DRAFT, csrf: null });
  const noOrigin = await first.send("POST", "/api/campaigns", { body: DEMO_DRAFT, origin: null });
  line(
    foreignOrigin.status === 403 &&
      genericRefusal(foreignOrigin, "csrf_refused") &&
      noToken.status === 403 &&
      genericRefusal(noToken, "csrf_refused") &&
      noOrigin.status === 403 &&
      (await campaigns()) === beforeCsrf &&
      serverOutput.includes('"reason":"foreign_origin"') &&
      serverOutput.includes('"reason":"missing_token"'),
    "csrf: a POST with a foreign Origin, and one without the token, are refused",
  );

  // Rate limit on owner sign-in, from one address as Render's proxy would report it.
  const visitor = new Browser(base);
  await visitor.send("GET", "/api/session");
  const attempts: number[] = [];
  for (let n = 0; n < 11; n += 1) {
    attempts.push((await visitor.send("POST", "/api/session/owner", { body: { password: "not-the-password" }, forwardedFor: "198.51.100.23" })).status);
  }
  const eleventh = attempts[10];
  const prepended = await visitor.send("POST", "/api/session/owner", { body: { password: "not-the-password" }, forwardedFor: "203.0.113.50, 198.51.100.23" });
  const otherAddress = await visitor.send("POST", "/api/session/owner", { body: { password: "not-the-password" }, forwardedFor: "198.51.100.24" });
  line(
    attempts.slice(0, 10).every((status) => status === 401) &&
      eleventh === 429 &&
      prepended.status === 429 &&
      Number(prepended.headers.get("retry-after")) > 0 &&
      otherAddress.status === 401,
    "rate limit: the 11th owner sign-in from one IP in 15 minutes is refused",
  );

  // A forced engine failure: a column the view needs is renamed under the engine.
  await db.query("alter table campaign_owners rename column session_id to session_id_moved");
  let broken: Answer;
  try {
    broken = await first.send("GET", `/api/campaigns/${campaignId}`);
  } finally {
    await db.query("alter table campaign_owners rename column session_id_moved to session_id");
  }
  const brokenRef = String(broken.body.ref ?? "");
  const engineLogged = bridgeOutput
    .split(/\r?\n/)
    .some((entry) => entry.includes(`"ref": "${brokenRef}"`) && entry.includes('"outcome": "failed"') && entry.includes("UndefinedColumn"));
  line(
    broken.status === 500 && genericRefusal(broken, "internal") && broken.body.message === "Something went wrong." && !LEAK_SHAPES.test(broken.text) && engineLogged,
    "errors: a forced engine failure returns a generic message and a ref, no stack or SQL",
  );

  // Secrets.
  const tokens = [...first.issuedTokens, ...owner.issuedTokens, ...second.issuedTokens, ...visitor.issuedTokens];
  const sessionIds = tokens.map(sha256);
  const audit = (await db.query<{ text: string }>("select coalesce(string_agg(detail::text || ' ' || actor, ' '), '') as text from audit_log")).rows[0].text;
  const haystacks = [serverOutput, bridgeOutput, ...responseText];
  const needles = [ownerPassword, clientSecret, bridgeToken, ...tokens, ...sessionIds].filter((needle) => needle.length >= 16);
  const leaked = needles.some((needle) => haystacks.some((text) => text.includes(needle)) || audit.includes(needle));
  line(
    tokens.length >= 4 && !leaked,
    "secrets: MEND_OWNER_PASSWORD, the PayPal secret and session ids never appear in logs or responses",
  );
  line(true, `timing: a demo draft took ${draftMs} ms and a view ${viewMs} ms through the bridge, each one task run`);
}

let finished = false;

async function finish(code: number): Promise<never> {
  if (!finished) {
    finished = true;
    await cleanUp();
    console.log(`M7A RESULT: ${allPassed && code === 0 ? "PASS" : "FAIL"}`);
  }
  process.exit(allPassed && code === 0 ? 0 : 1);
}

process.once("SIGINT", () => {
  line(false, "interrupted");
  void finish(130);
});

main().then(
  () => finish(0),
  (error: unknown) => {
    line(false, error instanceof Error ? error.message : "unexpected failure");
    return finish(1);
  },
);
