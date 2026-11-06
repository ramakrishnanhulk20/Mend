/**
 * The demo console on this machine in one command, with real data and real sandbox payouts:
 *
 *   npm run dev:console [-- --port N]     (-p N works too; otherwise PORT; otherwise 3001)
 *
 * Holds the local Postgres (dev-database.ts) and keeps the demo shop in a schema of its
 * own, console_dev. The first run builds it with the engine's migrate and seed_demo, the
 * path a fresh clone takes: that imports the shop and measures the model, so it takes
 * minutes. Later runs reuse it. Then starts the engine's dev bridge and `next dev` on that
 * schema, and every 30 seconds runs what mend-jobs runs on Render (python -m
 * mend_engine.jobs all), so payout statuses move without a webhook reaching this machine.
 * Those runs wait 45 seconds, not 15 minutes, before reading a new batch's items back
 * (MEND_DEV_REFRESH_AFTER_SECONDS), so the results show them in about a minute.
 *
 * Settings come from the repo's .env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET,
 * ANTHROPIC_API_KEY and MEND_TEST_RECEIVER are required; PAYPAL_READ_CLIENT_ID,
 * PAYPAL_READ_CLIENT_SECRET and MEND_OWNER_PASSWORD are passed on when set. The bridge
 * token and the CSRF secret are new for every run. No setting's value is printed, and
 * every line a child prints goes through redact() first.
 *
 * Ctrl+C, closing the terminal or the parent process ending stops everything and exits 0.
 * The bridge or the web server stopping on its own stops the rest and exits 1, naming it.
 * Money moves only when a visitor submits a campaign, exactly as on the live site.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import pg from "pg";
import { ENGINE_DIR, holdDevDatabase, type DevDatabase } from "./dev-database";
import { localEngineDatabase } from "./engine-env";

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.resolve(WEB_DIR, "..", "..", ".env");
const NEXT_BIN = path.join(WEB_DIR, "node_modules", "next", "dist", "bin", "next");
const PYTHON = path.join(ENGINE_DIR, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const SCHEMA = "console_dev";
const DEFAULT_PORT = 3001;
const REQUIRED = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "ANTHROPIC_API_KEY", "MEND_TEST_RECEIVER"] as const;
const PASSED_WHEN_SET = ["PAYPAL_READ_CLIENT_ID", "PAYPAL_READ_CLIENT_SECRET", "MEND_OWNER_PASSWORD", "AG_STUDIO_LICENSE_KEY"] as const;
// The web config needs a webhook id to load. No webhook reaches this machine; the jobs read PayPal instead.
const UNUSED_WEBHOOK_ID = "CONSOLEDEVNOWEBHOOK";
const JOBS_EVERY_MS = 30_000;
// On Render the item webhooks fill a batch in within a minute; here only refresh_items can.
// The engine honours this only in local development (jobs.dev_refresh_after).
const JOBS_REFRESH_AFTER_SECONDS = "45";
// A run takes seconds. One stuck on a slow PayPal is stopped so later ticks can run.
const JOBS_RUN_LIMIT_MS = 5 * 60_000;
// The first seed downloads the shop's records and fits the model many times over.
const SEED_LIMIT_MS = 60 * 60_000;
const BRIDGE_START_MS = 2 * 60_000;
const WEB_START_MS = 5 * 60_000;
const SUMMARY_LIMIT_MS = 5 * 60_000;
// Starting up never goes quieter than this; the check runs twice a second.
const QUIET_MS = 9_000;
// Ctrl+C reaches every process on the console at once, so a child can exit a moment before
// this process hears the signal. A child's exit only counts as a failure after this long.
const SIGNAL_GRACE_MS = 1_500;
const JOB_NAME = /^[a-z][a-z_]{0,39}$/;
const ENGINE_CODE = /^[a-z][a-z_]{0,63}$/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const OPAQUE = /[A-Za-z0-9_-]{32,}/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

type Required = Record<(typeof REQUIRED)[number], string>;
type Optional = Partial<Record<(typeof PASSED_WHEN_SET)[number], string>>;

class StartRefused extends Error {}

/**
 * Hides every value this run knows is secret, any email address, and any unbroken run of 32
 * or more key characters with a digit in it: API keys, client ids and secrets, tokens,
 * session ids and other hashes. Ids in the uuid shape stay readable: refs, campaign ids and
 * run ids are not secrets, and a ref is how a failure is traced in the logs. Not covered: a
 * secret shorter than 8 characters, or one a child prints encoded, unless one of the shape
 * rules catches it.
 */
function redactor(secrets: readonly string[]): (text: string) => string {
  const known = [...new Set(secrets.filter((secret) => secret.length >= 8))].sort((a, b) => b.length - a.length);
  const opaque = (run: string): boolean => /\d/.test(run) && run.length >= 32;
  return (text) => {
    let out = text;
    for (const secret of known) out = out.split(secret).join("[hidden]");
    return out
      .replace(EMAIL, "[email]")
      .replace(OPAQUE, (run) => (run.replace(UUID, " ").split(" ").some(opaque) ? "[hidden]" : run));
  };
}

let redact = redactor([]);
let lastSaid = Date.now();
let step: { label: string; doing: string; since: number } | null = null;
let database: DevDatabase | null = null;
let jobsTimer: NodeJS.Timeout | null = null;
let stopping: Promise<never> | null = null;
const live = new Set<ChildProcess>();

function say(text: string): void {
  lastSaid = Date.now();
  console.log(text);
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

function begin(label: string, doing: string, line = `${label}: ${doing}`): void {
  step = { label, doing, since: Date.now() };
  say(line);
}

const heartbeat = setInterval(() => {
  if (step !== null && Date.now() - lastSaid >= QUIET_MS) say(`${step.label}: still ${step.doing} (${seconds(Date.now() - step.since)})`);
}, 500);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function track(child: ChildProcess): ChildProcess {
  live.add(child);
  child.once("exit", () => live.delete(child));
  return child;
}

function eachLine(stream: Readable | null, onLine: (line: string) => void): void {
  if (stream !== null) createInterface({ input: stream, crlfDelay: Infinity }).on("line", onLine);
}

function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return Promise.resolve();
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (process.platform === "win32") {
    // The whole tree: next dev runs its server and its compilers as processes of their own.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
  return Promise.race([exited, sleep(10_000)]);
}

function stop(code: number, reason?: string): Promise<never> {
  stopping ??= (async () => {
    clearInterval(heartbeat);
    if (jobsTimer !== null) clearInterval(jobsTimer);
    if (reason !== undefined) console.error(reason);
    say("stopping the console");
    try {
      await Promise.all([...live].map(stopProcess));
      // Last, so nothing still running loses its database.
      if (database !== null) await Promise.race([database.release(), sleep(15_000)]);
    } finally {
      console.log(code === 0 ? "console stopped" : "console stopped after a failure");
      process.exit(code);
    }
  })();
  return stopping;
}

function failSoon(reason: string): void {
  setTimeout(() => {
    if (stopping === null) void stop(1, reason);
  }, SIGNAL_GRACE_MS);
}

function keepRunning(name: string, child: ChildProcess): void {
  child.once("exit", (code, signal) => {
    if (stopping === null) failSoon(`${name} stopped on its own (${signal ?? `exit code ${String(code)}`}); stopping the rest`);
  });
}

/** The port from --port N, --port=N, -p N or -pN (the last one given wins), else PORT, else 3001. */
function portFrom(args: readonly string[], env: NodeJS.ProcessEnv): number {
  let given: string | undefined;
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at];
    if (arg === "--") continue;
    if (arg === "--port" || arg === "-p") {
      given = args[at + 1] ?? "";
      at += 1;
    } else if (arg.startsWith("--port=")) {
      given = arg.slice("--port=".length);
    } else if (/^-p=?\d/.test(arg)) {
      given = arg.replace(/^-p=?/, "");
    } else {
      throw new StartRefused("unknown argument: the only option is --port N (or -p N)");
    }
  }
  const raw = given ?? env.PORT ?? "";
  if (given === undefined && raw === "") return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw new StartRefused("the port must be a whole number from 1 to 65535");
  }
  return Number(raw);
}

function readSettings(): { required: Required; optional: Optional } {
  if (!existsSync(ENV_PATH)) throw new StartRefused("no .env at the repo root: copy .env.example to .env and fill it in");
  const file: Record<string, string | undefined> = parseEnv(readFileSync(ENV_PATH, "utf8").replace(/^﻿/, ""));
  const read = (name: string): string => (file[name] ?? "").trim();
  const missing: string[] = REQUIRED.filter((name) => read(name) === "" || /\s/.test(read(name)));
  if (!missing.includes("MEND_TEST_RECEIVER") && !read("MEND_TEST_RECEIVER").includes("@")) missing.push("MEND_TEST_RECEIVER");
  if (missing.length > 0) throw new StartRefused(`missing or invalid in .env: ${missing.join(", ")}`);
  const required = Object.fromEntries(REQUIRED.map((name) => [name, read(name)])) as Required;
  const optional: Optional = {};
  for (const name of PASSED_WHEN_SET) if (read(name) !== "") optional[name] = read(name);
  return { required, optional };
}

/** This process's environment without any setting this script decides for its children. */
function inheritedEnv(): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  for (const name of Object.keys(inherited)) {
    if (/^(PAYPAL_|MEND_|RENDER_|ANTHROPIC_|PG)/i.test(name) || name.toUpperCase() === "DATABASE_URL") delete inherited[name];
  }
  return inherited;
}

function portIsFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE" ? new StartRefused(`port ${port} is already in use`) : error);
    });
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
  });
}

/** True when console_dev holds what the seed's last steps leave: orders, both model facts and the test receiver as a member. */
async function shopReady(client: pg.Client, receiver: string): Promise<boolean> {
  const tables = await client.query<{ n: number }>(
    "select count(*)::int as n from pg_tables where schemaname = $1 and tablename = any($2::text[])",
    [SCHEMA, ["shop_orders", "model_facts", "members"]],
  );
  if (tables.rows[0].n < 3) return false;
  const schema = client.escapeIdentifier(SCHEMA);
  const found = await client.query<{ orders: boolean; facts: number; receiver: boolean }>(
    `select exists (select 1 from ${schema}.shop_orders) as orders,
            (select count(*)::int from ${schema}.model_facts) as facts,
            exists (select 1 from ${schema}.members where paypal_email = $1) as receiver`,
    [receiver],
  );
  const row = found.rows[0];
  return row.orders && row.facts >= 2 && row.receiver;
}

function runStep(what: string, args: readonly string[], env: NodeJS.ProcessEnv, onLine: (line: string) => void): Promise<void> {
  const child = track(spawn(PYTHON, args, { cwd: ENGINE_DIR, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
  let lastError = "";
  eachLine(child.stdout, onLine);
  eachLine(child.stderr, (line) => {
    if (line.trim() !== "") lastError = line.trim();
  });
  return new Promise((resolve, reject) => {
    const limit = setTimeout(() => {
      void stopProcess(child);
      reject(new StartRefused(`${what} took longer than ${SEED_LIMIT_MS / 60_000} minutes`));
    }, SEED_LIMIT_MS);
    child.once("error", (error) => {
      clearTimeout(limit);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(limit);
      if (code === 0) resolve();
      else reject(new StartRefused(`${what} failed (exit code ${String(code)})${lastError === "" ? "" : `: ${redact(lastError)}`}`));
    });
  });
}

async function prepareShop(url: string, receiver: string, env: NodeJS.ProcessEnv): Promise<void> {
  begin("demo shop", `looking for ${SCHEMA}`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let ready: boolean;
  try {
    ready = await shopReady(client, receiver);
    if (!ready) await client.query(`create schema if not exists ${client.escapeIdentifier(SCHEMA)}`);
  } finally {
    await client.end();
  }
  if (ready) {
    say(`demo shop: reused ${SCHEMA}`);
    return;
  }
  begin("demo shop", "applying the schema", `demo shop: building ${SCHEMA}; the first time imports the shop and measures the model, which takes minutes`);
  await runStep("applying the schema", ["-m", "mend_engine.db.migrate"], env, () => undefined);
  say("demo shop: schema applied");
  begin("demo shop", "seeding");
  // seed_demo prints one line per step and never an email; redact() is the second fence.
  await runStep("seeding", ["-m", "mend_engine.seed_demo"], env, (line) => say(`demo shop: ${redact(line)}`));
}

async function startBridge(env: NodeJS.ProcessEnv): Promise<string> {
  begin("engine", "starting the dev bridge");
  const child = track(spawn(PYTHON, ["-m", "mend_engine.dev_bridge", "--port", "0"], { cwd: ENGINE_DIR, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
  eachLine(child.stderr, (line) => say(`engine | ${redact(line)}`));
  const port = await new Promise<string>((resolve, reject) => {
    const limit = setTimeout(() => reject(new StartRefused(`the engine bridge did not start within ${seconds(BRIDGE_START_MS)}`)), BRIDGE_START_MS);
    eachLine(child.stdout, (line) => {
      const listening = /^dev bridge listening on 127\.0\.0\.1:(\d{1,5})$/.exec(line.trim());
      if (listening === null) {
        say(`engine | ${redact(line)}`);
        return;
      }
      clearTimeout(limit);
      resolve(listening[1]);
    });
    child.once("error", (error) => {
      clearTimeout(limit);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(limit);
      reject(new StartRefused(`the engine bridge stopped while starting (exit code ${String(code)})`));
    });
  });
  keepRunning("the engine bridge", child);
  say(`engine: dev bridge on 127.0.0.1:${port}`);
  return `http://127.0.0.1:${port}`;
}

async function startWeb(port: number, env: NodeJS.ProcessEnv): Promise<void> {
  begin("web", `starting next dev on port ${port}`);
  // Loopback only: this server spends sandbox money and Ram's Claude credit, so it is not offered to the local network.
  const child = track(
    spawn(process.execPath, [NEXT_BIN, "dev", "-p", String(port), "-H", "127.0.0.1"], { cwd: WEB_DIR, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }),
  );
  eachLine(child.stdout, (line) => say(`web | ${redact(line)}`));
  eachLine(child.stderr, (line) => say(`web | ${redact(line)}`));
  const deadline = Date.now() + WEB_START_MS;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new StartRefused("the web server stopped while starting");
    try {
      // The first request also compiles the route, so one attempt may take a while.
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(60_000) });
      if (response.status === 200 && (await response.text()) === "ok") break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new StartRefused(`the web server did not answer within ${seconds(WEB_START_MS)}`);
    await sleep(500);
  }
  keepRunning("the web server", child);
}

/** The shop_summary task's counts, checked before they are printed. */
async function shopLine(bridgeUrl: string, token: string): Promise<string> {
  try {
    const response = await fetch(new URL("/tasks/shop_summary", bridgeUrl), {
      method: "POST",
      headers: { "content-type": "application/json", "x-mend-bridge-token": token },
      body: JSON.stringify({ args: [] }),
      redirect: "error",
      signal: AbortSignal.timeout(SUMMARY_LIMIT_MS),
    });
    const body: unknown = await response.json();
    const answer = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const counts = [answer.shop_customers, answer.quiet_regulars];
    if (answer.ok === true && counts.every((count) => Number.isSafeInteger(count) && Number(count) >= 0)) {
      return `demo shop: ${Number(counts[0])} customers, ${Number(counts[1])} quiet regulars`;
    }
    const code = typeof answer.error === "string" && ENGINE_CODE.test(answer.error) ? answer.error : `status ${response.status}`;
    return `demo shop: the summary was refused (${code})`;
  } catch {
    return "demo shop: the summary could not be read";
  }
}

function jobOutcome(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return "an unreadable line";
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const name = typeof record.job === "string" && JOB_NAME.test(record.job) ? record.job : "an unnamed job";
  return `${name} ${record.ok === true ? "ok" : "failed"}`;
}

function startJobs(env: NodeJS.ProcessEnv): void {
  let running: ChildProcess | null = null;
  const tick = (): void => {
    if (stopping !== null) return;
    if (running !== null) {
      say("jobs: previous run still going");
      return;
    }
    // The engine's own log lines go to stderr; only each job's name and outcome are shown.
    const child = track(spawn(PYTHON, ["-m", "mend_engine.jobs", "all"], { cwd: ENGINE_DIR, env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }));
    running = child;
    const outcomes: string[] = [];
    eachLine(child.stdout, (line) => outcomes.push(jobOutcome(line)));
    const limit = setTimeout(() => {
      say(`jobs: run stopped after ${JOBS_RUN_LIMIT_MS / 60_000} minutes`);
      void stopProcess(child);
    }, JOBS_RUN_LIMIT_MS);
    child.once("error", () => {
      clearTimeout(limit);
      running = null;
      say("jobs: python could not be started");
    });
    child.once("close", (code) => {
      clearTimeout(limit);
      running = null;
      if (stopping !== null) return;
      say(outcomes.length > 0 ? `jobs: ${outcomes.join(", ")}` : `jobs: the run ended before any job answered (exit code ${String(code)})`);
    });
  };
  tick();
  jobsTimer = setInterval(tick, JOBS_EVERY_MS);
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const port = portFrom(process.argv.slice(2), process.env);
  const { required, optional } = readSettings();
  const receiver = required.MEND_TEST_RECEIVER.toLowerCase();
  await portIsFree(port);
  const bridgeToken = randomBytes(32).toString("base64url");
  const csrfSecret = randomBytes(32).toString("base64url");
  const secrets = [...Object.values(required), ...Object.values(optional).filter((value) => value !== undefined), receiver, bridgeToken, csrfSecret];
  redact = redactor(secrets);

  begin("database", "starting the local Postgres");
  database = await holdDevDatabase();
  // Percent-encoded by hand, as prove-m7b does: libpq does not read "+" as a space.
  const webDatabaseUrl = `${database.url}${database.url.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
  redact = redactor([...secrets, database.url, webDatabaseUrl]);

  const engineEnv: NodeJS.ProcessEnv = {
    ...inheritedEnv(),
    PAYPAL_ENV: "sandbox",
    PAYPAL_CLIENT_ID: required.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: required.PAYPAL_CLIENT_SECRET,
    MEND_TEST_RECEIVER: receiver,
    ...localEngineDatabase(SCHEMA),
  };
  await prepareShop(database.url, receiver, engineEnv);
  const bridgeUrl = await startBridge({ ...engineEnv, MEND_BRIDGE_TOKEN: bridgeToken });
  const summary = shopLine(bridgeUrl, bridgeToken);
  await startWeb(port, {
    ...inheritedEnv(),
    NEXT_TELEMETRY_DISABLED: "1",
    PAYPAL_ENV: "sandbox",
    PAYPAL_CLIENT_ID: required.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: required.PAYPAL_CLIENT_SECRET,
    PAYPAL_WEBHOOK_ID: UNUSED_WEBHOOK_ID,
    ...optional,
    ANTHROPIC_API_KEY: required.ANTHROPIC_API_KEY,
    DATABASE_URL: webDatabaseUrl,
    MEND_DEV: "1",
    MEND_BASE_URL: `http://localhost:${port}`,
    MEND_CSRF_SECRET: csrfSecret,
    MEND_BRIDGE_URL: bridgeUrl,
    MEND_BRIDGE_TOKEN: bridgeToken,
  });
  step = null;
  clearInterval(heartbeat);
  say(`console ready: http://localhost:${port}/demo`);
  say(`ready after ${seconds(Date.now() - startedAt)}`);
  startJobs({ ...engineEnv, MEND_DEV_REFRESH_AFTER_SECONDS: JOBS_REFRESH_AFTER_SECONDS });
  say(await summary);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
  process.on(signal, () => void stop(0));
}

// A parent killed outright sends no signal, so its going away is watched for directly.
const parentPid = process.ppid;
setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") void stop(0);
  }
}, 2_000).unref();

main().catch((error: unknown) => {
  failSoon(`could not start the console: ${error instanceof Error ? redact(error.message) : "unexpected failure"}`);
});
