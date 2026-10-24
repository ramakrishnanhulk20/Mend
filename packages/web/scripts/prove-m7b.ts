/**
 * M7b proof: the rest of the console API end to end, against the local database and the
 * live PayPal sandbox. Starts the engine's dev bridge and a production build of the web
 * app, both pointed at a throwaway schema holding a copy of the demo shop and the stored
 * model facts, then drives the real routes over HTTP the way a browser would: the public
 * summary, quiet regulars, a demo session's whole journey from draft to a real Payouts
 * batch, a simulated return purchase, results, run polling, CSRF across sessions, cookie
 * names, the admin jobs and the campaign owners guard.
 *
 * Run from packages/web: npm run prove:m7b. Prints PASS or FAIL per line and ends with
 * "M7B RESULT: PASS" only if every line passed. Moves real sandbox money: one demo batch
 * of at most 100 cents (PayPal adds its sandbox fee per item) and one 12.50 USD test-card
 * purchase into the shop. Always stops the server and the bridge, drops the schemas and
 * releases the database, even on failure. MEND_CSRF_SECRET is generated for this run only.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import pg from "pg";
import { cookieHeader, sessionCookieName } from "../src/server/auth";
import { anonymousCsrfCookieName } from "../src/server/csrf";
import { ENGINE_DIR, holdDevDatabase, SCHEMA_PATH } from "./dev-database";

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.resolve(WEB_DIR, "..", "..", ".env");
const NEXT_BIN = path.join(WEB_DIR, "node_modules", "next", "dist", "bin", "next");
const DIST_DIR = ".next-verify";
const PYTHON = path.join(ENGINE_DIR, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
// The web config needs a webhook id to load; this proof registers no webhook.
const UNUSED_WEBHOOK_ID = "M7BPROOFNOWEBHOOK";
// Every eligible member is a candidate, so the sandbox test receiver can be drawn into
// the rewarded half; the demo caps keep the batch at 100 cents or less.
const DEMO_DRAFT = {
  goalText: "Bring back our quiet regulars with a small thank-you",
  asOf: "2026-10-16",
  budgetMinor: 100,
  perRecipientMinor: 10,
  holdoutShare: "0.50",
  maxCandidates: 40,
};
// The holdout is a fresh random draw for every draft (C6), so the test receiver is held
// back about half the time; such drafts are left unapproved and another is drawn.
const MAX_DRAWS = 12;
const DRAFTS_PER_DEMO_SESSION = 5;
const DEMO_TOTAL_CAP_MINOR = 100;
const DEMO_ITEM_CAP_MINOR = 10;
// The UK clock as a POSIX rule: the local pgserver has no time zone database, and a
// rule worked out in SQL is a check independent of the engine's zoneinfo.
const LONDON_RULE = "GMT0BST,M3.5.0/1,M10.5.0";
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const CUSTOMER_REF = /\bC\d{4,6}\b/;

class ProofFailed extends Error {}

let allPassed = true;

function line(passed: boolean, text: string): void {
  if (!passed) allPassed = false;
  console.log(`${passed ? "PASS" : "FAIL"}  ${text}`);
}

function note(text: string): void {
  console.log(`      ${text}`);
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
  for (const name of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "MEND_OWNER_PASSWORD", "MEND_TEST_RECEIVER"]) {
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

async function startBridge(env: Record<string, string>): Promise<string> {
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
  return `http://127.0.0.1:${port}`;
}

async function startServer(port: number, env: Record<string, string>): Promise<void> {
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
}

type Body = Record<string, unknown>;
type Answer = { readonly status: number; readonly body: Body; readonly text: string; readonly setCookies: string[] };
type SendOptions = { body?: unknown; origin?: string | null; csrf?: string | null; prefer?: string };

/** One browser: a cookie jar and the CSRF token its pages would hold. Every answer is kept for the secrets check. */
class Browser {
  readonly cookies = new Map<string, string>();
  csrf = "";
  readonly issuedTokens: string[] = [];

  constructor(private readonly base: string) {}

  async send(method: "GET" | "POST", route: string, options: SendOptions = {}): Promise<Answer> {
    const headers: Record<string, string> = {};
    const jar = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    if (jar !== "") headers.cookie = jar;
    if (method === "POST") {
      const origin = options.origin === undefined ? this.base : options.origin;
      if (origin !== null) headers.origin = origin;
      const csrf = options.csrf === undefined ? this.csrf : options.csrf;
      if (csrf !== null && csrf !== "") headers["x-mend-csrf"] = csrf;
    }
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.prefer !== undefined) headers.prefer = options.prefer;
    const response = await fetch(new URL(route, this.base), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "manual",
    });
    const text = await response.text();
    const setCookies = response.headers.getSetCookie();
    responseText.push(text, ...[...response.headers].filter(([name]) => name !== "set-cookie").map(([name, value]) => `${name}: ${value}`));
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (/Max-Age=0\b/.test(cookie) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
      if (name.endsWith("mend_session") && value !== "") this.issuedTokens.push(value);
    }
    let body: Body = {};
    try {
      body = JSON.parse(text) as Body;
    } catch {
      body = {};
    }
    if (typeof body.csrf === "string") this.csrf = body.csrf;
    return { status: response.status, body, text, setCookies };
  }

  get token(): string {
    return this.cookies.get("mend_session") ?? "";
  }

  get sessionId(): string {
    return sha256(this.token);
  }

  /** A 202 is polled at /api/runs/[runId] until it finishes; anything else comes back as it is. */
  async settle(answer: Answer, timeoutMs = 180_000): Promise<Answer> {
    if (answer.status !== 202) return answer;
    const runId = String(answer.body.runId ?? "");
    return waitFor(`run ${runId}`, timeoutMs, 1_000, async () => {
      const polled = await this.send("GET", `/api/runs/${runId}`);
      return polled.status === 202 ? null : polled;
    });
  }
}

async function signIn(base: string, kind: "demo" | "owner", password = ""): Promise<Browser> {
  const browser = new Browser(base);
  await browser.send("GET", "/api/session");
  const answer = await browser.send("POST", `/api/session/${kind}`, kind === "owner" ? { body: { password } } : {});
  if (answer.status !== 200) throw new ProofFailed(`${kind} sign-in answered ${answer.status}`);
  return browser;
}

function refusal(answer: Answer, status: number, error: string): boolean {
  return answer.status === status && Object.keys(answer.body).sort().join(",") === "error,message,ref" && answer.body.error === error;
}

async function concurrentApplies(url: string, fresh: boolean): Promise<string[]> {
  const text = readFileSync(SCHEMA_PATH, "utf8");
  const name = `m7b_apply_${Date.now()}_${fresh ? "fresh" : "applied"}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const quoted = admin.escapeIdentifier(name);
  await admin.query(`create schema ${quoted}`);
  const clients: pg.Client[] = [];
  try {
    if (!fresh) {
      await admin.query(`set search_path to ${quoted}`);
      await admin.query(text);
    }
    const schemaUrl = `${url}${url.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${name}`)}`;
    for (let n = 0; n < 6; n += 1) {
      const client = new pg.Client({ connectionString: schemaUrl });
      await client.connect();
      clients.push(client);
    }
    // Sent together, each as one statement batch: one implicit transaction per client.
    const settled = await Promise.allSettled(clients.map((client) => client.query(text)));
    return settled.map((result) => (result.status === "fulfilled" ? "ok" : String((result.reason as { code?: string }).code ?? "error")));
  } finally {
    await Promise.all(clients.map((client) => client.end()));
    await admin.query(`drop schema if exists ${quoted} cascade`);
    await admin.end();
  }
}

async function main(): Promise<void> {
  const env = readEnv();
  const clientId = env.PAYPAL_CLIENT_ID ?? "";
  const clientSecret = env.PAYPAL_CLIENT_SECRET ?? "";
  const ownerPassword = env.MEND_OWNER_PASSWORD ?? "";
  const receiver = (env.MEND_TEST_RECEIVER ?? "").trim().toLowerCase();
  if (clientId === "" || clientSecret === "") throw new ProofFailed("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be in .env");
  if (ownerPassword.length < 16) throw new ProofFailed("MEND_OWNER_PASSWORD must be in .env, at least 16 characters");
  if (!receiver.includes("@")) throw new ProofFailed("MEND_TEST_RECEIVER must be in .env");

  const database = await holdDevDatabase();
  onCleanup("release the dev database", () => database.release());
  const db = new pg.Client({ connectionString: database.url });
  await db.connect();
  onCleanup("close the proof's database connection", () => db.end());

  // 1. Six concurrent schema applies, on an empty schema and on an applied one.
  const appliedFresh = await concurrentApplies(database.url, true);
  const appliedAgain = await concurrentApplies(database.url, false);
  line(
    [...appliedFresh, ...appliedAgain].every((outcome) => outcome === "ok"),
    `schema: six concurrent applies all succeeded (empty schema: ${appliedFresh.join(" ")}; applied schema: ${appliedAgain.join(" ")})`,
  );

  const schema = `m7b_proof_${Date.now()}`;
  const quoted = db.escapeIdentifier(schema);
  await db.query(`create schema ${quoted}`);
  onCleanup("drop the proof schema", async () => {
    await db.query(`drop schema if exists ${quoted} cascade`);
  });
  await db.query(`set search_path to ${quoted}`);
  await db.query(readFileSync(SCHEMA_PATH, "utf8"));
  // The demo shop, its members and the stored model facts, copied so nothing this proof does touches the shared schema.
  await db.query("insert into shop_customers (customer_ref, display_name, email, country) select customer_ref, display_name, email, country from public.shop_customers");
  await db.query("insert into shop_orders (order_ref, customer_ref, ordered_at, total_minor, currency) select order_ref, customer_ref, ordered_at, total_minor, currency from public.shop_orders");
  await db.query("insert into shop_refunds (refund_ref, customer_ref, refunded_at, amount_minor) select refund_ref, customer_ref, refunded_at, amount_minor from public.shop_refunds");
  await db.query(
    `insert into members (member_id, paypal_email, paypal_payer_id, email_verified, consent_version, consent_text_sha256, client_id, joined_at)
     select member_id, paypal_email, paypal_payer_id, email_verified, consent_version, consent_text_sha256, client_id, joined_at from public.members`,
  );
  await db.query("insert into model_facts (key, value, computed_at) select key, value, computed_at from public.model_facts");
  const copied = (
    await db.query<{ orders: number; members: number; facts: number; receiver: number }>(
      "select (select count(*)::int from shop_orders) as orders, (select count(*)::int from members) as members, (select count(*)::int from model_facts) as facts, (select count(*)::int from members where paypal_email = $1) as receiver",
      [receiver],
    )
  ).rows[0];
  if (copied.orders === 0 || copied.members < 2) throw new ProofFailed("the dev database has no demo shop; run prove_m2 and prove_m4a in packages/engine first");
  if (copied.facts < 2) throw new ProofFailed("no stored model facts; run python -m mend_engine.store_facts in packages/engine first");
  if (copied.receiver !== 1) throw new ProofFailed("the sandbox test receiver is not a member; run prove_m4b in packages/engine first");
  note(`database: throwaway schema ${schema} with the demo shop copied in (${copied.orders} orders, ${copied.members} members, ${copied.facts} model facts)`);

  // Percent-encoded by hand: libpq, which the engine uses, does not read "+" as a space.
  const schemaUrl = new URL(`${database.url}${database.url.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`);
  const bridgeToken = randomBytes(32).toString("base64url");
  const csrfSecret = randomBytes(32).toString("base64url");
  const bridgeUrl = await startBridge({
    PAYPAL_ENV: "sandbox",
    PAYPAL_CLIENT_ID: clientId,
    PAYPAL_CLIENT_SECRET: clientSecret,
    MEND_DEV: "1",
    DATABASE_URL: schemaUrl.href,
    MEND_BRIDGE_TOKEN: bridgeToken,
  });
  build();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  await startServer(port, {
    PAYPAL_ENV: "sandbox",
    PAYPAL_CLIENT_ID: clientId,
    PAYPAL_CLIENT_SECRET: clientSecret,
    PAYPAL_WEBHOOK_ID: UNUSED_WEBHOOK_ID,
    DATABASE_URL: schemaUrl.href,
    MEND_DEV: "1",
    MEND_BASE_URL: base,
    MEND_OWNER_PASSWORD: ownerPassword,
    MEND_CSRF_SECRET: csrfSecret,
    MEND_BRIDGE_URL: bridgeUrl,
    MEND_BRIDGE_TOKEN: bridgeToken,
    MEND_WORKFLOW_SLUG: "mend-engine",
  });
  note(`server: next start on ${base}, engine tasks through the dev bridge on ${bridgeUrl}, live PayPal sandbox`);

  // 2. The public summary against a direct read of the same tables.
  const visitor = new Browser(base);
  const summary = await visitor.send("GET", "/api/shop/summary");
  const direct = (
    await db.query<{ as_of: string; customers: number; members: number; quiet: number; paid: string }>(
      `with days as (
         select customer_ref, (ordered_at at time zone '${LONDON_RULE}')::date as day from shop_orders where currency = 'USD'
       ), per as (
         select customer_ref, count(distinct day) as n, max(day) as last from days group by customer_ref
       ), a as (select max(day) as as_of from days),
       quiet as (select customer_ref from per, a where n >= 3 and a.as_of - last >= 60),
       paid as (
         select customer_ref, sum(total_minor) as total from shop_orders, a
          where currency = 'USD' and (ordered_at at time zone '${LONDON_RULE}')::date > (a.as_of - interval '1 year')::date
            and (ordered_at at time zone '${LONDON_RULE}')::date <= a.as_of group by customer_ref
       ), refunded as (
         select customer_ref, sum(amount_minor) as total from shop_refunds, a
          where (refunded_at at time zone '${LONDON_RULE}')::date > (a.as_of - interval '1 year')::date
            and (refunded_at at time zone '${LONDON_RULE}')::date <= a.as_of group by customer_ref
       )
       select (select as_of::text from a) as as_of,
              (select count(*)::int from shop_customers) as customers,
              (select count(*)::int from members) as members,
              (select count(*)::int from quiet) as quiet,
              (select coalesce(sum(greatest(p.total - coalesce(r.total, 0), 0)), 0)::text
                 from paid p join quiet q using (customer_ref) left join refunded r using (customer_ref)) as paid`,
    )
  ).rows[0];
  const storedGain = (await db.query<{ gain: number }>("select (value ->> 'mean_auc_gain')::float8 as gain from model_facts where key = 'uci_backtest'")).rows[0]?.gain;
  const backtest = summary.body.backtest as Body | null;
  const benchmark = summary.body.benchmark as Body | null;
  line(
    summary.status === 200 &&
      visitor.cookies.size === 0 &&
      summary.body.asOf === direct.as_of &&
      summary.body.shopCustomers === direct.customers &&
      summary.body.members === direct.members &&
      summary.body.quietRegulars === direct.quiet &&
      summary.body.quietRegularsPaid12mMinor === Number(direct.paid) &&
      backtest !== null &&
      benchmark !== null &&
      backtest.passed === true &&
      benchmark.passed === true &&
      backtest.meanAucGain === storedGain &&
      !summary.text.includes("@") &&
      !UUID_ANYWHERE.test(summary.text),
    "summary: public summary served without a session; numbers match a direct database read; backtest facts present",
  );
  note(
    `as of ${String(summary.body.asOf)}: ${String(summary.body.shopCustomers)} customers, ${String(summary.body.members)} members, ${String(summary.body.quietRegulars)} quiet regulars who paid ${(Number(summary.body.quietRegularsPaid12mMinor) / 100).toFixed(2)} USD in 12 months (direct read ${direct.quiet} and ${(Number(direct.paid) / 100).toFixed(2)}); model beats recency at ${String(backtest?.modelWins)} of ${String(backtest?.converged)} cutoffs, CDNOW reproduction passed ${String(benchmark?.passed)}`,
  );

  // 3. Quiet regulars for a demo session.
  const demo = await signIn(base, "demo");
  const quiet = await demo.settle(await demo.send("GET", "/api/shop/quiet-regulars?limit=50"));
  const rows = (quiet.body.rows ?? []) as Body[];
  const memberIds = (await db.query<{ member_id: string }>("select member_id::text from members")).rows.map((row) => row.member_id);
  const rowKeys = ["daysSilent", "displayName", "member", "paidNetMinor", "position", "purchaseDays", "score"].join(",");
  const anonymousList = await visitor.send("GET", "/api/shop/quiet-regulars?limit=50");
  line(
    quiet.status === 200 &&
      rows.length === Math.min(50, direct.quiet) &&
      rows.length <= 50 &&
      quiet.body.total === direct.quiet &&
      rows.every((row) => Object.keys(row).sort().join(",") === rowKeys) &&
      !quiet.text.includes("@") &&
      !UUID_ANYWHERE.test(quiet.text) &&
      !CUSTOMER_REF.test(quiet.text) &&
      !memberIds.some((id) => quiet.text.includes(id)) &&
      anonymousList.status === 401,
    "quiet regulars: demo session sees up to 50 rows, no email, member id or customer ref",
  );
  note(`${rows.length} of ${String(quiet.body.total)} rows; most at risk: ${String(rows[0]?.displayName)}, ${String(rows[0]?.purchaseDays)} purchase days, ${String(rows[0]?.daysSilent)} days silent`);

  // 4 and 5. The journey: drafts until the test receiver is rewarded, view, a wrong hash, approve, submit.
  const receiverMember = (await db.query<{ member_id: string }>("select member_id::text from members where paypal_email = $1", [receiver])).rows[0].member_id;
  let journey = demo;
  let draftsInSession = 0;
  let campaignId = "";
  let draws = 0;
  while (draws < MAX_DRAWS) {
    if (draftsInSession === DRAFTS_PER_DEMO_SESSION) {
      journey = await signIn(base, "demo");
      draftsInSession = 0;
    }
    const drafted = await journey.settle(await journey.send("POST", "/api/campaigns", { body: DEMO_DRAFT }));
    draws += 1;
    draftsInSession += 1;
    if (drafted.status !== 201) throw new ProofFailed(`a demo draft answered ${drafted.status} ${drafted.text}`);
    const role = await db.query<{ role: string }>("select role from campaign_members where campaign_id::text = $1 and member_id::text = $2", [String(drafted.body.campaignId), receiverMember]);
    if (role.rows[0]?.role === "reward") {
      campaignId = String(drafted.body.campaignId);
      break;
    }
  }
  if (campaignId === "") throw new ProofFailed(`the test receiver was held back in all ${MAX_DRAWS} draws`);
  const view = await journey.settle(await journey.send("GET", `/api/campaigns/${campaignId}`));
  const reviewHash = String(view.body.reviewHash ?? "");
  const wrongHash = `${reviewHash.slice(0, 63)}${reviewHash.endsWith("0") ? "1" : "0"}`;
  const wrong = await journey.settle(await journey.send("POST", `/api/campaigns/${campaignId}/approve`, { body: { presentedHash: wrongHash } }));
  const afterWrong = await db.query<{ status: string }>("select status from campaigns where campaign_id::text = $1", [campaignId]);
  const snapshotsAfterWrong = await db.query("select 1 from approved_snapshots where campaign_id::text = $1", [campaignId]);
  const approved = await journey.settle(await journey.send("POST", `/api/campaigns/${campaignId}/approve`, { body: { presentedHash: reviewHash } }));
  const submitted = await journey.settle(await journey.send("POST", `/api/campaigns/${campaignId}/submit`));
  const frozen = await db.query<{ items: { receiver_email: string; amount_minor: number; sender_item_id: string }[] }>(
    "select (canonical_json::jsonb -> 'items') as items from approved_snapshots where campaign_id::text = $1",
    [campaignId],
  );
  const items = frozen.rows[0]?.items ?? [];
  const total = items.reduce((sum, item) => sum + item.amount_minor, 0);
  const ledger = await db.query<{ payout_batch_id: string | null }>("select payout_batch_id from payout_batches where campaign_id = $1", [campaignId]);
  const payoutBatchId = String(submitted.body.payoutBatchId ?? "");
  line(
    view.status === 200 &&
      /^[0-9a-f]{64}$/.test(reviewHash) &&
      approved.status === 200 &&
      approved.body.snapshotHash === reviewHash &&
      submitted.status === 200 &&
      submitted.body.status === "submitted" &&
      submitted.body.sent === true &&
      /^[A-Z0-9]+$/.test(payoutBatchId) &&
      ledger.rows.length === 1 &&
      ledger.rows[0].payout_batch_id === payoutBatchId &&
      total > 0 &&
      total <= DEMO_TOTAL_CAP_MINOR &&
      items.every((item) => item.amount_minor <= DEMO_ITEM_CAP_MINOR) &&
      items.some((item) => item.receiver_email === receiver),
    "journey: a demo session drafted, viewed (hash shown), approved with that hash, submitted, and PayPal accepted the batch",
  );
  note(`campaign ${campaignId} on draw ${draws}; batch ${payoutBatchId}: ${items.length} items, ${total} cents in total (cap ${DEMO_TOTAL_CAP_MINOR}), the test receiver among the rewarded`);
  line(
    refusal(wrong, 409, "hash_mismatch") && afterWrong.rows[0]?.status === "draft" && snapshotsAfterWrong.rowCount === 0,
    "wrong hash: approval with a different hash refused with 409",
  );

  // 6. A simulated return purchase by one rewarded member.
  const rewardedRef = ((view.body.rows ?? []) as Body[]).find((row) => row.role === "reward")?.ref;
  const bought = await journey.settle(await journey.send("POST", `/api/campaigns/${campaignId}/simulate`, { body: { ref: rewardedRef } }));
  const stored = await db.query<{ ref: string }>("select ref from simulated_orders where campaign_id::text = $1 and paypal_order_id = $2", [campaignId, String(bought.body.paypalOrderId ?? "")]);
  line(
    bought.status === 201 && bought.body.ref === rewardedRef && bought.body.paypalStatus === "COMPLETED" && stored.rows.length === 1 && stored.rows[0].ref === rewardedRef,
    "simulate: a return purchase created for one rewarded member",
  );
  note(`ref ${String(rewardedRef)}, PayPal order ${String(bought.body.paypalOrderId)} ${String(bought.body.paypalStatus)}, 12.50 USD by sandbox test card`);

  // 7. Results.
  const results = await journey.settle(await journey.send("GET", `/api/campaigns/${campaignId}/results`));
  const arms = (await db.query<{ role: string; n: number }>("select role, count(*)::int as n from campaign_members where campaign_id::text = $1 group by role", [campaignId])).rows;
  const armSize = (role: string) => arms.find((arm) => arm.role === role)?.n;
  const rewardedArm = results.body.rewarded as Body | undefined;
  const holdoutArm = results.body.holdout as Body | undefined;
  line(
    results.status === 200 &&
      rewardedArm?.members === armSize("reward") &&
      holdoutArm?.members === armSize("holdout") &&
      typeof results.body.verdict === "string" &&
      (results.body.verdict as string).length > 0,
    "results: rewarded and holdout counts and the verdict returned",
  );
  note(`rewarded ${String(rewardedArm?.members)}, held back ${String(holdoutArm?.members)}; verdict: ${String(results.body.verdict)}`);

  // 8. A run id from this session, polled by another.
  const other = await signIn(base, "demo");
  const owner = await signIn(base, "owner", ownerPassword);
  const started = await journey.send("GET", `/api/campaigns/${campaignId}/results`, { prefer: "respond-async" });
  const runId = String(started.body.runId ?? "");
  const foreignPoll = await other.send("GET", `/api/runs/${runId}`);
  const ownerPoll = await owner.send("GET", `/api/runs/${runId}`);
  const unknownPoll = await journey.send("GET", "/api/runs/brn-00000000-0000-4000-8000-000000000000");
  const anonymousPoll = await visitor.send("GET", `/api/runs/${runId}`);
  const ownPoll = await journey.settle(started);
  const runRow = await db.query<{ session_id_hash: string; task: string }>("select session_id_hash, task from run_owners where run_id = $1", [runId]);
  line(
    started.status === 202 &&
      refusal(foreignPoll, 404, "not_found") &&
      refusal(ownerPoll, 404, "not_found") &&
      refusal(unknownPoll, 404, "not_found") &&
      anonymousPoll.status === 401 &&
      ownPoll.status === 200 &&
      Object.keys(ownPoll.body).sort().join(",") === Object.keys(results.body).sort().join(",") &&
      runRow.rows[0]?.session_id_hash === journey.sessionId &&
      runRow.rows[0]?.task === "results",
    "runs: another session polling this session's run id gets 404",
  );

  // 9. A CSRF token from session A used in session B.
  const tokenA = journey.csrf;
  const crossed = await other.send("POST", `/api/campaigns/${campaignId}/approve`, { body: { presentedHash: reviewHash }, csrf: tokenA });
  const ownToken = await other.send("POST", `/api/campaigns/${campaignId}/approve`, { body: { presentedHash: reviewHash } });
  const reverse = await journey.send("POST", `/api/campaigns/${campaignId}/simulate`, { body: { ref: rewardedRef }, csrf: other.csrf });
  line(
    tokenA !== other.csrf &&
      refusal(crossed, 403, "csrf_refused") &&
      refusal(reverse, 403, "csrf_refused") &&
      refusal(ownToken, 404, "not_found") &&
      serverOutput.includes('"reason":"token_mismatch"'),
    "csrf: a token from session A is refused in session B",
  );

  // 10. Cookie names: what this http://127.0.0.1 server set, and the https rule in process.
  const localSession = demo.cookies.has("mend_session") && ![...demo.cookies.keys()].some((name) => name.startsWith("__Host-"));
  const localAnonymous = new Browser(base);
  const anonymousCookie = (await localAnonymous.send("GET", "/api/session")).setCookies[0] ?? "";
  const saved = { dev: process.env.MEND_DEV, base: process.env.MEND_BASE_URL };
  process.env.MEND_DEV = "0";
  process.env.MEND_BASE_URL = "https://mend.example";
  const secureName = sessionCookieName();
  const secureHeader = cookieHeader(secureName, "s1.value", 60);
  const secureAnonymous = anonymousCsrfCookieName();
  process.env.MEND_DEV = saved.dev;
  process.env.MEND_BASE_URL = saved.base;
  line(
    localSession &&
      /^mend_csrf=a1\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=86400; HttpOnly; SameSite=Lax$/.test(anonymousCookie) &&
      secureName === "__Host-mend_session" &&
      secureHeader === "__Host-mend_session=s1.value; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure" &&
      secureAnonymous === "__Host-mend_csrf",
    "cookies: __Host- prefix used when the base URL is https (unit-tested), plain name on localhost",
  );

  // 11. The admin jobs.
  const jobs = ["process-events", "reconcile", "purge"];
  const demoJobs = await Promise.all(jobs.map((job) => demo.send("POST", `/api/admin/${job}`)));
  const ownerJobs = [];
  for (const job of jobs) ownerJobs.push(await owner.settle(await owner.send("POST", `/api/admin/${job}`)));
  line(
    demoJobs.every((answer) => refusal(answer, 403, "not_allowed")) &&
      ownerJobs.every((answer) => answer.status === 200) &&
      typeof ownerJobs[0].body.ran === "boolean" &&
      typeof ownerJobs[1].body.lookedAt === "number" &&
      typeof ownerJobs[2].body.deleted === "number",
    "admin: demo refused on all three admin routes; owner allowed",
  );
  note(`owner: process-events ${ownerJobs[0].text}, reconcile ${ownerJobs[1].text}, purge ${ownerJobs[2].text}`);

  // 12. The campaign owners guard, straight at the database.
  const guardErrors: string[] = [];
  for (const statement of [
    "update campaign_owners set session_id = $2 where campaign_id::text = $1",
    "delete from campaign_owners where campaign_id::text = $1 and $2::text is not null",
  ]) {
    try {
      await db.query(statement, [campaignId, other.sessionId]);
      guardErrors.push("allowed");
    } catch (error) {
      guardErrors.push(error instanceof Error ? error.message : "refused");
    }
  }
  const ownerRow = await db.query<{ session_id: string }>("select session_id from campaign_owners where campaign_id::text = $1", [campaignId]);
  line(
    /campaign_owners: update refused/.test(guardErrors[0]) &&
      /campaign_owners: delete refused/.test(guardErrors[1]) &&
      ownerRow.rows.length === 1 &&
      ownerRow.rows[0].session_id === journey.sessionId,
    "owners guard: UPDATE on campaign_owners refused by the database",
  );

  // Secrets and identities: nothing a browser must not see reached a response or a log.
  const browsers = [visitor, demo, journey, other, owner, localAnonymous];
  const tokens = [...new Set(browsers.flatMap((browser) => browser.issuedTokens))];
  const audit = (await db.query<{ text: string }>("select coalesce(string_agg(detail::text || ' ' || actor, ' '), '') as text from audit_log")).rows[0].text;
  const needles: [string, string][] = [
    ["the owner password", ownerPassword],
    ["the PayPal secret", clientSecret],
    ["the bridge token", bridgeToken],
    ["the CSRF secret", csrfSecret],
    ...tokens.map((token): [string, string] => ["a session token", token]),
    ...tokens.map((token): [string, string] => ["a session id", sha256(token)]),
  ];
  const haystacks: [string, string][] = [
    ["the server log", serverOutput],
    ["the bridge log", bridgeOutput],
    ["the audit log", audit],
    ["a response", responseText.join("\n")],
  ];
  const leaks = needles.flatMap(([what, value]) => haystacks.filter(([, text]) => text.includes(value)).map(([where]) => `${what} in ${where}`));
  if (responseText.some((text) => text.includes(receiver))) leaks.push("the receiver's email in a response");
  // demo, other and owner always hold a session; journey may be demo's own.
  line(
    tokens.length >= 3 && needles.every(([, value]) => value.length >= 16) && leaks.length === 0,
    "secrets: passwords, keys, the CSRF secret, session tokens and ids, and the receiver's email never appear in responses or logs",
  );
  note(`searched for ${needles.length} values from ${tokens.length} sessions; found: ${leaks.join(", ") || "nothing"}`);
  note(`sandbox spend: one payout batch of ${total} cents in ${items.length} items (PayPal adds its sandbox fee per item), one 12.50 USD test-card purchase into the shop`);
}

let finished = false;

async function finish(code: number): Promise<never> {
  if (!finished) {
    finished = true;
    await cleanUp();
    console.log(`M7B RESULT: ${allPassed && code === 0 ? "PASS" : "FAIL"}`);
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
