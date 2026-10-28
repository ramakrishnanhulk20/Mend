/**
 * Mend's one repeatable deploy on Render: the web app (mend-web), the engine (mend-engine, a
 * private service), the scheduled jobs (mend-jobs, a cron job), their database (mend-db),
 * and the PayPal sandbox webhook that points at the web app.
 *
 *   node scripts/deploy/render.mjs status                       read-only: each recorded resource and how it is set
 *   node scripts/deploy/render.mjs up [--create] [--migrate]    bring the recorded resources to their decided settings
 *   node scripts/deploy/render.mjs prove                        the live proof: compare only, never a change
 *
 * Every resource is found by the id render-state.json records for it. A recorded resource
 * that is missing, renamed or on another plan stops the run before anything changes, and a
 * resource is created only with --create and only when no id is recorded for it, so no
 * command can create a paid resource or point a service at another database by accident.
 *
 * Only `up --migrate` changes mend-db: it runs the engine's own migrate command (schema.sql
 * as checked out here, and the services' roles mend_engine and mend_web) as mend-db's owner
 * and then its seed command as mend_engine, both from this machine over TLS.
 *
 * prove changes no resource and no setting: Render and PayPal writes are refused in code.
 * Its one exception, shared with up, is this machine's own entry on mend-db's allow list,
 * added at the start of a run and removed at its end, whatever happens in between.
 *
 * Secrets come from the repo's .env or are generated here (MEND_CSRF_SECRET,
 * MEND_ENGINE_TOKEN, MEND_ENGINE_DB_PASSWORD, MEND_WEB_DB_PASSWORD) and go only to the Render
 * API and PayPal's sandbox API. A generated secret lives only in Render and is read back from
 * Render on the next run. No service is given RENDER_API_KEY. No secret value is printed or
 * written to disk: every output line passes through say(), which withholds any line that
 * carries one and fails the run.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isIP, isIPv4 } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const ENGINE_DIR = path.join(REPO_ROOT, "packages", "engine");
const ENV_PATH = path.join(REPO_ROOT, ".env");
const STATE_PATH = path.join(HERE, "render-state.json");
const ENGINE_PYTHON = path.join(ENGINE_DIR, ".venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));

const RENDER_API = "https://api.render.com/v1";
// C16: the only PayPal host this script can reach. A constant, never read from .env.
const PAYPAL_API = "https://api-m.sandbox.paypal.com";
const WORKSPACE_NAME = "My Workspace";
const REPO_URL = "https://github.com/ramakrishnanhulk20/Mend";
const BRANCH = "main";
const REGION = "virginia";
// The login role each service connects as; mend_engine.db.migrate creates both (C22).
// mend_web cannot write the payout ledger, members or campaigns.
const DB_ROLES = { web: "mend_web", engine: "mend_engine", jobs: "mend_engine" };
const ROLE_PASSWORD_ENV = { mend_engine: "MEND_ENGINE_DB_PASSWORD", mend_web: "MEND_WEB_DB_PASSWORD" };
// The single role every service used to share; a migrate run drops it once no service uses it.
const LEGACY_DB_ROLE = "mend_app";

// Render renamed its plans without changing prices (render.com/docs/compute-plans), and the
// API may report either name. The first name in each list is the one this script asks for.
const STARTER = ["starter", "0.5c-512mb"];
const DATABASE = {
  name: "mend-db",
  databaseName: "mend",
  plans: ["basic_256mb", "0.1c-256mb"],
  // The newest major version in the API's postgresVersion enum and the docs on 2026-10-20.
  version: "18",
  // 1 GB is the smallest storage Render allows; larger sizes come in steps of 5 GB.
  diskSizeGB: 1,
};
// Never on any service: Render keys are account-wide, and the rest are local development settings.
const NEVER_ON_RENDER = ["RENDER_API_KEY", "MEND_DEV", "MEND_TEST_RECEIVER", "MEND_BRIDGE_URL", "MEND_BRIDGE_TOKEN", "MEND_WORKFLOW_SLUG"];
const WEB_ONLY = ["MEND_OWNER_PASSWORD", "ANTHROPIC_API_KEY", "MEND_CSRF_SECRET", "PAYPAL_READ_CLIENT_ID", "PAYPAL_READ_CLIENT_SECRET"];
const SERVICES = {
  web: {
    key: "web",
    name: "mend-web",
    type: "web_service",
    runtime: "node",
    rootDir: "packages/web",
    buildCommand: "npm ci && npm run build",
    startCommand: "npm start",
    healthCheckPath: "/api/health",
    cost: "about USD 7 a month",
    // Render's default Node is 24 (render.com/docs/node-version) and packages/web declares no
    // engines field, so the version the web app is built and tested with here is pinned.
    buildEnv: { NODE_VERSION: "26.7.0" },
    forbidden: NEVER_ON_RENDER,
  },
  engine: {
    key: "engine",
    name: "mend-engine",
    type: "private_service",
    runtime: "python",
    rootDir: "packages/engine",
    // No extras: pgserver, the local development database, is only in the dev and test extras.
    buildCommand: "pip install .",
    startCommand: "python -m mend_engine.task_server",
    cost: "about USD 7 a month",
    // Render's default Python is 3.14 (render.com/docs/python-version); the engine is built and tested on 3.12.10.
    buildEnv: { PYTHON_VERSION: "3.12.10" },
    forbidden: [...NEVER_ON_RENDER, ...WEB_ONLY],
  },
  jobs: {
    key: "jobs",
    name: "mend-jobs",
    type: "cron_job",
    runtime: "python",
    rootDir: "packages/engine",
    buildCommand: "pip install .",
    startCommand: "python -m mend_engine.jobs all",
    schedule: "*/5 * * * *",
    cost: "USD 1 a month minimum plus run minutes",
    buildEnv: { PYTHON_VERSION: "3.12.10" },
    forbidden: [...NEVER_ON_RENDER, ...WEB_ONLY, "MEND_ENGINE_TOKEN"],
  },
};
const DEPLOY_IN_PROGRESS = new Set(["created", "queued", "build_in_progress", "update_in_progress", "pre_deploy_in_progress"]);
const DEPLOY_FAILED = new Set(["build_failed", "update_failed", "canceled", "pre_deploy_failed", "deactivated"]);
const WEBHOOK_PATH = "/api/webhooks/paypal";
const EVENT_TYPES = [
  ...["SUCCEEDED", "FAILED", "BLOCKED", "HELD", "UNCLAIMED", "RETURNED", "REFUNDED", "CANCELED"].map(
    (name) => `PAYMENT.PAYOUTS-ITEM.${name}`,
  ),
  ...["DENIED", "PROCESSING", "SUCCESS"].map((name) => `PAYMENT.PAYOUTSBATCH.${name}`),
  "PAYMENT.CAPTURE.COMPLETED",
];
const CAP_KEYS = ["MEND_PAYOUT_ITEM_CAP_MINOR", "MEND_CAMPAIGN_CAP_MINOR", "MEND_DAILY_CAP_MINOR"];
// The agent's PayPal reads use a second sandbox app made without the Payouts permission; only mend-web holds it.
const READ_KEYS = ["PAYPAL_READ_CLIENT_ID", "PAYPAL_READ_CLIENT_SECRET"];
// The keys packages/web/src/server reads in production (config.ts, auth.ts, csrf.ts, claude.ts, engine.ts).
const WEB_APP_KEYS = [
  "PAYPAL_ENV",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_READ_CLIENT_ID",
  "PAYPAL_READ_CLIENT_SECRET",
  "DATABASE_URL",
  "PAYPAL_WEBHOOK_ID",
  "MEND_BASE_URL",
  "MEND_OWNER_PASSWORD",
  "MEND_CSRF_SECRET",
  "ANTHROPIC_API_KEY",
  "MEND_ENGINE_URL",
  "MEND_ENGINE_TOKEN",
];
const GENERATED_SECRET_BYTES = 48;
const MIN_GENERATED_CHARS = 32;

const REQUEST_TIMEOUT_MS = 30_000;
const MIGRATE_TIMEOUT_MS = 10 * 60 * 1000;
const SEED_TIMEOUT_MS = 90 * 60 * 1000;

class DeployError extends Error {}

const secrets = new Set();
const transcript = [];
let leakedLine = false;

/** Remember a value that must never appear in output. Short values are skipped so a cap like "1000" cannot trip the guard. */
function addSecret(value) {
  if (typeof value === "string" && value.length >= 8) secrets.add(value);
}

function carriesSecret(text) {
  for (const value of secrets) if (text.includes(value)) return true;
  return false;
}

function say(text) {
  if (carriesSecret(text)) {
    leakedLine = true;
    text = "WITHHELD: an output line carried a secret value (this run fails)";
  }
  transcript.push(text);
  console.log(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readDotEnv() {
  if (!existsSync(ENV_PATH)) throw new DeployError(`no .env at the repo root (${ENV_PATH})`);
  return parseEnv(readFileSync(ENV_PATH, "utf8").replace(/^\uFEFF/, ""));
}

const NO_WHITESPACE = /^\S+$/;
const PRINTABLE = /^[\x21-\x7e]+$/;

/**
 * The settings this script needs, validated. Errors name the key, never its value.
 * PAYPAL_ENV must be exactly "sandbox" (C16), whatever command runs.
 */
function loadSettings(env = readDotEnv()) {
  const missing = ["RENDER_API_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"].filter(
    (key) => typeof env[key] !== "string" || !NO_WHITESPACE.test(env[key]),
  );
  if (!/^[1-9][0-9]{0,8}$/.test(env.MEND_PAYOUT_ITEM_CAP_MINOR ?? "")) missing.push("MEND_PAYOUT_ITEM_CAP_MINOR");
  if (missing.length > 0) throw new DeployError(`missing or invalid in .env: ${missing.join(", ")}`);
  if (env.PAYPAL_ENV !== "sandbox") throw new DeployError("PAYPAL_ENV in .env must be exactly 'sandbox'");
  for (const key of ["RENDER_API_KEY", "PAYPAL_CLIENT_SECRET", "MEND_OWNER_PASSWORD", "ANTHROPIC_API_KEY", ...READ_KEYS]) addSecret(env[key]);
  addSecret(Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64"));
  if (typeof env.PAYPAL_READ_CLIENT_ID === "string" && typeof env.PAYPAL_READ_CLIENT_SECRET === "string") {
    addSecret(Buffer.from(`${env.PAYPAL_READ_CLIENT_ID}:${env.PAYPAL_READ_CLIENT_SECRET}`).toString("base64"));
  }
  return env;
}

/** The extra .env settings `up` copies to the services, checked the way the services check them. */
function checkDeploySettings() {
  const bad = CAP_KEYS.filter((key) => !/^[1-9][0-9]{0,8}$/.test(settings[key] ?? ""));
  // packages/web/src/server/auth.ts refuses an owner password under 16 characters.
  if ((settings.MEND_OWNER_PASSWORD ?? "").length < 16 || !PRINTABLE.test(settings.MEND_OWNER_PASSWORD ?? "")) bad.push("MEND_OWNER_PASSWORD");
  // packages/web/src/server/claude.ts accepts 20 to 512 printable characters.
  if (!/^[\x21-\x7e]{20,512}$/.test(settings.ANTHROPIC_API_KEY ?? "")) bad.push("ANTHROPIC_API_KEY");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.MEND_TEST_RECEIVER ?? "")) bad.push("MEND_TEST_RECEIVER");
  // packages/web/src/server/config.ts readOnlyCredentials: the agent's read-only PayPal app.
  bad.push(...READ_KEYS.filter((key) => typeof settings[key] !== "string" || !NO_WHITESPACE.test(settings[key])));
  if (bad.length > 0) throw new DeployError(`missing or invalid in .env: ${bad.join(", ")}`);
  if (settings.PAYPAL_READ_CLIENT_ID === settings.PAYPAL_CLIENT_ID) throw new DeployError("PAYPAL_READ_CLIENT_ID in .env must belong to a different PayPal app");
}

let settings;
let statePath = STATE_PATH;
// prove's mode: every Render and PayPal write is refused in code, except this machine's
// allow-list entry (openMachineAccess, closeMachineAccess).
let compareOnly = false;

function readState() {
  if (!existsSync(statePath)) return {};
  return JSON.parse(readFileSync(statePath, "utf8"));
}

/**
 * Writes render-state.json only when its content changes, so a repeat run leaves it alone,
 * and returns whether it differed. A plan-only run only reports whether it would write.
 */
function writeState(state) {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  if (carriesSecret(text)) throw new DeployError("refusing to write a secret into render-state.json");
  if (existsSync(statePath) && readFileSync(statePath, "utf8") === text) return false;
  if (options.planOnly) return true;
  if (compareOnly) throw new DeployError("compare-only: refused to write render-state.json");
  writeFileSync(statePath, text, "utf8");
  return true;
}

/** Records the id of a resource the moment it is created, so a run that stops later never creates a second one. */
function recordId(update) {
  const state = readState();
  writeState({ ...state, ...update, services: { ...(state.services ?? {}), ...(update.services ?? {}) } });
}

function isAllowListOnly(method, apiPath, body) {
  return method === "PATCH" && /^\/postgres\/dpg-[a-z0-9-]{1,64}$/.test(apiPath) && body !== null && typeof body === "object" && Object.keys(body).join() === "ipAllowList";
}

async function renderCall(method, apiPath, body, { allowList = false } = {}) {
  if (compareOnly && method !== "GET" && !(allowList && isAllowListOnly(method, apiPath, body))) {
    throw new DeployError(`compare-only: refused Render ${method} ${apiPath.split("?")[0]}`);
  }
  const headers = { Authorization: `Bearer ${settings.RENDER_API_KEY}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // Only reads are retried: a create that timed out may have happened, and a rerun of
  // `up` finds it by name instead of creating a second one.
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch(`${RENDER_API}${apiPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (method === "GET" && attempt < 4) {
        await sleep(3_000 * attempt);
        continue;
      }
      throw new DeployError(`Render ${method} ${apiPath.split("?")[0]} failed: ${error?.name ?? "network error"}`);
    }
    if (method === "GET" && attempt < 4 && (response.status === 429 || response.status >= 500)) {
      await sleep(5_000 * attempt);
      continue;
    }
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  }
}

async function renderOk(method, apiPath, body, expected = [200], callOptions = {}) {
  const reply = await renderCall(method, apiPath, body, callOptions);
  if (!expected.includes(reply.status)) {
    const message = typeof reply.body?.message === "string" ? reply.body.message.slice(0, 300) : "no message";
    throw new DeployError(`Render ${method} ${apiPath.split("?")[0]} answered ${reply.status}: ${message}`);
  }
  return reply.body;
}

/** Every item of a Render list endpoint, following its cursor. */
async function renderList(apiPath, field) {
  const items = [];
  let cursor = "";
  for (let page = 0; page < 50; page += 1) {
    const join = apiPath.includes("?") ? "&" : "?";
    const answer = await renderOk("GET", `${apiPath}${join}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    // /workflows answers a bare JSON null, not [], when there are none (seen 2026-10-24).
    const rows = answer === null ? [] : answer;
    if (!Array.isArray(rows)) throw new DeployError(`Render GET ${apiPath.split("?")[0]} did not return a list`);
    items.push(...rows.map((row) => row[field]));
    if (rows.length < 100) return items;
    cursor = rows[rows.length - 1].cursor;
  }
  throw new DeployError(`Render GET ${apiPath.split("?")[0]} has more than 5,000 items`);
}

async function findWorkspace() {
  const owners = await renderList("/owners", "owner");
  const matches = owners.filter((owner) => owner.name === WORKSPACE_NAME && owner.type === "team");
  if (matches.length !== 1) throw new DeployError(`expected one workspace named "${WORKSPACE_NAME}", found ${matches.length}`);
  return { id: matches[0].id, name: matches[0].name };
}

async function findDatabase(ownerId) {
  const found = (await renderList(`/postgres?ownerId=${ownerId}&name=${DATABASE.name}`, "postgres")).filter(
    (db) => db.name === DATABASE.name,
  );
  if (found.length > 1) throw new DeployError(`${found.length} databases are named ${DATABASE.name}; expected at most one`);
  return found[0] ?? null;
}

async function findService(ownerId, spec) {
  const found = (await renderList(`/services?ownerId=${ownerId}&name=${spec.name}`, "service")).filter((service) => service.name === spec.name);
  if (found.length > 1) throw new DeployError(`${found.length} services are named ${spec.name}; expected at most one`);
  return found[0] ?? null;
}

async function latestDeploy(serviceId) {
  const rows = await renderOk("GET", `/services/${serviceId}/deploys?limit=1`);
  return rows[0]?.deploy ?? null;
}

function stop(message) {
  return new DeployError(`${message}; nothing was changed`);
}

/** The resource at apiPath, only when Render answers 200 with an object carrying exactly the recorded id. */
async function recorded(what, apiPath, id) {
  const reply = await renderCall("GET", apiPath);
  if (reply.status !== 200 || reply.body === null || typeof reply.body !== "object" || reply.body.id !== id) {
    throw stop(`the recorded ${what} ${id} is missing (Render answered ${reply.status}${reply.body === null ? " with no body" : ""})`);
  }
  return reply.body;
}

async function resolveWorkspace(state) {
  const id = state.workspace?.id;
  if (!id) return findWorkspace();
  const owner = await recorded("workspace", `/owners/${id}`, id);
  if (owner.name !== WORKSPACE_NAME || owner.type !== "team") throw stop(`the recorded workspace ${id} is "${owner.name}", not "${WORKSPACE_NAME}"`);
  return { id: owner.id, name: owner.name };
}

async function resolveDatabase(state, workspace) {
  const id = state.database?.id;
  if (id) {
    const db = await recorded(DATABASE.name, `/postgres/${id}`, id);
    if (db.name !== DATABASE.name) throw stop(`the recorded ${DATABASE.name} ${id} was renamed to "${db.name}"`);
    if (db.owner?.id !== workspace.id) throw stop(`the recorded ${DATABASE.name} ${id} belongs to another workspace`);
    checkDatabaseSettings(db);
    return { found: db };
  }
  const named = await findDatabase(workspace.id);
  if (named !== null) throw stop(`${DATABASE.name} ${named.id} exists but render-state.json records no id for it; record it as database.id`);
  if (!options.create) throw stop(`render-state.json records no ${DATABASE.name}; pass --create to create it (about USD 6 a month)`);
  return { create: true };
}

async function resolveService(state, workspace, spec) {
  const id = state.services?.[spec.key]?.id;
  if (id) {
    const service = await recorded(spec.name, `/services/${id}`, id);
    if (service.name !== spec.name) throw stop(`the recorded ${spec.name} ${id} was renamed to "${service.name}"`);
    if (service.ownerId !== workspace.id) throw stop(`the recorded ${spec.name} ${id} belongs to another workspace`);
    checkServiceSettings(spec, service);
    return { found: service };
  }
  const named = await findService(workspace.id, spec);
  if (named !== null) throw stop(`${spec.name} ${named.id} exists but render-state.json records no id for it; record it as services.${spec.key}.id`);
  if (!options.create) throw stop(`render-state.json records no ${spec.name}; pass --create to create it (${spec.cost})`);
  return { create: true };
}

async function resolveWebhook(state, web) {
  const expected = web.found ? webhookUrlFor(serviceOrigin(web.found)) : null;
  const id = state.webhook?.id;
  if (id) {
    const reply = await paypalCall("GET", webhookPath(id));
    if (reply.status !== 200 || reply.body?.id !== id) throw stop(`the recorded PayPal webhook ${id} is missing (PayPal answered ${reply.status})`);
    if (expected === null || !sameUrl(reply.body.url, expected)) throw stop(`the recorded PayPal webhook ${id} points at ${reply.body.url}, not at mend-web`);
    return { found: reply.body };
  }
  const ours = expected === null ? [] : (await listWebhooks()).filter((hook) => sameUrl(hook.url, expected));
  if (ours.length > 0) throw stop(`PayPal webhook ${ours[0].id} points at mend-web but render-state.json records no id for it; record it as webhook.id`);
  if (!options.create) throw stop("render-state.json records no PayPal webhook; pass --create to register one");
  return { create: true };
}

/**
 * Every resource this deploy manages, found by the id render-state.json records, before
 * anything is changed. Each is { found } or, only with --create and no recorded id,
 * { create: true }. Throws, having changed nothing, for a recorded resource that is missing,
 * renamed, in another workspace or off its decided settings, and for an unrecorded one that
 * exists under the expected name or may not be created.
 */
async function resolveResources(state) {
  const workspace = await resolveWorkspace(state);
  const db = await resolveDatabase(state, workspace);
  const services = {};
  for (const spec of Object.values(SERVICES)) services[spec.key] = await resolveService(state, workspace, spec);
  // A new, empty database under services that already run would repoint them at it.
  const running = Object.values(SERVICES).filter((spec) => services[spec.key].found);
  if (db.create && running.length > 0) {
    throw stop(`${DATABASE.name} is not recorded but ${running.map((spec) => spec.name).join(", ")} are; a new ${DATABASE.name} would point them at an empty database`);
  }
  const webhook = await resolveWebhook(state, services.web);
  return { workspace, db, services, webhook };
}

/**
 * C24: the web app's public origin, taken from the URL Render reports for the service.
 * It must be a bare https origin on Render's own onrender.com domain, or nothing is built on it.
 */
function serviceOrigin(service) {
  const reported = service?.serviceDetails?.url;
  let url;
  try {
    url = new URL(reported);
  } catch {
    throw new DeployError("Render reported no usable URL for mend-web");
  }
  const bare = url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === "" && url.port === "";
  if (url.protocol !== "https:" || !url.hostname.endsWith(".onrender.com") || !bare) {
    throw new DeployError("Render reported a mend-web URL that is not a bare https onrender.com origin");
  }
  return url;
}

// A single DNS label, the form of a Render private network name. The same rule the web app's
// engine client applies to MEND_ENGINE_URL (packages/web/src/server/engine.ts).
const SINGLE_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * C24: mend-engine's private network address, from what Render reports for the service (its
 * internal address, or its slug and the port it was seen listening on), never typed by hand.
 * Returns an origin of the one shape the web app accepts: http, a one-label host, a port.
 */
function engineAddress(service) {
  const details = service?.serviceDetails ?? {};
  const ports = (details.openPorts ?? []).filter((open) => open.protocol === "TCP").map((open) => open.port);
  const candidates = [];
  if (typeof details.url === "string" && details.url !== "") candidates.push(details.url.includes("://") ? details.url : `http://${details.url}`);
  for (const port of ports) candidates.push(`http://${service.slug}:${port}`);
  for (const candidate of candidates) {
    let url;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    const bare = url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === "";
    if (url.protocol === "http:" && SINGLE_LABEL.test(url.hostname) && isIP(url.hostname) === 0 && url.port !== "" && bare) return url.origin;
  }
  return null;
}

function webhookUrlFor(origin) {
  return new URL(WEBHOOK_PATH, origin).href;
}

let paypalToken = null;

async function paypalCall(method, apiPath, body, extraHeaders = {}) {
  if (compareOnly && method !== "GET") throw new DeployError(`compare-only: refused PayPal ${method} ${apiPath}`);
  if (!apiPath.startsWith("/") || apiPath.startsWith("//")) throw new DeployError("PayPal path must start with a single /");
  const url = new URL(`${PAYPAL_API}${apiPath}`);
  if (url.origin !== PAYPAL_API) throw new DeployError("refused a PayPal call that left the sandbox host");
  if (paypalToken === null) paypalToken = await paypalAccessToken();
  const headers = { Authorization: `Bearer ${paypalToken}`, Accept: "application/json", ...extraHeaders };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, debugId: response.headers.get("paypal-debug-id") };
}

async function paypalAccessToken() {
  const basic = Buffer.from(`${settings.PAYPAL_CLIENT_ID}:${settings.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const response = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: "grant_type=client_credentials",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null);
  if (response.status !== 200 || typeof body?.access_token !== "string") {
    throw new DeployError(`PayPal token request answered ${response.status} (debug_id ${response.headers.get("paypal-debug-id")})`);
  }
  addSecret(body.access_token);
  return body.access_token;
}

function paypalProblem(reply) {
  return `${reply.status} ${typeof reply.body?.name === "string" ? reply.body.name : ""} (debug_id ${reply.debugId})`.replace("  ", " ");
}

async function listWebhooks() {
  const reply = await paypalCall("GET", "/v1/notifications/webhooks");
  if (reply.status !== 200 || !Array.isArray(reply.body?.webhooks)) throw new DeployError(`PayPal webhook list answered ${paypalProblem(reply)}`);
  return reply.body.webhooks;
}

function hostOf(text) {
  try {
    return new URL(text).hostname;
  } catch {
    return "";
  }
}

// Both sides go through the same URL parser before they are compared.
function sameUrl(a, b) {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/** Read-only: each resource render-state.json records, found by its id, with any problem the next `up` would stop on. */
async function status() {
  const state = readState();
  if (!existsSync(statePath)) say("status: no render-state.json yet");
  const report = async (label, work) => {
    try {
      say(`status: ${await work()}`);
    } catch (error) {
      say(`status: ${label}: ${error instanceof Error ? error.message : "unreadable"}`);
    }
  };
  let workspace = null;
  await report("workspace", async () => {
    workspace = await resolveWorkspace(state);
    return `workspace "${workspace.name}" ${workspace.id}`;
  });
  if (workspace === null) return;
  await report(DATABASE.name, async () => {
    const db = await resolveDatabase(state, workspace);
    if (db.create) return `${DATABASE.name} is not recorded and does not exist`;
    return `${DATABASE.name} ${db.found.id} is ${db.found.status}, plan ${db.found.plan}, region ${db.found.region}, Postgres ${db.found.version}, ${db.found.diskSizeGB ?? "?"} GB, ${(db.found.ipAllowList ?? []).length} allow-list entries`;
  });
  let web = { create: true };
  for (const spec of Object.values(SERVICES)) {
    await report(spec.name, async () => {
      const resolved = await resolveService(state, workspace, spec);
      if (spec.key === "web") web = resolved;
      if (resolved.create) return `${spec.name} is not recorded and does not exist`;
      const service = resolved.found;
      const details = service.serviceDetails ?? {};
      const deploy = await latestDeploy(service.id);
      const role = databaseUser((await serviceEnv(service.id)).DATABASE_URL ?? "") || "none";
      const where = spec.key === "web" ? details.url : spec.key === "engine" ? `${engineAddress(service) ?? "no address yet"} (private)` : `schedule ${details.schedule}, last good run ${details.lastSuccessfulRunAt ?? "none yet"}`;
      return `${spec.name} ${service.id} ${where}, plan ${details.plan}, region ${details.region}, ${service.suspended}, database role ${role}, latest deploy ${deploy ? `${deploy.id} ${deploy.status}` : "none"}`;
    });
  }
  await report("PayPal webhook", async () => {
    const hook = await resolveWebhook(state, web);
    return hook.create ? "PayPal webhook is not recorded and none points at mend-web" : `PayPal webhook ${hook.found.id} points at ${hook.found.url} with ${hook.found.event_types?.length ?? 0} event types`;
  });
  for (const [key, since] of Object.entries(state.pending ?? {})) {
    say(`status: an env var change on ${SERVICES[key]?.name ?? key} from ${since} has not been seen live; the next \`up\` redeploys it`);
  }
}

// Runs SQL on mend-db from this machine with the engine's own psycopg, over the external
// connection with TLS checked against public roots (certifi ships with the engine's httpx).
// The URL travels in the child's environment, never on its command line.
const DATABASE_SCRIPT = `
import json, os, sys
import certifi, psycopg
from psycopg.rows import dict_row

request = json.load(sys.stdin)
try:
    with psycopg.connect(
        os.environ["MEND_D1_DATABASE_URL"],
        sslmode="verify-full",
        sslrootcert=certifi.where(),
        connect_timeout=15,
        autocommit=True,
        row_factory=dict_row,
        application_name="mend-deploy",
    ) as conn:
        out = {"rows": conn.execute(request["sql"], request.get("params", [])).fetchall()}
except psycopg.Error as error:
    out = {"error": type(error).__name__, "sqlstate": error.sqlstate, "detail": str(error).strip()[:300]}
print(json.dumps(out, default=str))
`;

function databaseRows(externalUrl, sql, params = []) {
  const result = spawnSync(ENGINE_PYTHON, ["-I", "-c", DATABASE_SCRIPT], {
    input: JSON.stringify({ sql, params }),
    env: { ...process.env, MEND_D1_DATABASE_URL: externalUrl },
    encoding: "utf8",
    timeout: 90_000,
    windowsHide: true,
  });
  if (result.error) throw new DeployError(`could not run the engine's Python (${result.error.code ?? result.error.name})`);
  const last = result.stdout.trim().split(/\r?\n/).pop() ?? "";
  let out;
  try {
    out = JSON.parse(last);
  } catch {
    const reason = result.stderr.trim().split(/\r?\n/).pop() ?? "";
    throw new DeployError(`database query gave no answer (exit ${result.status}): ${reason}`);
  }
  if (out.error) throw new DeployError(`database query failed: ${out.error} ${out.sqlstate ?? ""} ${out.detail}`);
  return out.rows;
}

function certifiPath() {
  const result = spawnSync(ENGINE_PYTHON, ["-I", "-c", "import certifi; print(certifi.where())"], { encoding: "utf8", windowsHide: true });
  const found = result.stdout.trim();
  if (result.status !== 0 || !existsSync(found)) throw new DeployError("could not find certifi's root certificates in the engine's virtual environment");
  return found;
}

/**
 * Runs `python -m <module>` from packages/engine against mend-db's external address over TLS
 * with the certificate checked (libpq reads PGSSLMODE and PGSSLROOTCERT), printing each line
 * it writes. The database URL travels in the child's environment only. The rest of the
 * engine's settings come from the repo's .env, as for any local engine command.
 */
function runEngineCommand(module, externalUrl, timeoutMs, extraEnv = {}, args = []) {
  if (compareOnly || options.planOnly) throw new DeployError(`refused to run python -m ${module} in a run that may not change anything`);
  const env = { ...process.env, ...extraEnv, DATABASE_URL: externalUrl, PGSSLMODE: "verify-full", PGSSLROOTCERT: certifiPath(), PYTHONUNBUFFERED: "1" };
  return new Promise((resolve, reject) => {
    const child = spawn(ENGINE_PYTHON, ["-m", module, ...args], { cwd: ENGINE_DIR, env, windowsHide: true });
    const lines = [];
    const timer = setTimeout(() => child.kill(), timeoutMs);
    for (const stream of [child.stdout, child.stderr]) {
      let rest = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        const parts = (rest + chunk).split(/\r?\n/);
        rest = parts.pop();
        for (const text of parts) {
          lines.push(text);
          say(`  ${module.split(".").pop()}: ${text}`);
        }
      });
      stream.on("end", () => {
        if (rest !== "") {
          lines.push(rest);
          say(`  ${module.split(".").pop()}: ${rest}`);
        }
      });
    }
    child.on("error", (error) => reject(new DeployError(`could not run python -m ${module} (${error.code ?? error.name})`)));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, lines });
    });
  });
}

async function publicTables(externalUrl) {
  return databaseRows(externalUrl, "select table_name from information_schema.tables where table_schema = 'public' order by 1").map((row) => row.table_name);
}

function loginWorks(externalUrl) {
  try {
    databaseRows(externalUrl, "select 1 as ok");
    return true;
  } catch {
    return false;
  }
}

function reportedRole(lines, role) {
  const pattern = new RegExp(`^db role ${role}: (.+)$`);
  return lines.map((text) => pattern.exec(text)?.[1]).find(Boolean) ?? null;
}

/**
 * `up --migrate`: the engine's migrate command as mend-db's owner (the only step that is),
 * then its seed command as mend_engine. Each role's password goes to migrate only when that
 * role cannot already log in with it, so a repeat run leaves the roles as they are. Records
 * what changed.
 */
async function migrateAndSeed(connection, roleConnections, passwords, changes) {
  const before = await publicTables(connection.external);
  const extra = {};
  for (const role of Object.keys(ROLE_PASSWORD_ENV)) {
    if (!loginWorks(roleConnections[role].external)) extra[ROLE_PASSWORD_ENV[role]] = passwords[role];
  }
  const migrated = await runEngineCommand("mend_engine.db.migrate", connection.external, MIGRATE_TIMEOUT_MS, extra);
  if (migrated.code !== 0) throw new DeployError(`python -m mend_engine.db.migrate exited ${migrated.code}`);
  const sha = migrated.lines.map((text) => /^schema sha256 ([0-9a-f]{64})$/.exec(text)?.[1]).find(Boolean) ?? null;
  for (const role of Object.keys(ROLE_PASSWORD_ENV)) {
    const outcome = reportedRole(migrated.lines, role);
    if (!["created", "password set", "kept"].includes(outcome)) throw new DeployError(`migrate did not report the ${role} role (${outcome ?? "no line"})`);
    if (outcome !== "kept") {
      changes.push(`db role ${role} ${outcome}`);
      say(`action: migrate ${outcome === "created" ? `created the ${role} role` : `set the ${role} role's password`}`);
    }
  }
  const created = (await publicTables(connection.external)).filter((name) => !before.includes(name));
  if (created.length > 0) {
    changes.push(`created tables ${created.join(", ")}`);
    say(`action: migrate created ${created.length} tables on mend-db: ${created.join(", ")}`);
  } else {
    say("schema: migrate created no new tables");
  }
  const seeded = await runEngineCommand("mend_engine.seed_demo", roleConnections.mend_engine.external, SEED_TIMEOUT_MS);
  if (seeded.code !== 0 || !seeded.lines.includes("SEED RESULT: PASS")) throw new DeployError(`python -m mend_engine.seed_demo exited ${seeded.code}`);
  const wrote = seeded.lines.filter(
    (text) => /^(orders: imported|refunds: imported|facts: stored|receiver: .*linked to one quiet regular|receiver: moved to rank 1)/.test(text) || /^members: .*\(([1-9][0-9]*) new\)/.test(text),
  );
  if (wrote.length > 0) changes.push(`seeded mend-db (${wrote.map((text) => text.split(":")[0]).join(", ")})`);
  return sha;
}

/**
 * `up --migrate`, once every service's DATABASE_URL names its own role: a second migrate
 * run drops mend_app. migrate keeps it while any connection as mend_app is open (an old
 * instance still shutting down), and a later `up --migrate` then drops it.
 */
async function dropLegacyRole(connection, serviceIds, changes) {
  for (const [key, id] of Object.entries(serviceIds)) {
    const user = databaseUser((await serviceEnv(id)).DATABASE_URL ?? "");
    if (user !== DB_ROLES[key]) {
      say(`database: ${LEGACY_DB_ROLE} kept, ${SERVICES[key].name} still connects as ${user || "nothing"}`);
      return;
    }
  }
  const run = await runEngineCommand("mend_engine.db.migrate", connection.external, MIGRATE_TIMEOUT_MS, {}, ["--drop-legacy-role"]);
  if (run.code !== 0) throw new DeployError(`python -m mend_engine.db.migrate --drop-legacy-role exited ${run.code}`);
  const outcome = reportedRole(run.lines, LEGACY_DB_ROLE);
  if (outcome === "dropped") {
    changes.push(`db role ${LEGACY_DB_ROLE} dropped`);
    say(`action: migrate dropped the ${LEGACY_DB_ROLE} role, which no service uses any more`);
  } else if (outcome?.startsWith("in use")) {
    say(`database: ${LEGACY_DB_ROLE} kept for now, ${outcome}; a later \`up --migrate\` drops it`);
  } else if (outcome !== "absent") {
    throw new DeployError(`migrate did not report the ${LEGACY_DB_ROLE} role (${outcome ?? "no line"})`);
  }
}

function settingsProblem(name, wrong) {
  return new DeployError(`${name} exists but differs from the decided settings (${wrong.join("; ")}). Nothing was changed; fix it by hand or ask the head chef`);
}

function checkDatabaseSettings(db) {
  const wrong = [];
  if (!DATABASE.plans.includes(db.plan)) wrong.push(`plan ${db.plan}`);
  if (db.region !== REGION) wrong.push(`region ${db.region}`);
  if (db.databaseName !== DATABASE.databaseName) wrong.push(`database name ${db.databaseName}`);
  if (db.diskSizeGB !== DATABASE.diskSizeGB) wrong.push(`${db.diskSizeGB} GB storage`);
  if (db.highAvailabilityEnabled !== false) wrong.push("high availability is on");
  if (db.diskAutoscalingEnabled !== false) wrong.push("storage autoscaling is on");
  if ((db.readReplicas ?? []).length > 0) wrong.push("it has read replicas");
  if (db.suspended !== "not_suspended") wrong.push("it is suspended");
  if (wrong.length > 0) throw settingsProblem(DATABASE.name, wrong);
}

async function waitForDatabase(id) {
  const deadline = Date.now() + 20 * 60 * 1000;
  let shown = "";
  for (;;) {
    const db = await renderOk("GET", `/postgres/${id}`);
    if (db.status !== shown) {
      say(`database: ${db.name} is ${db.status}`);
      shown = db.status;
    }
    if (db.status === "available" || db.status === "maintenance_scheduled") return db;
    if (["suspended", "recovery_failed"].includes(db.status)) throw new DeployError(`mend-db is ${db.status}`);
    if (Date.now() > deadline) throw new DeployError(`mend-db was not available after 20 minutes (status ${db.status})`);
    await sleep(10_000);
  }
}

/** Only for `up --create` with no database recorded (resolveDatabase decided); its id is recorded at once. */
async function createDatabase(workspace, changes) {
  const db = await act(
    changes,
    `create Render Postgres ${DATABASE.name}: plan ${DATABASE.plans[0]}, ${DATABASE.diskSizeGB} GB, Postgres ${DATABASE.version}, region ${REGION} (about USD 6 a month)`,
    () =>
      renderOk(
        "POST",
        "/postgres",
        {
          name: DATABASE.name,
          ownerId: workspace.id,
          databaseName: DATABASE.databaseName,
          plan: DATABASE.plans[0],
          version: DATABASE.version,
          region: REGION,
          diskSizeGB: DATABASE.diskSizeGB,
          enableHighAvailability: false,
          enableDiskAutoscaling: false,
        },
        [201],
      ),
  );
  if (db === null) throw stop(`a plan-only run cannot go on without ${DATABASE.name}`);
  recordId({ workspace, database: { id: db.id, name: db.name } });
  say(`action: Render created ${db.name} ${db.id}, recorded in render-state.json`);
  return db;
}

const ALLOW_LIST_LABEL = "mend deploy machine";

// Asked of 1.1.1.1 by address, so the answer is this machine's IPv4 even when it also has
// IPv6; Render's database hosts answer on IPv4. A wrong answer only means the connection
// fails, because the database still demands its password over TLS.
async function publicIpv4() {
  const response = await fetch("https://1.1.1.1/cdn-cgi/trace", { redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const ip = /^ip=(.+)$/m.exec(await response.text())?.[1]?.trim() ?? "";
  if (!isIPv4(ip)) throw new DeployError("could not learn this machine's public IPv4 address");
  return ip;
}

const machineAccess = { dbId: null, depth: 0 };
let cleanupFailed = false;

/**
 * Render creates an API-made database with an empty allow list, which turns external access
 * off, and that is how it stays between runs. For one run, exactly this machine's address
 * (/32) is added under one label; entries with any other label are left as they are. This
 * and closeMachineAccess are the only writes prove may make.
 */
async function openMachineAccess(db) {
  const block = `${await publicIpv4()}/32`;
  const current = db.ipAllowList ?? [];
  const next = [...current.filter((entry) => entry.description !== ALLOW_LIST_LABEL), { cidrBlock: block, description: ALLOW_LIST_LABEL }];
  const same = current.length === next.length && next.every((entry) => current.some((had) => had.cidrBlock === entry.cidrBlock && had.description === entry.description));
  if (!same) await renderOk("PATCH", `/postgres/${db.id}`, { ipAllowList: next }, [200], { allowList: true });
  say(`database: this machine's public IPv4 address (/32 only) may reach ${DATABASE.name} for this run`);
}

async function closeMachineAccess(dbId) {
  try {
    const db = await renderOk("GET", `/postgres/${dbId}`);
    const current = db.ipAllowList ?? [];
    const next = current.filter((entry) => entry.description !== ALLOW_LIST_LABEL);
    if (next.length !== current.length) await renderOk("PATCH", `/postgres/${dbId}`, { ipAllowList: next }, [200], { allowList: true });
    say(`database: this machine's allow-list entry is removed (${next.length} entries left)`);
  } catch (error) {
    cleanupFailed = true;
    say(`FAIL  this machine's allow-list entry on ${DATABASE.name} could not be removed (${error instanceof Error ? error.message : "unknown"}); remove it in the Render dashboard`);
  }
}

/** Runs work with this machine allowed on mend-db, and removes the entry afterwards however work ends. Nested calls share one entry. */
async function withMachineAccess(db, work) {
  if (machineAccess.depth > 0 && machineAccess.dbId === db.id) {
    machineAccess.depth += 1;
    try {
      return await work();
    } finally {
      machineAccess.depth -= 1;
    }
  }
  Object.assign(machineAccess, { dbId: db.id, depth: 1 });
  try {
    // Inside the try: a PATCH that timed out may still have added the entry.
    await openMachineAccess(db);
    return await work();
  } finally {
    Object.assign(machineAccess, { dbId: null, depth: 0 });
    await closeMachineAccess(db.id);
  }
}

/** An allow-list change takes a moment to reach Render's proxy, so the first TLS connection is retried for up to three minutes. */
async function waitForExternalConnection(externalUrl) {
  const deadline = Date.now() + 3 * 60 * 1000;
  for (;;) {
    try {
      databaseRows(externalUrl, "select 1 as ok");
      return;
    } catch (error) {
      if (!(error instanceof DeployError) || Date.now() > deadline) throw error;
      await sleep(10_000);
    }
  }
}

/** mend-db's owner connection strings. Only the migrate command and this script's own checks use them; no service does. */
async function connectionInfo(dbId) {
  const info = await renderOk("GET", `/postgres/${dbId}/connection-info`);
  for (const value of Object.values(info ?? {})) addSecret(value);
  const isUrl = (text) => typeof text === "string" && /^postgres(ql)?:\/\/[^\s]+$/.test(text);
  if (!isUrl(info?.internalConnectionString) || !isUrl(info?.externalConnectionString)) {
    throw new DeployError("Render returned no usable connection strings for mend-db");
  }
  return { internal: info.internalConnectionString, external: info.externalConnectionString };
}

function databaseUser(text) {
  try {
    return decodeURIComponent(new URL(text).username);
  } catch {
    return "";
  }
}

function databasePassword(text) {
  try {
    return decodeURIComponent(new URL(text).password);
  } catch {
    return "";
  }
}

// The same host and database, compared after the same URL parser read both.
function sameDatabase(a, b) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.host === right.host && left.pathname === right.pathname;
  } catch {
    return false;
  }
}

/** The same database as connection, reached as one service role (C22). */
function roleConnection(connection, role, password) {
  const as = (text) => {
    const url = new URL(text);
    url.username = role;
    url.password = password;
    return url.href;
  };
  const reached = { internal: as(connection.internal), external: as(connection.external) };
  addSecret(reached.internal);
  addSecret(reached.external);
  return reached;
}

function engineSettings(reached) {
  const env = { PAYPAL_ENV: "sandbox", PAYPAL_CLIENT_ID: settings.PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET: settings.PAYPAL_CLIENT_SECRET, DATABASE_URL: reached.internal };
  for (const key of CAP_KEYS) env[key] = settings[key];
  return env;
}

/** Every env var a service should carry. Values come from .env, Render or this run's generated secrets, never from this file. */
function desiredEnv(spec, values) {
  const { roleConnections, engineToken, csrfSecret, engineUrl, webhookId, origin } = values;
  const app = roleConnections[DB_ROLES[spec.key]];
  if (spec.key === "web") {
    const env = {
      ...spec.buildEnv,
      PAYPAL_ENV: "sandbox",
      PAYPAL_CLIENT_ID: settings.PAYPAL_CLIENT_ID,
      PAYPAL_CLIENT_SECRET: settings.PAYPAL_CLIENT_SECRET,
      PAYPAL_READ_CLIENT_ID: settings.PAYPAL_READ_CLIENT_ID,
      PAYPAL_READ_CLIENT_SECRET: settings.PAYPAL_READ_CLIENT_SECRET,
      DATABASE_URL: app.internal,
      MEND_OWNER_PASSWORD: settings.MEND_OWNER_PASSWORD,
      MEND_CSRF_SECRET: csrfSecret,
      ANTHROPIC_API_KEY: settings.ANTHROPIC_API_KEY,
      MEND_ENGINE_TOKEN: engineToken,
    };
    // Both come from what Render reports (C24), so they join once the services exist.
    if (origin) env.MEND_BASE_URL = origin.origin;
    if (engineUrl) env.MEND_ENGINE_URL = engineUrl;
    if (webhookId) env.PAYPAL_WEBHOOK_ID = webhookId;
    return env;
  }
  if (spec.key === "engine") return { ...spec.buildEnv, ...engineSettings(app), MEND_ENGINE_TOKEN: engineToken };
  return { ...spec.buildEnv, ...engineSettings(app) };
}

function normalRepo(text) {
  return String(text ?? "").toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
}

function checkServiceSettings(spec, service) {
  const details = service.serviceDetails ?? {};
  const native = details.envSpecificDetails ?? {};
  const wrong = [];
  if (service.type !== spec.type) wrong.push(`type ${service.type}`);
  if (normalRepo(service.repo) !== normalRepo(REPO_URL)) wrong.push(`repo ${service.repo}`);
  if (service.branch !== BRANCH) wrong.push(`branch ${service.branch}`);
  if (service.rootDir !== spec.rootDir) wrong.push(`root directory ${service.rootDir}`);
  if (details.runtime !== spec.runtime) wrong.push(`runtime ${details.runtime}`);
  if (native.buildCommand !== spec.buildCommand) wrong.push("build command");
  if (native.startCommand !== spec.startCommand) wrong.push("start command");
  if (!STARTER.includes(details.plan)) wrong.push(`plan ${details.plan}`);
  if (details.region !== REGION) wrong.push(`region ${details.region}`);
  if (spec.type === "cron_job") {
    if (details.schedule !== spec.schedule) wrong.push(`schedule ${details.schedule}`);
  } else {
    if (details.numInstances !== 1) wrong.push(`${details.numInstances} instances`);
    if (details.autoscaling?.enabled === true) wrong.push("autoscaling is on");
    if (details.disk) wrong.push("it has a disk");
  }
  if (spec.healthCheckPath !== undefined && details.healthCheckPath !== spec.healthCheckPath) wrong.push(`health check path ${details.healthCheckPath}`);
  if ((service.autoDeployTrigger ?? (service.autoDeploy === "yes" ? "commit" : "off")) !== "commit") wrong.push("auto-deploy on push is off");
  if (service.suspended !== "not_suspended") wrong.push("it is suspended");
  if (wrong.length > 0) throw settingsProblem(spec.name, wrong);
}

function createBody(spec, ownerId, env) {
  const details = {
    runtime: spec.runtime,
    envSpecificDetails: { buildCommand: spec.buildCommand, startCommand: spec.startCommand },
    plan: STARTER[0],
    region: REGION,
  };
  if (spec.type === "cron_job") {
    details.schedule = spec.schedule;
  } else {
    Object.assign(details, { numInstances: 1, pullRequestPreviewsEnabled: "no", previews: { generation: "off" } });
  }
  if (spec.healthCheckPath !== undefined) details.healthCheckPath = spec.healthCheckPath;
  return {
    type: spec.type,
    name: spec.name,
    ownerId,
    repo: REPO_URL,
    branch: BRANCH,
    rootDir: spec.rootDir,
    autoDeployTrigger: "commit",
    envVars: Object.entries(env).map(([key, value]) => ({ key, value })),
    serviceDetails: details,
  };
}

/** The service resolveService found by its recorded id, or, only for `up --create` with none recorded, a new one whose id is recorded at once. */
async function placeService(workspace, resolved, spec, env, changes) {
  if (resolved.found) {
    say(`service: found ${resolved.found.name} ${resolved.found.id} by its recorded id`);
    return { service: resolved.found, deployId: null };
  }
  const extra = spec.type === "cron_job" ? `, schedule ${spec.schedule}` : "";
  const created = await act(
    changes,
    `create Render ${spec.type.replace("_", " ")} ${spec.name}: plan ${STARTER[0]}, region ${REGION}, ${REPO_URL} branch ${BRANCH}, root ${spec.rootDir}${extra} (${spec.cost}); env vars by name: ${Object.keys(env).join(", ")}`,
    () => renderOk("POST", "/services", createBody(spec, workspace.id, env), [201]),
  );
  if (created === null) throw stop(`a plan-only run cannot go on without ${spec.name}`);
  recordId({ services: { [spec.key]: { id: created.service.id, name: created.service.name } } });
  // A new cron job comes back with an empty deployId; ensureLive then finds its first deploy.
  const deployId = typeof created.deployId === "string" && created.deployId !== "" ? created.deployId : null;
  say(`action: Render created ${created.service.name} ${created.service.id}, recorded in render-state.json, first deploy ${deployId ?? "not named yet"}`);
  checkServiceSettings(spec, created.service);
  return { service: created.service, deployId };
}

async function serviceEnv(serviceId) {
  const rows = await renderList(`/services/${serviceId}/env-vars`, "envVar");
  const env = {};
  for (const row of rows) env[row.key] = row.value;
  for (const key of ["DATABASE_URL", "MEND_ENGINE_TOKEN", "MEND_CSRF_SECRET", "PAYPAL_CLIENT_SECRET", ...READ_KEYS, "MEND_OWNER_PASSWORD", "ANTHROPIC_API_KEY", "RENDER_API_KEY"]) {
    addSecret(env[key]);
  }
  return env;
}

/** Makes a service's env vars match `desired` and drops the keys it must never carry. Returns true if anything changed. */
async function syncEnv(spec, serviceId, desired, changes) {
  const current = await serviceEnv(serviceId);
  let changed = false;
  for (const [key, value] of Object.entries(desired)) {
    if (current[key] === value) continue;
    await act(changes, `set env var ${key} on ${spec.name} (${key in current ? "changed" : "new"})`, () =>
      renderOk("PUT", `/services/${serviceId}/env-vars/${key}`, { value }),
    );
    changed = true;
  }
  for (const key of spec.forbidden) {
    if (!(key in current)) continue;
    await act(changes, `remove env var ${key} from ${spec.name} (it must never be on that service)`, () =>
      renderOk("DELETE", `/services/${serviceId}/env-vars/${key}`, undefined, [200, 204]),
    );
    changed = true;
  }
  if (!changed) say(`env: ${spec.name} already has every env var it needs (${Object.keys(desired).length} keys)`);
  return changed;
}

async function waitForDeploy(serviceId, deployId) {
  if (!/^dep-[a-z0-9]{1,64}$/.test(deployId ?? "")) throw new DeployError(`Render gave a deploy id of an unexpected shape for ${serviceId}`);
  const deadline = Date.now() + 30 * 60 * 1000;
  let shown = "";
  for (;;) {
    const deploy = await renderOk("GET", `/services/${serviceId}/deploys/${deployId}`);
    if (deploy.status !== shown && deploy.status !== "live") {
      say(`deploy: ${deployId} is ${deploy.status}`);
      shown = deploy.status;
    }
    if (deploy.status === "live") {
      say(`deploy: ${deployId} is live on commit ${deploy.commit?.id?.slice(0, 7) ?? "unknown"}`);
      return deploy;
    }
    if (DEPLOY_FAILED.has(deploy.status)) throw new DeployError(`deploy ${deployId} ended ${deploy.status}; read its build log in the Render dashboard`);
    if (Date.now() > deadline) throw new DeployError(`deploy ${deployId} was not live after 30 minutes (status ${deploy.status})`);
    await sleep(15_000);
  }
}

async function triggerDeploy(spec, serviceId, reason, changes) {
  return act(changes, `start a new deploy of ${spec.name} (${reason})`, async () => {
    const deploy = await renderOk("POST", `/services/${serviceId}/deploys`, { clearCache: "do_not_clear" }, [201, 202]);
    say(`deploy: started ${deploy.id} of ${spec.name}`);
    return waitForDeploy(serviceId, deploy.id);
  });
}

/** Waits out a deploy already running, then makes sure one deploy is live, starting one only if none is. */
async function ensureLive(spec, serviceId, firstDeployId, changes) {
  if (firstDeployId !== null) return waitForDeploy(serviceId, firstDeployId);
  const newest = await latestDeploy(serviceId);
  if (newest !== null && DEPLOY_IN_PROGRESS.has(newest.status)) {
    say(`deploy: ${newest.id} of ${spec.name} is already running, waiting for it`);
    await waitForDeploy(serviceId, newest.id).catch(() => null);
  }
  const live = (await renderOk("GET", `/services/${serviceId}/deploys?status=live&limit=1`))[0]?.deploy ?? null;
  if (live !== null) {
    say(`deploy: ${live.id} of ${spec.name} is live on commit ${live.commit?.id?.slice(0, 7) ?? "unknown"}`);
    return live;
  }
  return triggerDeploy(spec, serviceId, "no deploy is live", changes);
}

async function waitForHealth(origin) {
  const url = new URL(SERVICES.web.healthCheckPath, origin);
  const deadline = Date.now() + 5 * 60 * 1000;
  let last = "no answer";
  for (;;) {
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
      const text = await response.text();
      if (response.status === 200 && text === "ok") return;
      last = `status ${response.status}`;
    } catch (error) {
      last = error?.cause?.code ?? error?.name ?? "network error";
    }
    if (Date.now() > deadline) throw new DeployError(`${url.href} did not say ok within 5 minutes (${last})`);
    await sleep(5_000);
  }
}

// PayPal's own rule for webhook_id, and the one packages/web/src/server/config.ts enforces.
const WEBHOOK_ID_SHAPE = /^[A-Za-z0-9]{1,50}$/;

function webhookPath(id) {
  if (typeof id !== "string" || !WEBHOOK_ID_SHAPE.test(id)) throw new DeployError("PayPal returned a webhook id with an unexpected shape");
  return `/v1/notifications/webhooks/${id}`;
}

async function deleteWebhook(id, why, changes) {
  await act(changes, `delete PayPal webhook ${id} (${why})`, async () => {
    const reply = await paypalCall("DELETE", webhookPath(id));
    if (reply.status !== 204) throw new DeployError(`PayPal webhook delete answered ${paypalProblem(reply)}`);
  });
}

function eventNames(hook) {
  return (hook?.event_types ?? []).map((type) => type.name).sort().join(",");
}

/**
 * The PayPal sandbox webhook for mend-web, at the URL built from Render's reported origin
 * (C24): the one resolveWebhook found by its recorded id or, only for `up --create` with
 * none recorded, a new one whose id is recorded at once. Leftovers from earlier tunnel
 * proofs (trycloudflare.com) are deleted; no other webhook is touched. The event list is
 * set to exactly EVENT_TYPES.
 */
async function placeWebhook(origin, resolved, changes) {
  const url = webhookUrlFor(origin);
  for (const hook of (await listWebhooks()).filter((entry) => hostOf(entry.url).endsWith(".trycloudflare.com"))) {
    await deleteWebhook(hook.id, "a leftover pointing at a trycloudflare.com tunnel", changes);
  }
  const wanted = [...EVENT_TYPES].sort().join(",");
  const subscriptions = EVENT_TYPES.map((name) => ({ name }));
  let hook = resolved.found ?? null;
  if (hook === null) {
    hook = await act(changes, `register a PayPal sandbox webhook for ${url} with ${EVENT_TYPES.length} event types`, async () => {
      const reply = await paypalCall("POST", "/v1/notifications/webhooks", { url, event_types: subscriptions });
      if (reply.status !== 201) throw new DeployError(`PayPal webhook create answered ${paypalProblem(reply)}`);
      webhookPath(reply.body?.id);
      recordId({ webhook: { id: reply.body.id, url, eventTypes: EVENT_TYPES.length } });
      say(`action: PayPal registered webhook ${reply.body.id}, recorded in render-state.json`);
      return reply.body;
    });
    if (hook === null) throw stop("a plan-only run cannot go on without the PayPal webhook");
  } else {
    say(`webhook: found ${hook.id} by its recorded id`);
  }
  if (eventNames(hook) !== wanted) {
    const updated = await act(changes, `set the event types of PayPal webhook ${hook.id} to the ${EVENT_TYPES.length} Mend listens for`, async () => {
      const reply = await paypalCall("PATCH", webhookPath(hook.id), [{ op: "replace", path: "/event_types", value: subscriptions }]);
      if (reply.status !== 200) throw new DeployError(`PayPal webhook update answered ${paypalProblem(reply)}`);
      return reply.body;
    });
    if (updated !== null) hook = updated;
  }
  if ((!options.planOnly && eventNames(hook) !== wanted) || !sameUrl(hook.url, url)) {
    throw new DeployError(`PayPal webhook ${hook.id} does not match the URL and events asked for`);
  }
  webhookPath(hook.id);
  return { id: hook.id, url, eventTypes: EVENT_TYPES.length };
}

function newSecret() {
  return randomBytes(GENERATED_SECRET_BYTES).toString("base64url");
}

function usable(value) {
  return typeof value === "string" && value.length >= MIN_GENERATED_CHARS && PRINTABLE.test(value);
}

/**
 * The secrets this script generates, reused from Render when they are already there:
 * MEND_CSRF_SECRET from mend-web; MEND_ENGINE_TOKEN only when mend-web and mend-engine hold
 * the same usable value, otherwise a new one for both; each role's database password from
 * the DATABASE_URL of the services that connect as that role, the only place it is kept. A
 * new role password is made only with --migrate, because only migrate can set it on mend-db.
 * envs holds each service's env vars as Render has them ({} for one not created yet).
 * Never printed or stored locally.
 */
function generatedSecrets(envs) {
  const csrfSecret = usable(envs.web.MEND_CSRF_SECRET) ? envs.web.MEND_CSRF_SECRET : newSecret();
  const shared = usable(envs.web.MEND_ENGINE_TOKEN) && envs.web.MEND_ENGINE_TOKEN === envs.engine.MEND_ENGINE_TOKEN;
  const engineToken = shared ? envs.web.MEND_ENGINE_TOKEN : newSecret();
  const passwords = {};
  for (const role of Object.keys(ROLE_PASSWORD_ENV)) {
    const kept = Object.keys(envs)
      .filter((key) => DB_ROLES[key] === role)
      .map((key) => envs[key].DATABASE_URL)
      .filter((text) => typeof text === "string" && databaseUser(text) === role)
      .map(databasePassword)
      .find(usable);
    if (kept === undefined && !options.migrate) {
      throw stop(`no service connects as ${role} yet; run \`up --migrate\` once so migrate can create it`);
    }
    passwords[role] = kept ?? newSecret();
    if (kept === undefined) say(`secret: generated a new ${ROLE_PASSWORD_ENV[role]} (48 random bytes) for the ${role} role`);
  }
  for (const value of [csrfSecret, engineToken, ...Object.values(passwords)]) addSecret(value);
  if (!usable(envs.web.MEND_CSRF_SECRET)) say("secret: generated a new MEND_CSRF_SECRET (48 random bytes) for mend-web");
  if (!shared) say("secret: generated a new MEND_ENGINE_TOKEN (48 random bytes) for mend-web and mend-engine");
  return { csrfSecret, engineToken, passwords };
}

/**
 * One step that changes something. A plan-only run (prove's drift check) records what it
 * would do and does nothing; otherwise the step runs and is logged as an action.
 */
async function act(changes, description, work) {
  changes.push(description);
  if (options.planOnly) {
    say(`would: ${description}`);
    return null;
  }
  say(`action: ${description}`);
  return work();
}

// Saved before a redeploy starts and cleared once it is live, so a run that dies in between
// still redeploys next time instead of leaving the new env vars unused.
function savePending(pending) {
  const { pending: _old, ...rest } = readState();
  writeState(Object.keys(pending).length > 0 ? { ...rest, pending: { ...pending } } : rest);
}

/** Syncs a service's env vars and redeploys it when they changed, or when an earlier run left a redeploy pending. */
async function settle(spec, service, desired, pending, changes) {
  const changed = await syncEnv(spec, service.id, desired, changes);
  if (!changed && !pending[spec.key]) return;
  pending[spec.key] ??= new Date().toISOString();
  savePending(pending);
  await triggerDeploy(spec, service.id, changed ? "so the env var changes are live" : "an earlier run changed env vars but never saw them go live", changes);
  delete pending[spec.key];
  savePending(pending);
}

function stateFor(workspace, db, services, origin, engineUrl, webhook, schemaSha256) {
  const describe = (spec, service, extra) => ({
    id: service.id,
    name: service.name,
    type: service.type,
    plan: service.serviceDetails?.plan,
    region: service.serviceDetails?.region,
    ...extra,
    dashboardUrl: service.dashboardUrl,
  });
  return {
    workspace,
    database: {
      id: db.id,
      name: db.name,
      plan: db.plan,
      region: db.region,
      postgres: db.version,
      diskSizeGB: db.diskSizeGB,
      schemaSha256,
      roles: { ...DB_ROLES },
      dashboardUrl: db.dashboardUrl,
    },
    services: {
      web: describe(SERVICES.web, services.web, { url: origin.origin }),
      engine: describe(SERVICES.engine, services.engine, { internalAddress: engineUrl, publicUrl: null }),
      jobs: describe(SERVICES.jobs, services.jobs, { schedule: services.jobs.serviceDetails?.schedule }),
    },
    webhook,
  };
}

/**
 * Brings every recorded resource to its decided settings, creating one only with --create
 * and only when none is recorded, and returns the list of things it changed (empty on a
 * repeat run). Every resource is found by its recorded id before anything is changed. With
 * planOnly set, nothing is changed and the list says what would be.
 */
async function up() {
  if (!existsSync(ENGINE_PYTHON)) throw new DeployError("the engine's virtual environment is missing (packages/engine/.venv)");
  checkDeploySettings();
  const changes = [];
  const previous = readState();
  const pending = { ...(previous.pending ?? {}) };
  const plan = await resolveResources(previous);
  const workspace = plan.workspace;
  say(`workspace: "${workspace.name}" ${workspace.id}`);
  if (plan.db.found) say(`database: found ${plan.db.found.name} ${plan.db.found.id} by its recorded id`);
  const placed = plan.db.found ?? (await createDatabase(workspace, changes));
  const db = await waitForDatabase(placed.id);
  checkDatabaseSettings(db);
  const connection = await connectionInfo(db.id);
  const envs = {};
  for (const key of Object.keys(SERVICES)) envs[key] = plan.services[key].found ? await serviceEnv(plan.services[key].found.id) : {};
  checkServiceDatabases(envs, connection);
  return withMachineAccess(db, () => upWithAccess(plan, db, connection, envs, previous, pending, changes));
}

/** A service already connected to some other database stops the run: `up` never repoints one. */
function checkServiceDatabases(envs, connection) {
  for (const [key, env] of Object.entries(envs)) {
    if (env.DATABASE_URL !== undefined && !sameDatabase(env.DATABASE_URL, connection.internal)) {
      throw stop(`${SERVICES[key].name} connects to another database than the recorded ${DATABASE.name}`);
    }
  }
}

async function upWithAccess(plan, db, connection, envs, previous, pending, changes) {
  const workspace = plan.workspace;
  await waitForExternalConnection(connection.external);

  const { csrfSecret, engineToken, passwords } = generatedSecrets(envs);
  const roleConnections = {};
  for (const role of Object.keys(ROLE_PASSWORD_ENV)) roleConnections[role] = roleConnection(connection, role, passwords[role]);
  const values = { roleConnections, engineToken, csrfSecret, engineUrl: null, webhookId: null, origin: null };

  let schemaSha256 = previous.database?.schemaSha256 ?? null;
  if (options.migrate) {
    schemaSha256 = (await migrateAndSeed(connection, roleConnections, passwords, changes)) ?? schemaSha256;
  } else {
    say("database: left as it is (pass --migrate to apply schema.sql and the services' roles, and seed the demo shop)");
  }

  const engine = await placeService(workspace, plan.services.engine, SERVICES.engine, desiredEnv(SERVICES.engine, values), changes);
  await ensureLive(SERVICES.engine, engine.service.id, engine.deployId, changes);
  await settle(SERVICES.engine, engine.service, desiredEnv(SERVICES.engine, values), pending, changes);
  const engineService = await renderOk("GET", `/services/${engine.service.id}`);
  values.engineUrl = engineAddress(engineService);
  if (values.engineUrl === null) throw new DeployError("Render reports no private network address for mend-engine yet");
  if (engineService.serviceDetails?.url?.startsWith?.("https://")) throw new DeployError("mend-engine reports a public https address; it must be private");
  say(`engine: mend-engine answers on Render's private network at ${values.engineUrl}`);

  const jobs = await placeService(workspace, plan.services.jobs, SERVICES.jobs, desiredEnv(SERVICES.jobs, values), changes);
  await ensureLive(SERVICES.jobs, jobs.service.id, jobs.deployId, changes);
  await settle(SERVICES.jobs, jobs.service, desiredEnv(SERVICES.jobs, values), pending, changes);

  const web = await placeService(workspace, plan.services.web, SERVICES.web, desiredEnv(SERVICES.web, values), changes);
  values.origin = serviceOrigin(web.service);
  await ensureLive(SERVICES.web, web.service.id, web.deployId, changes);
  await waitForHealth(values.origin);
  const webhook = await placeWebhook(values.origin, plan.webhook, changes);
  values.webhookId = webhook.id;
  await settle(SERVICES.web, web.service, desiredEnv(SERVICES.web, values), pending, changes);
  await waitForHealth(values.origin);
  say(`health: ${new URL(SERVICES.web.healthCheckPath, values.origin).href} says ok`);

  if (options.migrate) await dropLegacyRole(connection, { web: web.service.id, engine: engine.service.id, jobs: jobs.service.id }, changes);

  const services = { web: web.service, engine: engineService, jobs: jobs.service };
  if (writeState(stateFor(workspace, db, services, values.origin, values.engineUrl, webhook, schemaSha256))) {
    if (options.planOnly) changes.push("update render-state.json");
    say(`state: ${options.planOnly ? "would update" : "wrote"} scripts/deploy/render-state.json`);
  }
  if (options.planOnly) {
    say(`plan-only: \`up\` would make ${changes.length} changes`);
    return changes;
  }
  say(
    `D2 UP: ${values.origin.origin} live; mend-engine live at ${values.engineUrl} (private); mend-jobs every 5 minutes; database ${db.name} ${db.status}; webhook ${webhook.id} registered`,
  );
  return changes;
}

const DELIVERY_WAIT_MS = 4 * 60 * 1000;
const ATTRIBUTION_WAIT_MS = 4 * 60 * 1000;
const LOG_WAIT_MS = 2 * 60 * 1000;
// A delivery counts as handled by mend-engine when its outcome follows its arrival this
// closely: the cron job runs every 5 minutes, so it could not have been the cron.
const PROMPT_PROCESSING_MS = 90 * 1000;
const CANCEL_WAIT_MS = 3 * 60 * 1000;
const RESULTS_POLL_MS = 15_000;
// Shapes of a PayPal access token and an Anthropic key, so a token or key a service fetched
// or holds is caught even when this script never saw that exact value.
// The character class keeps the pre-commit secret check from reading this pattern as a key.
const SECRET_SHAPES = [/A21AA[A-Za-z0-9_-]{20,}/, /sk-an[t]-[A-Za-z0-9_-]{20,}/];
const GOAL = "bring back my quiet regulars, 50 dollars";
// No candidate count and no amount per customer are sent, so the demo default and the demo
// caps decide them, as for any visitor. seed_demo puts the test receiver first among the
// eligible members, so it is in every draft; the holdout is a fresh random draw, so a draft
// that holds it back is redrawn.
const PLAN_FORM = { holdoutShare: "0.50" };
// What a demo visitor's default plan comes to: 10 considered, 5 rewarded at 200 cents each.
const DEMO_PLAN = { budgetMinor: 1000, perRecipientMinor: 200, maxCandidates: 10, rewarded: 5, heldBack: 5 };
const DRAFTS_PER_DEMO_SESSION = 5;
const MAX_DRAWS = 10;
const AGENT_QUESTION = "How many quiet regulars does my shop have right now?";
const DELIVERY_HEADER_NAMES = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
};
const ENGINE_KEYS = ["PYTHON_VERSION", "PAYPAL_ENV", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "DATABASE_URL", ...CAP_KEYS, "MEND_ENGINE_TOKEN"];
const JOBS_KEYS = ENGINE_KEYS.filter((key) => key !== "MEND_ENGINE_TOKEN");

class ProofFailed extends Error {}

let allPassed = true;
// Every HTTP answer mend-web gave the proof, kept for the secrets sweep (C17).
const answers = [];

function line(passed, text) {
  if (!passed) allPassed = false;
  say(`${passed ? "PASS" : "FAIL"}  ${text}`);
}

/** Render's log entries for one resource between two times, newest pages first, de-duplicated by id. */
async function serviceLogs(ownerId, serviceId, since, maxEntries = 5_000) {
  const seen = new Map();
  let start = since.toISOString();
  let end = new Date().toISOString();
  for (let page = 0; page < 60; page += 1) {
    const query = new URLSearchParams({ ownerId, resource: serviceId, startTime: start, endTime: end, direction: "backward", limit: "100" });
    const body = await renderOk("GET", `/logs?${query}`);
    for (const entry of body?.logs ?? []) seen.set(entry.id, entry);
    if (!body?.hasMore || seen.size >= maxEntries) break;
    start = body.nextStartTime;
    end = body.nextEndTime;
  }
  return [...seen.values()];
}

/** The services' own JSON log records found in Render's log entries, each with the time Render logged it. */
function appRecords(entries) {
  return entries.flatMap((entry) => {
    const text = String(entry.message ?? "").trim();
    if (!text.startsWith("{")) return [];
    try {
      return [{ ...JSON.parse(text), loggedAt: Date.parse(entry.timestamp) }];
    } catch {
      return [];
    }
  });
}

async function waitForLogRecord(ownerId, serviceId, since, what, match) {
  const deadline = Date.now() + LOG_WAIT_MS;
  for (;;) {
    const found = appRecords(await serviceLogs(ownerId, serviceId, since, 2_000)).find(match);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new ProofFailed(`${what} did not appear in the Render logs within ${LOG_WAIT_MS / 1000} s`);
    await sleep(5_000);
  }
}

async function waitFor(what, timeoutMs, everyMs, attempt) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await attempt();
    if (result !== null && result !== undefined) return result;
    if (Date.now() > deadline) throw new ProofFailed(`${what} did not happen within ${Math.round(timeoutMs / 1000)} s`);
    await sleep(everyMs);
  }
}

function alterOneCharacter(raw) {
  const match = /"summary":"[^"\\]/.exec(raw) ?? /"create_time":"[0-9]/.exec(raw);
  if (match === null) throw new ProofFailed("no character to alter in the stored event");
  const at = match.index + match[0].length - 1;
  return raw.slice(0, at) + (raw[at] === "X" ? "Y" : "X") + raw.slice(at + 1);
}

async function check(label, run) {
  try {
    return await run();
  } catch (error) {
    line(false, `${label}: ${error instanceof Error ? error.message : "unexpected failure"}`);
    return null;
  }
}

// A payout batch PayPal holds for the shop, read when this run sent none.
const KNOWN_BATCH_ID = "JKEUJEAFGHFUN";

/** A client-credentials token for the read-only app in .env, with the scopes PayPal says it carries. The token is never printed. */
async function readAppToken() {
  const basic = Buffer.from(`${settings.PAYPAL_READ_CLIENT_ID}:${settings.PAYPAL_READ_CLIENT_SECRET}`).toString("base64");
  const response = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: "grant_type=client_credentials",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null);
  if (response.status !== 200 || typeof body?.access_token !== "string") throw new ProofFailed(`the read-only app's token request answered ${response.status}`);
  addSecret(body.access_token);
  return { token: body.access_token, scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [] };
}

/**
 * prove's "read keys" check: mend-web holds both read-only settings (names only, never
 * values), the read-only app's token from .env carries no scope naming payouts, and PayPal
 * answers 403 when that token asks for a payout batch (this run's, or KNOWN_BATCH_ID).
 * A token PayPal names no scopes for fails, so an empty answer cannot pass. Returns
 * { passed, text }; the text holds the scope count and PayPal's status, nothing else.
 */
async function readKeysCheck(webEnv, batchId) {
  const problems = [];
  const missing = READ_KEYS.filter((key) => typeof webEnv[key] !== "string" || webEnv[key] === "");
  if (missing.length > 0) problems.push(`mend-web lacks ${missing.join(", ")}`);
  const { token, scopes } = await readAppToken();
  const payoutScopes = scopes.filter((scope) => /payout/i.test(scope)).length;
  if (scopes.length === 0) problems.push("PayPal named no scopes for the token");
  if (payoutScopes > 0) problems.push(`${payoutScopes} of them for payouts`);
  const id = typeof batchId === "string" && /^[A-Z0-9]{1,32}$/.test(batchId) ? batchId : KNOWN_BATCH_ID;
  const response = await fetch(`${PAYPAL_API}/v1/payments/payouts/${id}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await response.body?.cancel().catch(() => undefined);
  if (response.status !== 403) problems.push(`the payout batch read answered ${response.status}, not 403`);
  return {
    passed: problems.length === 0,
    text: `read keys: mend-web holds both read-only settings; the read-only app's token carries ${scopes.length} scopes, none for payouts, and PayPal answers ${response.status} when it asks for a payout batch${problems.length ? ` (${problems.join("; ")})` : ""}`,
  };
}

async function otherPaidResources(ownerId, ours) {
  const paid = [];
  for (const service of await renderList(`/services?ownerId=${ownerId}`, "service")) {
    if (!ours.services.includes(service.id) && service.type !== "static_site" && service.serviceDetails?.plan !== "free") {
      paid.push(`service ${service.name} (${service.type}, ${service.serviceDetails?.plan})`);
    }
  }
  for (const db of await renderList(`/postgres?ownerId=${ownerId}`, "postgres")) {
    if (db.id !== ours.database && db.plan !== "free") paid.push(`Postgres ${db.name} (${db.plan})`);
  }
  for (const kv of await renderList(`/key-value?ownerId=${ownerId}`, "keyValue")) {
    if (kv.plan !== "free") paid.push(`Key Value ${kv.name} (${kv.plan})`);
  }
  for (const redis of await renderList(`/redis?ownerId=${ownerId}`, "redis")) {
    if (redis.plan !== "free") paid.push(`Redis ${redis.name} (${redis.plan})`);
  }
  for (const disk of await renderList(`/disks?ownerId=${ownerId}`, "disk")) paid.push(`disk ${disk.name} (${disk.sizeGB} GB)`);
  // Workflows bill by the second of compute they use, so any workflow counts.
  for (const workflow of await renderList(`/workflows?ownerId=${ownerId}`, "workflow")) paid.push(`workflow ${workflow.name}`);
  return paid;
}

// What one campaign adds to the demo pool under the engine's own rule (campaigns.spend: an
// item PayPal sent back stops counting), so other visitors' campaigns cannot move the number.
const CAMPAIGN_COUNTED_SCRIPT = `
import os, sys, certifi, psycopg
from mend_engine.campaigns.spend import ITEM_CAME_BACK_SQL, MONEY_BACK_STATUSES
with psycopg.connect(os.environ["MEND_D1_DATABASE_URL"], sslmode="verify-full", sslrootcert=certifi.where(), connect_timeout=15, autocommit=True) as conn:
    row = conn.execute(
        "select coalesce(sum((item ->> 'amount_minor')::bigint), 0) from approved_snapshots s "
        "cross join lateral jsonb_array_elements(s.canonical_json::jsonb -> 'items') item "
        "where s.campaign_id = %s::uuid and not " + ITEM_CAME_BACK_SQL,
        (sys.argv[1], list(MONEY_BACK_STATUSES)),
    ).fetchone()
    print(row[0])
`;

// Each attempt runs in a transaction that is always rolled back, so even a privilege that
// were wrongly granted could not change mend-db during the proof.
const ROLE_PROBE_SCRIPT = `
import json, os, sys, certifi, psycopg
attempts = json.loads(sys.argv[1])
out = {}
with psycopg.connect(os.environ["MEND_D1_DATABASE_URL"], sslmode="verify-full", sslrootcert=certifi.where(), connect_timeout=15, autocommit=True) as conn:
    out["user"] = conn.execute("select current_user").fetchone()[0]
    for name, statement in attempts:
        try:
            with conn.transaction(force_rollback=True):
                conn.execute(statement)
            out[name] = "ok"
        except psycopg.Error as error:
            out[name] = error.sqlstate or type(error).__name__
print(json.dumps(out))
`;
const INSUFFICIENT_PRIVILEGE = "42501";
const CAMPAIGN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function engineScript(script, args, externalUrl, what) {
  const result = spawnSync(ENGINE_PYTHON, ["-c", script, ...args], {
    cwd: ENGINE_DIR,
    env: { ...process.env, MEND_D1_DATABASE_URL: externalUrl },
    encoding: "utf8",
    timeout: 90_000,
    windowsHide: true,
  });
  const last = result.stdout.trim().split(/\r?\n/).pop() ?? "";
  if (result.status !== 0 || last === "") {
    throw new ProofFailed(`could not read ${what} (exit ${result.status}: ${result.stderr.trim().split(/\r?\n/).pop() ?? ""})`);
  }
  return last;
}

function campaignCountedMinor(externalUrl, campaignId) {
  if (!CAMPAIGN_UUID.test(campaignId)) throw new ProofFailed("a campaign id of an unexpected shape");
  const value = engineScript(CAMPAIGN_COUNTED_SCRIPT, [campaignId], externalUrl, "the campaign's demo pool count");
  if (!/^[0-9]+$/.test(value)) throw new ProofFailed("the campaign's demo pool count is not a whole number");
  return Number(value);
}

// What each service role is tried with. Every statement either reads or is refused, and runs
// in a rolled-back transaction either way.
const ROLE_ATTEMPTS = {
  mend_engine: [
    ["disable_trigger", "alter table audit_log disable trigger audit_log_append_only"],
    ["update_audit_log", "update audit_log set actor = actor where false"],
    ["create_table", "create table mend_role_probe (id integer)"],
    ["select", "select count(*) from audit_log"],
  ],
  mend_web: [
    ["update_payout_items", "update payout_items set status = status where false"],
    ["update_audit_log", "update audit_log set actor = actor where false"],
    ["create_table", "create table mend_role_probe (id integer)"],
    ["select", "select count(*) from sessions"],
  ],
};

function roleProbe(externalUrl, role) {
  return JSON.parse(engineScript(ROLE_PROBE_SCRIPT, [JSON.stringify(ROLE_ATTEMPTS[role])], externalUrl, `what ${role} may do`));
}

/** One visitor's browser: a cookie jar, the CSRF token its pages hold, and the same-origin header a browser sends. */
class Browser {
  constructor(origin) {
    this.origin = origin;
    this.cookies = new Map();
    this.csrf = "";
  }

  async send(method, route, body) {
    const headers = { accept: "application/json" };
    const jar = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    if (jar !== "") headers.cookie = jar;
    if (method === "POST") {
      headers.origin = this.origin.origin;
      if (this.csrf !== "") headers["x-mend-csrf"] = this.csrf;
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(new URL(route, this.origin), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(150_000),
    });
    const text = await response.text();
    // Set-Cookie carries the session token by design; everything else is swept for secrets.
    answers.push(text, ...[...response.headers].filter(([name]) => name !== "set-cookie").map(([name, value]) => `${name}: ${value}`));
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (name.endsWith("mend_session")) addSecret(value);
      if (/Max-Age=0\b/i.test(cookie) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    let parsed = {};
    try {
      parsed = JSON.parse(text) ?? {};
    } catch {
      parsed = {};
    }
    if (typeof parsed.csrf === "string") this.csrf = parsed.csrf;
    return { status: response.status, body: parsed, text };
  }

  /** A 202 is polled at /api/runs/<runId> until the run finishes; any other answer comes back as it is. */
  async settle(answer, timeoutMs = 180_000) {
    if (answer.status !== 202 || typeof answer.body.runId !== "string") return answer;
    return waitFor(`run ${answer.body.runId}`, timeoutMs, 1_500, async () => {
      const polled = await this.send("GET", `/api/runs/${answer.body.runId}`);
      return polled.status === 202 ? null : polled;
    });
  }
}

async function demoSession(origin) {
  const browser = new Browser(origin);
  await browser.send("GET", "/api/session");
  const started = await browser.send("POST", "/api/session/demo");
  if (started.status !== 200 || started.body.role !== "demo") throw new ProofFailed(`a demo session answered ${started.status}`);
  return browser;
}

function digitsIn(text, count) {
  return new RegExp(`(^|[^0-9,])(${count}|${count.toLocaleString("en-US")})([^0-9,]|$)`).test(text);
}

/**
 * The live proof against https://mend-web.onrender.com and the services behind it. Prints one
 * PASS or FAIL line per check and ends "D2 RESULT: PASS" only when every check passed. A demo
 * campaign pays 10.00 USD of sandbox rewards (5 customers at 2.00 USD) plus 1.25 USD of
 * PayPal sandbox fees per run; one simulated return purchase is a 12.50 USD sandbox card
 * order into the shop.
 *
 * Compare-only: every Render and PayPal write is refused in code, render-state.json is never
 * written, and the idempotent check runs `up` in plan-only mode. The one write is this
 * machine's allow-list entry on mend-db, removed at the end of the run whatever happens.
 */
async function prove() {
  compareOnly = true;
  checkDeploySettings();
  const receiver = settings.MEND_TEST_RECEIVER.trim().toLowerCase();
  const state = readState();
  if (!state.services?.web?.id || !state.services?.engine?.id || !state.services?.jobs?.id || !state.database?.id || !state.webhook?.id) {
    throw new DeployError("render-state.json is incomplete; run `up --migrate` first");
  }
  const startedAt = new Date();
  // Found by recorded id, with the same stops as `up`, before anything else is read.
  const plan = await resolveResources(state);
  const workspace = plan.workspace;
  const services = {};
  for (const spec of Object.values(SERVICES)) services[spec.key] = plan.services[spec.key].found;
  const db = plan.db.found;
  // C24: every address under test comes from Render's own report, not from the state file.
  const origin = serviceOrigin(services.web);
  const engineUrl = engineAddress(services.engine);
  const webhookUrl = webhookUrlFor(origin);
  const connection = await connectionInfo(db.id);
  const envs = {};
  for (const key of Object.keys(SERVICES)) envs[key] = await serviceEnv(services[key].id);
  // The proof reads mend-db with the services' own credentials (C22), over the external host.
  const reached = {};
  for (const key of ["engine", "web"]) {
    const role = DB_ROLES[key];
    const url = envs[key].DATABASE_URL ?? "";
    if (databaseUser(url) !== role || !usable(databasePassword(url))) {
      throw new DeployError(`${SERVICES[key].name} does not connect as ${role}; run \`up --migrate\` first`);
    }
    reached[role] = roleConnection(connection, role, databasePassword(url));
  }
  const context = { receiver, startedAt, workspace, services, db, origin, engineUrl, webhookUrl, connection, envs, reached };
  await withMachineAccess(db, () => proveChecks(context));
  const passed = allPassed && !leakedLine && !cleanupFailed;
  say(`D2 RESULT: ${passed ? "PASS" : "FAIL"}`);
  if (!passed) process.exitCode = 1;
}

async function proveChecks({ receiver, startedAt, workspace, services, db, origin, engineUrl, webhookUrl, connection, envs, reached }) {
  await waitForExternalConnection(connection.external);
  const rows = (sql, params = []) => databaseRows(reached.mend_engine.external, sql, params);

  await check("health", async () => {
    const url = new URL(SERVICES.web.healthCheckPath, origin);
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await response.text();
    line(response.status === 200 && text === "ok", `health: ${url.href} says ok${response.status === 200 ? "" : ` (got ${response.status})`}`);
  });

  await check("plan", async () => {
    const problems = [];
    for (const spec of Object.values(SERVICES)) {
      const details = services[spec.key].serviceDetails ?? {};
      if (!STARTER.includes(details.plan)) problems.push(`${spec.name} plan ${details.plan}`);
      if (details.region !== REGION) problems.push(`${spec.name} region ${details.region}`);
    }
    if (!DATABASE.plans.includes(db.plan)) problems.push(`mend-db plan ${db.plan}`);
    if (db.region !== REGION) problems.push(`mend-db region ${db.region}`);
    if (db.diskSizeGB !== DATABASE.diskSizeGB) problems.push(`mend-db ${db.diskSizeGB} GB`);
    const ours = { services: Object.values(services).map((service) => service.id), database: db.id };
    problems.push(...(await otherPaidResources(workspace.id, ours)).map((item) => `also paid: ${item}`));
    line(
      problems.length === 0,
      `plan: mend-web, mend-engine and mend-jobs are Starter, mend-db is basic 256 MB, region virginia; no other paid service in the workspace${problems.length ? ` (${problems.join("; ")})` : ""}`,
    );
  });

  await check("env", async () => {
    const problems = [];
    const required = { web: WEB_APP_KEYS, engine: ENGINE_KEYS, jobs: JOBS_KEYS };
    for (const spec of Object.values(SERVICES)) {
      const env = envs[spec.key];
      const missing = required[spec.key].filter((key) => typeof env[key] !== "string" || env[key] === "");
      if (missing.length > 0) problems.push(`${spec.name} lacks ${missing.join(", ")}`);
      const forbidden = spec.forbidden.filter((key) => key in env);
      if (forbidden.length > 0) problems.push(`${spec.name} carries ${forbidden.join(", ")}`);
      if (env.PAYPAL_ENV !== "sandbox") problems.push(`${spec.name} PAYPAL_ENV is not sandbox`);
      const role = DB_ROLES[spec.key];
      const user = databaseUser(env.DATABASE_URL);
      if (user === databaseUser(connection.internal)) problems.push(`${spec.name} DATABASE_URL uses mend-db's owner role`);
      if (user === LEGACY_DB_ROLE) problems.push(`${spec.name} still connects as ${LEGACY_DB_ROLE}`);
      if (env.DATABASE_URL !== reached[role].internal || !sameDatabase(env.DATABASE_URL, connection.internal)) {
        problems.push(`${spec.name} DATABASE_URL is not mend-db's internal address as ${role}`);
      }
    }
    if (envs.web.MEND_ENGINE_TOKEN !== envs.engine.MEND_ENGINE_TOKEN) problems.push("mend-web and mend-engine hold different engine tokens");
    if (envs.web.MEND_ENGINE_URL !== engineUrl) problems.push("MEND_ENGINE_URL is not mend-engine's reported address");
    if (envs.web.MEND_BASE_URL !== origin.origin) problems.push("MEND_BASE_URL is not mend-web's reported origin");
    const hooks = (await listWebhooks()).filter((hook) => sameUrl(hook.url, webhookUrl));
    if (hooks.length !== 1 || hooks[0].id !== envs.web.PAYPAL_WEBHOOK_ID) problems.push("PAYPAL_WEBHOOK_ID is not the one PayPal webhook for the live URL");
    line(
      problems.length === 0,
      `env: all three services hold exactly what they need, PAYPAL_ENV sandbox everywhere, one engine token shared by mend-web and mend-engine only, every DATABASE_URL on mend-db as the service's own role (mend-web as mend_web, mend-engine and mend-jobs as mend_engine) and none as mend-db's owner or ${LEGACY_DB_ROLE}${problems.length ? ` (${problems.join("; ")})` : ""}`,
    );
  });

  await check("render key", async () => {
    const holders = Object.values(SERVICES).filter((spec) => "RENDER_API_KEY" in envs[spec.key] || Object.values(envs[spec.key]).includes(settings.RENDER_API_KEY));
    line(holders.length === 0, `render key: no service holds RENDER_API_KEY, under that name or any other${holders.length ? ` (found on ${holders.map((spec) => spec.name).join(", ")})` : ""}`);
  });

  await check("database role", async () => {
    const engine = roleProbe(reached.mend_engine.external, "mend_engine");
    const web = roleProbe(reached.mend_web.external, "mend_web");
    const refused = (tried, names) => names.every((name) => tried[name] === INSUFFICIENT_PRIVILEGE);
    line(
      engine.user === "mend_engine" &&
        refused(engine, ["disable_trigger", "update_audit_log", "create_table"]) &&
        engine.select === "ok" &&
        web.user === "mend_web" &&
        refused(web, ["update_payout_items", "update_audit_log", "create_table"]) &&
        web.select === "ok",
      `database role: as ${engine.user} with mend-engine's credentials, ALTER TABLE audit_log DISABLE TRIGGER, UPDATE audit_log and CREATE TABLE are refused (SQLSTATE ${engine.disable_trigger}, ${engine.update_audit_log}, ${engine.create_table}) and a SELECT works (${engine.select}); as ${web.user} with mend-web's credentials, UPDATE payout_items, UPDATE audit_log and CREATE TABLE are refused (SQLSTATE ${web.update_payout_items}, ${web.update_audit_log}, ${web.create_table}) and a SELECT on sessions works (${web.select})`,
    );
  });

  await check("private", async () => {
    const reported = String(services.engine.serviceDetails?.url ?? "");
    const publicLooking = /^https?:\/\//.test(reported) || reported.includes(".onrender.com");
    const name = new URL(engineUrl ?? "http://unknown:1").hostname;
    // Asked of public resolvers: the private name must not exist on the public internet.
    const { Resolver } = await import("node:dns/promises");
    const resolver = new Resolver({ timeout: 5_000, tries: 2 });
    resolver.setServers(["1.1.1.1", "8.8.8.8"]);
    const resolved = await resolver.resolve4(name).then((found) => found, () => []);
    line(
      services.engine.type === "private_service" && engineUrl !== null && !publicLooking && resolved.length === 0,
      `private: mend-engine is a private service with no public URL; its address ${engineUrl} does not resolve on public DNS`,
    );
  });

  const journey = await check("journey", async () => {
    const memberRow = rows("select member_id::text as id from members where paypal_email = %s and email_verified", [receiver])[0];
    if (!memberRow) throw new ProofFailed("MEND_TEST_RECEIVER is not a verified member of mend-db; run `up --migrate`");
    let browser = await demoSession(origin);
    let draftsInSession = 0;
    let planned = null;
    let draws = 0;
    while (draws < MAX_DRAWS) {
      if (draftsInSession === DRAFTS_PER_DEMO_SESSION) {
        browser = await demoSession(origin);
        draftsInSession = 0;
      }
      const first = await browser.send("POST", "/api/campaigns/plan", { goalText: GOAL, ...PLAN_FORM });
      const done = await browser.settle(first);
      draws += 1;
      draftsInSession += 1;
      if (done.status !== 201 && done.status !== 200) throw new ProofFailed(`the plan answered ${done.status} ${done.text.slice(0, 200)}`);
      const campaignId = String(done.body.campaignId ?? "");
      const role = rows("select role, ref from campaign_members where campaign_id::text = %s and member_id::text = %s", [campaignId, memberRow.id])[0];
      // The ranking is the same on every draw, so a receiver left out once is left out every time.
      if (role === undefined) throw new ProofFailed(`the test receiver is not among the ${DEMO_PLAN.maxCandidates} candidates of a demo draft; run \`up --migrate\` so seed_demo moves it to rank 1`);
      if (role.role === "reward") {
        planned = { campaignId, plan: first.body.plan, aiCalls: Number(first.body.aiCalls ?? 0), ref: role.ref, rewarded: done.body.rewarded, heldBack: done.body.heldBack };
        break;
      }
    }
    if (planned === null) throw new ProofFailed(`the test receiver was held back in all ${MAX_DRAWS} draws across two demo sessions`);
    const settingsRead = planned.plan?.settings ?? {};
    const amounts = rows("select amount_minor from campaign_members where campaign_id::text = %s and role = 'reward'", [planned.campaignId]).map((row) => row.amount_minor);
    const total = amounts.reduce((sum, amount) => sum + amount, 0);
    line(
      planned.plan?.goal === "read" &&
        planned.aiCalls >= 1 &&
        settingsRead.budgetMinor === DEMO_PLAN.budgetMinor &&
        settingsRead.perRecipientMinor === DEMO_PLAN.perRecipientMinor &&
        settingsRead.maxCandidates === DEMO_PLAN.maxCandidates &&
        planned.rewarded === DEMO_PLAN.rewarded &&
        planned.heldBack === DEMO_PLAN.heldBack &&
        amounts.length === DEMO_PLAN.rewarded &&
        amounts.every((amount) => amount === DEMO_PLAN.perRecipientMinor) &&
        total === DEMO_PLAN.budgetMinor,
      `journey plan: a demo session asked "${GOAL}"; Claude read it (${planned.aiCalls} call), the demo caps and default set ${settingsRead.budgetMinor} cents, ${settingsRead.perRecipientMinor} per customer, ${settingsRead.maxCandidates} considered; campaign ${planned.campaignId} rewards ${planned.rewarded} at ${amounts.join(", ")} cents (${total} in total) and holds back ${planned.heldBack}, the test receiver rewarded on draw ${draws}`,
    );

    const notes = await browser.settle(await browser.send("POST", `/api/campaigns/${planned.campaignId}/notes`));
    const written = Number(notes.body.written ?? 0);
    line(
      notes.status === 200 && written >= 1 && Number(notes.body.skipped ?? -1) === 0 && written + Number(notes.body.template ?? 0) === Number(planned.rewarded),
      `journey notes: Claude wrote ${written} personal notes, ${String(notes.body.template)} fell back to the shop's template, none skipped`,
    );

    const view = await browser.settle(await browser.send("GET", `/api/campaigns/${planned.campaignId}`));
    const reviewHash = String(view.body.reviewHash ?? "");
    const receiverRow = (view.body.rows ?? []).find((row) => row.ref === planned.ref);
    const approved = await browser.settle(await browser.send("POST", `/api/campaigns/${planned.campaignId}/approve`, { presentedHash: reviewHash }));
    const submitted = await browser.settle(await browser.send("POST", `/api/campaigns/${planned.campaignId}/submit`));
    const submittedAt = Date.now();
    const batchId = String(submitted.body.payoutBatchId ?? "");
    const atPayPal = /^[A-Z0-9]{1,32}$/.test(batchId) ? await paypalCall("GET", `/v1/payments/payouts/${batchId}`) : null;
    const ledger = rows("select payout_batch_id, sender_batch_id from payout_batches where campaign_id = %s", [planned.campaignId]);
    const batchStatus = atPayPal?.body?.batch_header?.batch_status;
    line(
      view.status === 200 &&
        /^[0-9a-f]{64}$/.test(reviewHash) &&
        typeof receiverRow?.note === "string" &&
        approved.status === 200 &&
        approved.body.snapshotHash === reviewHash &&
        submitted.status === 200 &&
        submitted.body.sent === true &&
        atPayPal?.status === 200 &&
        ["PENDING", "PROCESSING", "SUCCESS"].includes(batchStatus) &&
        ledger.length === 1 &&
        ledger[0].payout_batch_id === batchId &&
        atPayPal.body.batch_header?.sender_batch_header?.sender_batch_id === ledger[0].sender_batch_id,
      `journey payout: the draft was viewed with its hash, approved with that hash and submitted; PayPal holds batch ${batchId} (${batchStatus}) under the ledger's sender_batch_id`,
    );
    return { ...planned, browser, batchId, submittedAt };
  });

  await check("read keys", async () => {
    const result = await readKeysCheck(envs.web, journey?.batchId);
    line(result.passed, result.text);
  });

  let delivered = null;
  if (journey === null) line(false, "delivery: skipped, no batch was sent");
  else delivered = await check("delivery", async () => {
    const item = await waitFor("the test receiver's item reaching SUCCESS in mend-db", DELIVERY_WAIT_MS, 5_000, async () => {
      const found = rows(
        "select i.payout_item_id, i.status, (item ->> 'amount_minor')::int as amount_minor from approved_snapshots s " +
          "cross join lateral jsonb_array_elements(s.canonical_json::jsonb -> 'items') item " +
          "join payout_batches b on b.campaign_id = s.campaign_id::text " +
          "join payout_items i on i.sender_batch_id = b.sender_batch_id and i.sender_item_id = item ->> 'sender_item_id' " +
          "where s.campaign_id::text = %s and lower(item ->> 'receiver_email') = %s",
        [journey.campaignId, receiver],
      )[0];
      return found?.status === "SUCCESS" ? found : null;
    });
    const seconds = Math.round((Date.now() - journey.submittedAt) / 1000);
    const events = rows(
      "select e.transmission_id, e.event_id, e.event_type, e.raw, (extract(epoch from e.received_at) * 1000)::float8 as received_ms, " +
        "(extract(epoch from o.processed_at) * 1000)::float8 as processed_ms, o.outcome from paypal_events e " +
        "left join event_outcomes o on o.transmission_id = e.transmission_id " +
        "where e.event_type like %s and strpos(e.raw, %s) > 0 order by e.received_at",
      ["PAYMENT.PAYOUTS%", journey.batchId],
    );
    const prompt = events.filter((event) => event.processed_ms !== null && event.processed_ms - event.received_ms <= PROMPT_PROCESSING_MS);
    if (prompt.length === 0) throw new ProofFailed(`no stored delivery for batch ${journey.batchId} was processed within ${PROMPT_PROCESSING_MS / 1000} s (${events.length} stored)`);
    const event = prompt[0];
    const copies = rows("select count(*)::int as n from paypal_events where event_id = %s", [event.event_id])[0].n;
    const since = new Date(journey.submittedAt - 60_000);
    const stored = await waitForLogRecord(workspace.id, services.web.id, since, "mend-web's log line for the stored delivery", (entry) => entry.kind === "webhook" && entry.outcome === "stored" && entry.transmission_id === event.transmission_id);
    const ran = await waitForLogRecord(
      workspace.id,
      services.engine.id,
      since,
      "mend-engine's log line for process_events",
      (entry) => entry.kind === "task_server" && entry.task === "process_events" && entry.status === 200 && entry.loggedAt >= event.received_ms - 5_000 && entry.loggedAt <= event.processed_ms + 10_000,
    );
    line(
      copies === 1 && stored.status === 200 && ran !== null,
      `delivery: PayPal's ${event.event_type} for batch ${journey.batchId} reached mend-web, was verified and stored once; mend-engine ran process_events ${Math.round((event.processed_ms - event.received_ms) / 1000)} s after it arrived (outcome ${event.outcome}); the test receiver's item ${item.payout_item_id} is SUCCESS ${seconds} s after submit`,
    );
    return { event, headers: stored.delivery, item };
  });

  const pool = { before: null, after: null };
  await check("cancel", async () => {
    if (journey === null || delivered === null) throw new ProofFailed("skipped, no campaign reached the receiver");
    const cancelUrl = `/api/campaigns/${journey.campaignId}/cancel-unclaimed`;
    const resultsUrl = `/api/campaigns/${journey.campaignId}/results`;
    const others = DEMO_PLAN.rewarded - 1;
    const othersMinor = others * DEMO_PLAN.perRecipientMinor;
    const first = await journey.browser.settle(await journey.browser.send("GET", resultsUrl));
    const shown = first.body.payouts ?? {};
    const counted = Object.values(shown.byStatus ?? {}).reduce((sum, n) => sum + n, 0);
    const firstOk =
      first.status === 200 &&
      shown.items === DEMO_PLAN.rewarded &&
      shown.claimedMinor === DEMO_PLAN.perRecipientMinor &&
      shown.unclaimedMinor + shown.pendingMinor === othersMinor &&
      counted === DEMO_PLAN.rewarded;
    if (!firstOk) throw new ProofFailed(`results before the cancel showed ${JSON.stringify(shown)} (answer ${first.status})`);
    // The @shop.example receivers are not PayPal accounts, so PayPal marks their items UNCLAIMED, usually within a minute.
    const waiting = await waitFor(`PayPal reporting the ${others} other items UNCLAIMED`, CANCEL_WAIT_MS, RESULTS_POLL_MS, async () => {
      const polled = await journey.browser.settle(await journey.browser.send("GET", resultsUrl));
      return polled.body.payouts?.byStatus?.UNCLAIMED === others ? polled.body.payouts : null;
    });
    pool.before = campaignCountedMinor(reached.mend_engine.external, journey.campaignId);
    const cancelled = await journey.browser.settle(await journey.browser.send("POST", cancelUrl));
    pool.after = campaignCountedMinor(reached.mend_engine.external, journey.campaignId);
    const after = (await journey.browser.settle(await journey.browser.send("GET", resultsUrl))).body.payouts ?? {};
    line(
      cancelled.status === 200 &&
        cancelled.body.cancelled === others &&
        cancelled.body.returnedMinor === othersMinor &&
        cancelled.body.stillUnclaimed === 0 &&
        cancelled.body.notCancellable === 0 &&
        after.returnedMinor === othersMinor &&
        after.unclaimedMinor === 0 &&
        after.claimedMinor === DEMO_PLAN.perRecipientMinor,
      `cancel: results showed ${shown.items} items, ${shown.claimedMinor} cents claimed by the test receiver and ${othersMinor} unclaimed or pending; once PayPal held ${waiting.byStatus.UNCLAIMED} UNCLAIMED, the demo visitor's cancel-unclaimed answered cancelled ${String(cancelled.body.cancelled)}, returnedMinor ${String(cancelled.body.returnedMinor)}, stillUnclaimed ${String(cancelled.body.stillUnclaimed)}, notCancellable ${String(cancelled.body.notCancellable)}; results now show returnedMinor ${String(after.returnedMinor)}, unclaimedMinor ${String(after.unclaimedMinor)}, claimedMinor ${String(after.claimedMinor)}`,
    );
  });

  await check("demo pool", async () => {
    if (pool.before === null || pool.after === null) throw new ProofFailed("skipped, the cancel did not run");
    line(
      pool.after === DEMO_PLAN.perRecipientMinor,
      `demo pool: under the engine's own rule this campaign counted ${pool.before} cents toward the demo pool before the cancel and ${pool.after} after, only the ${DEMO_PLAN.perRecipientMinor} that left`,
    );
  });

  await check("forgery", async () => {
    if (delivered === null) throw new ProofFailed("skipped, no stored delivery to alter");
    const headers = { "content-type": "application/json" };
    for (const [key, name] of Object.entries(DELIVERY_HEADER_NAMES)) {
      if (typeof delivered.headers?.[key] !== "string") throw new ProofFailed("mend-web's log line lacks the delivery headers");
      headers[name] = delivered.headers[key];
    }
    const altered = alterOneCharacter(delivered.event.raw);
    // mend-web answers a transmission id it already stored with 200 and no write, before asking
    // PayPal; a fresh id makes the forgery go through Mend's own signature check instead.
    const storedId = delivered.event.transmission_id;
    const freshId = storedId.slice(0, -1) + (storedId.endsWith("0") ? "1" : "0");
    const post = async (transmissionId) => {
      const sentAt = new Date();
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { ...headers, "paypal-transmission-id": transmissionId },
        body: altered,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const ref = /\(ref ([0-9a-f-]{36})\)$/.exec(await response.text())?.[1] ?? "";
      const record = ref === "" ? null : await waitForLogRecord(workspace.id, services.web.id, new Date(sentAt.getTime() - 30_000), "mend-web's log line for the forgery", (entry) => entry.ref === ref);
      return { status: response.status, reason: record?.reason ?? record?.outcome ?? "nothing" };
    };
    const verified = await post(freshId);
    const underStoredId = await post(storedId);
    const forgedRows = rows("select count(*)::int as n from paypal_events where raw = %s or transmission_id = %s", [altered, freshId])[0].n;
    const original = rows("select raw from paypal_events where transmission_id = %s", [storedId])[0]?.raw;
    line(
      verified.status === 400 && verified.reason === "verify_failure" && underStoredId.status === 200 && forgedRows === 0 && original === delivered.event.raw,
      `forgery: an altered copy of that delivery under a new transmission id is refused by Mend's signature check against PayPal's certificate (answer ${verified.status}, ${verified.reason}); under the stored id it gets ${underStoredId.status} (${underStoredId.reason}) with no PayPal call; neither stored anything and the original is unchanged`,
    );
  });

  await check("simulate", async () => {
    if (journey === null) throw new ProofFailed("skipped, no campaign was sent");
    const bought = await journey.browser.settle(await journey.browser.send("POST", `/api/campaigns/${journey.campaignId}/simulate`, { ref: journey.ref }));
    const orderId = String(bought.body.paypalOrderId ?? "");
    if (bought.status !== 201 || bought.body.paypalStatus !== "COMPLETED") throw new ProofFailed(`simulate answered ${bought.status} ${bought.text.slice(0, 200)}`);
    const attributed = await waitFor("the simulated purchase's attribution", ATTRIBUTION_WAIT_MS, 5_000, async () => {
      const found = rows("select role, simulated from attributions where campaign_id::text = %s and ref = %s", [journey.campaignId, journey.ref])[0];
      return found ?? null;
    });
    const results = await journey.browser.settle(await journey.browser.send("GET", `/api/campaigns/${journey.campaignId}/results`));
    line(
      attributed.role === "reward" &&
        attributed.simulated === true &&
        results.status === 200 &&
        Number(results.body.rewarded?.simulatedReturns ?? 0) >= 1 &&
        Number(results.body.spendMinor ?? 0) >= Number(delivered?.item?.amount_minor ?? 1),
      `simulate: a return purchase by the test receiver (PayPal order ${orderId}, COMPLETED) is attributed to the rewarded arm as simulated; results show it, with ${String(results.body.spendMinor)} cents spent (verdict: ${String(results.body.verdict)})`,
    );
  });

  await check("agent", async () => {
    const summary = await waitFor("the shop summary", 60_000, 5_000, async () => {
      const response = await fetch(new URL("/api/shop/summary", origin), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const text = await response.text();
      answers.push(text);
      return response.status === 200 ? JSON.parse(text) : null;
    });
    // A second visitor, so the question is asked under its own session's Claude limits.
    const visitor = await demoSession(origin);
    const answer = await visitor.send("POST", "/api/agent", { message: AGENT_QUESTION });
    const count = Number(summary.quietRegulars);
    const tools = answer.body.toolsUsed ?? [];
    line(
      answer.status === 200 && typeof answer.body.reply === "string" && tools.some((tool) => tool === "shop_summary" || tool === "quiet_regulars") && Number.isInteger(count) && digitsIn(answer.body.reply, count),
      `agent: asked "${AGENT_QUESTION}", it used ${tools.join(", ") || "no tool"} and answered with the live count, ${count} (${String(answer.body.aiCalls)} Claude calls)`,
    );
  });

  await check("jobs", async () => {
    const cron = await renderOk("GET", `/services/${services.jobs.id}`);
    const lastRun = cron.serviceDetails?.lastSuccessfulRunAt ?? null;
    const records = appRecords(await serviceLogs(workspace.id, services.jobs.id, new Date(Date.now() - 60 * 60 * 1000)));
    const purges = records.filter((entry) => entry.job === "purge" && entry.ok === true);
    const audited = rows("select count(*)::int as n from audit_log where actor = 'purge' and action = 'paypal_events_purged' and at > now() - interval '15 minutes'")[0].n;
    line(
      lastRun !== null && purges.length >= 1 && audited >= 1,
      `jobs: mend-jobs last ran successfully at ${lastRun}; ${purges.length} purge runs in its last hour of logs, and the purge is on record in audit_log within 15 minutes`,
    );
  });

  await check("idempotent", async () => {
    const before = readFileSync(statePath, "utf8");
    say("idempotent: comparing every resource with what `up` would set, in plan-only mode");
    options.planOnly = true;
    let changes;
    try {
      changes = await up();
    } finally {
      options.planOnly = false;
    }
    const unchanged = readFileSync(statePath, "utf8") === before;
    line(
      changes.length === 0 && unchanged,
      `idempotent: \`up\` would change nothing (no new resource, setting, env var, deploy or webhook, and render-state.json as it is)${changes.length ? ` (would: ${changes.join("; ")})` : ""}${unchanged ? "" : " (render-state.json changed)"}`,
    );
  });

  await check("secrets", async () => {
    const since = new Date(Math.min(startedAt.getTime(), Date.now() - 60 * 60 * 1000));
    let entries = [];
    for (const service of Object.values(services)) entries = entries.concat(await serviceLogs(workspace.id, service.id, since));
    const haystacks = [transcript.join("\n"), readFileSync(statePath, "utf8"), ...answers, ...entries.map((entry) => String(entry.message ?? ""))];
    const found = haystacks.some((text) => carriesSecret(text) || SECRET_SHAPES.some((shape) => shape.test(text)));
    // If PayPal's token shape ever changes, the shape search above would quietly stop working.
    const shapeChecked = typeof paypalToken === "string" && SECRET_SHAPES[0].test(paypalToken);
    line(
      !found && !leakedLine && shapeChecked,
      `secrets: no secret value or key shape appears in the script output, render-state.json, ${answers.length} answers from mend-web, or ${entries.length} log lines of mend-web, mend-engine and mend-jobs${shapeChecked ? "" : "; PayPal token shape not recognised"}`,
    );
  });
}

const COMMANDS = { status, up, prove };

// planOnly is never an option: only prove's idempotent check sets it, for one `up` call.
const options = { create: false, migrate: false, planOnly: false };
const UP_OPTIONS = { "--create": "create", "--migrate": "migrate" };

/** Reads the options after the command. Unknown options, or any option on anything but up, stop the run before anything is called. */
function readOptions(command, args) {
  for (const arg of args) {
    if (command === "up" && Object.hasOwn(UP_OPTIONS, arg)) {
      options[UP_OPTIONS[arg]] = true;
    } else {
      throw new DeployError(`unknown option for ${command}: ${arg}`);
    }
  }
}

async function main() {
  const command = process.argv[2];
  if (!Object.hasOwn(COMMANDS, command)) {
    console.log("usage: node scripts/deploy/render.mjs status | up [--create] [--migrate] | prove");
    process.exitCode = 2;
    return;
  }
  readOptions(command, process.argv.slice(3));
  settings = loadSettings();
  // Ctrl-C skips every finally, so this machine's allow-list entry is removed here as well.
  process.once("SIGINT", () => {
    const open = machineAccess.dbId === null ? Promise.resolve() : closeMachineAccess(machineAccess.dbId);
    open.finally(() => process.exit(130));
  });
  await COMMANDS[command]();
  if (leakedLine || cleanupFailed) process.exitCode = 1;
}

/** For scripts/deploy/render.test.mjs, which runs these with fetch replaced. */
export const testing = {
  DeployError,
  SERVICES,
  setSettings(env) {
    settings = loadSettings(env);
  },
  setStatePath(file) {
    statePath = file;
  },
  setOptions(values) {
    Object.assign(options, values);
  },
  setCompareOnly(on) {
    compareOnly = on;
  },
  resolveResources,
  up,
  renderCall,
  paypalCall,
  withMachineAccess,
  act,
  checkDeploySettings,
  desiredEnv,
  carriesSecret,
  readKeysCheck,
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const thisPath = fileURLToPath(import.meta.url);
const invokedDirectly = process.platform === "win32" ? invokedPath.toLowerCase() === thisPath.toLowerCase() : invokedPath === thisPath;

if (invokedDirectly) {
  main().catch((error) => {
    // say() still guards this line, so an error message cannot carry a secret out.
    say(`FAIL  ${error instanceof DeployError ? error.message : `unexpected error: ${error?.name ?? "unknown"}: ${error?.message ?? ""}`}`);
    if (process.argv[2] === "prove") say("D2 RESULT: FAIL");
    process.exitCode = 1;
  });
}
