/**
 * Mend's one repeatable deploy on Render: the web app (mend-web), its database (mend-db),
 * and the PayPal sandbox webhook that points at the web app.
 *
 *   node scripts/deploy/render.mjs status                  read-only: what exists and how it is set
 *   node scripts/deploy/render.mjs up [--schema <file>]    find or create everything; safe to rerun
 *   node scripts/deploy/render.mjs prove [--schema <file>] the live proof; sends one 1.00 USD sandbox payout
 *
 * --schema names the SQL file applied to mend-db (default: the engine's working schema.sql),
 * so a deploy can apply a frozen copy while that file is being edited. prove reruns `up`,
 * so give it the same --schema.
 *
 * Secrets are read from the repo's .env and go only to the Render API and PayPal's sandbox
 * API. No secret value is printed or written to disk: every output line passes through
 * say(), which withholds any line that carries one and fails the run.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const ENV_PATH = path.join(REPO_ROOT, ".env");
const STATE_PATH = path.join(HERE, "render-state.json");
const DEFAULT_SCHEMA_PATH = path.join(REPO_ROOT, "packages", "engine", "mend_engine", "db", "schema.sql");
const ENGINE_PYTHON = path.join(
  REPO_ROOT,
  "packages",
  "engine",
  ".venv",
  ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]),
);

const RENDER_API = "https://api.render.com/v1";
// C16: the only PayPal host this script can reach. A constant, never read from .env.
const PAYPAL_API = "https://api-m.sandbox.paypal.com";
const WORKSPACE_NAME = "My Workspace";
const REPO_URL = "https://github.com/ramakrishnanhulk20/Mend";

// Render renamed its plans without changing prices (render.com/docs/compute-plans), and the
// API may report either name. The first name in each list is the one this script asks for.
const DATABASE = {
  name: "mend-db",
  databaseName: "mend",
  plans: ["basic_256mb", "0.1c-256mb"],
  // The newest major version in the API's postgresVersion enum and the docs on 2026-10-20.
  version: "18",
  // 1 GB is the smallest storage Render allows; larger sizes come in steps of 5 GB.
  diskSizeGB: 1,
  region: "virginia",
};
const SERVICE = {
  name: "mend-web",
  branch: "main",
  rootDir: "packages/web",
  buildCommand: "npm ci && npm run build",
  startCommand: "npm start",
  healthCheckPath: "/api/health",
  plans: ["starter", "0.5c-512mb"],
  region: "virginia",
  // Render's default Node is 24 (render.com/docs/node-version) and packages/web declares no
  // engines field, so the version the web app is built and tested with here is pinned.
  nodeVersion: "26.7.0",
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

const REQUEST_TIMEOUT_MS = 30_000;

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
  return parseEnv(readFileSync(ENV_PATH, "utf8").replace(/^﻿/, ""));
}

const NO_WHITESPACE = /^\S+$/;

/**
 * The settings this script needs, validated. Errors name the key, never its value.
 * PAYPAL_ENV must be exactly "sandbox" (C16), whatever command runs.
 */
function loadSettings() {
  const env = readDotEnv();
  const missing = ["RENDER_API_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"].filter(
    (key) => typeof env[key] !== "string" || !NO_WHITESPACE.test(env[key]),
  );
  if (missing.length > 0) throw new DeployError(`missing or invalid in .env: ${missing.join(", ")}`);
  if (env.PAYPAL_ENV !== "sandbox") throw new DeployError("PAYPAL_ENV in .env must be exactly 'sandbox'");
  addSecret(env.RENDER_API_KEY);
  addSecret(env.PAYPAL_CLIENT_SECRET);
  addSecret(Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64"));
  return env;
}

let settings;

function readState() {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

/** Writes render-state.json only when its content changes, so a repeat run leaves it alone. */
function writeState(state) {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  if (carriesSecret(text)) throw new DeployError("refusing to write a secret into render-state.json");
  if (existsSync(STATE_PATH) && readFileSync(STATE_PATH, "utf8") === text) return false;
  writeFileSync(STATE_PATH, text, "utf8");
  return true;
}

async function renderCall(method, apiPath, body) {
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

async function renderOk(method, apiPath, body, expected = [200]) {
  const reply = await renderCall(method, apiPath, body);
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

async function findService(ownerId) {
  const found = (await renderList(`/services?ownerId=${ownerId}&name=${SERVICE.name}`, "service")).filter(
    (service) => service.name === SERVICE.name,
  );
  if (found.length > 1) throw new DeployError(`${found.length} services are named ${SERVICE.name}; expected at most one`);
  return found[0] ?? null;
}

async function latestDeploy(serviceId) {
  const rows = await renderOk("GET", `/services/${serviceId}/deploys?limit=1`);
  return rows[0]?.deploy ?? null;
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

function webhookUrlFor(origin) {
  return new URL(WEBHOOK_PATH, origin).href;
}

let paypalToken = null;

async function paypalCall(method, apiPath, body, extraHeaders = {}) {
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

async function status() {
  const state = readState();
  const workspace = await findWorkspace();
  say(`status: workspace "${workspace.name}" (${workspace.id})`);

  const db = await findDatabase(workspace.id);
  say(
    db === null
      ? "status: database mend-db does not exist"
      : `status: database ${db.name} ${db.id} is ${db.status}, plan ${db.plan}, region ${db.region}, Postgres ${db.version}, ${db.diskSizeGB ?? "?"} GB`,
  );

  const service = await findService(workspace.id);
  let webhookUrl = null;
  if (service === null) {
    say("status: service mend-web does not exist");
  } else {
    const details = service.serviceDetails ?? {};
    const deploy = await latestDeploy(service.id);
    say(
      `status: service ${service.name} ${service.id} at ${details.url}, plan ${details.plan}, region ${details.region}, ${service.suspended}, latest deploy ${deploy ? `${deploy.id} ${deploy.status}` : "none"}`,
    );
    webhookUrl = webhookUrlFor(serviceOrigin(service));
  }

  const webhooks = await listWebhooks();
  const ours = webhookUrl === null ? [] : webhooks.filter((hook) => sameUrl(hook.url, webhookUrl));
  const tunnels = webhooks.filter((hook) => hostOf(hook.url).endsWith(".trycloudflare.com"));
  say(
    ours.length === 0
      ? `status: no PayPal webhook points at mend-web (${webhooks.length} webhooks on the app, ${tunnels.length} on trycloudflare.com)`
      : `status: PayPal webhook ${ours[0].id} points at ${ours[0].url} with ${ours[0].event_types?.length ?? 0} event types (${webhooks.length} webhooks on the app, ${tunnels.length} on trycloudflare.com)`,
  );

  const live = {
    database: db?.id ?? null,
    service: service?.id ?? null,
    webhook: ours[0]?.id ?? null,
  };
  const recorded = { database: state.database?.id ?? null, service: state.service?.id ?? null, webhook: state.webhook?.id ?? null };
  const differs = Object.keys(live).filter((key) => live[key] !== recorded[key]);
  say(
    !existsSync(STATE_PATH)
      ? "status: no render-state.json yet"
      : differs.length === 0
        ? "status: render-state.json matches what exists"
        : `status: render-state.json differs from what exists for ${differs.join(", ")}`,
  );
  if (state.redeployPendingSince) say(`status: an env var change from ${state.redeployPendingSince} has not been seen live; the next \`up\` redeploys`);
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
        def tables():
            rows = conn.execute(
                "select table_name from information_schema.tables where table_schema = 'public' order by 1"
            ).fetchall()
            return [row["table_name"] for row in rows]

        if request["op"] == "schema":
            before = tables()
            with open(request["path"], encoding="utf-8") as handle:
                text = handle.read()
            with conn.transaction():
                conn.execute(text)
            after = tables()
            out = {"created": [name for name in after if name not in before], "tables": after}
        else:
            out = {"rows": conn.execute(request["sql"], request.get("params", [])).fetchall()}
except psycopg.Error as error:
    out = {"error": type(error).__name__, "sqlstate": error.sqlstate, "detail": str(error).strip()[:300]}
print(json.dumps(out, default=str))
`;

function databaseCall(externalUrl, request) {
  const result = spawnSync(ENGINE_PYTHON, ["-I", "-c", DATABASE_SCRIPT], {
    input: JSON.stringify(request),
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
    throw new DeployError(`database ${request.op} gave no answer (exit ${result.status}): ${reason}`);
  }
  if (out.error) throw new DeployError(`database ${request.op} failed: ${out.error} ${out.sqlstate ?? ""} ${out.detail}`);
  return out;
}

function databaseRows(externalUrl, sql, params = []) {
  return databaseCall(externalUrl, { op: "query", sql, params }).rows;
}

function settingsProblem(name, wrong) {
  return new DeployError(`${name} exists but differs from the decided settings (${wrong.join("; ")}). Nothing was changed; fix it by hand or ask the head chef`);
}

function checkDatabaseSettings(db) {
  const wrong = [];
  if (!DATABASE.plans.includes(db.plan)) wrong.push(`plan ${db.plan}`);
  if (db.region !== DATABASE.region) wrong.push(`region ${db.region}`);
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

async function ensureDatabase(ownerId, changes) {
  let db = await findDatabase(ownerId);
  if (db === null) {
    say(
      `action: create Render Postgres ${DATABASE.name}: plan ${DATABASE.plans[0]}, ${DATABASE.diskSizeGB} GB, Postgres ${DATABASE.version}, region ${DATABASE.region} (about USD 6 a month)`,
    );
    db = await renderOk(
      "POST",
      "/postgres",
      {
        name: DATABASE.name,
        ownerId,
        databaseName: DATABASE.databaseName,
        plan: DATABASE.plans[0],
        version: DATABASE.version,
        region: DATABASE.region,
        diskSizeGB: DATABASE.diskSizeGB,
        enableHighAvailability: false,
        enableDiskAutoscaling: false,
      },
      [201],
    );
    changes.push(`created database ${db.id}`);
    say(`action: Render created ${db.name} ${db.id}`);
  } else {
    say(`database: found ${db.name} ${db.id}`);
  }
  const ready = await waitForDatabase(db.id);
  checkDatabaseSettings(ready);
  return ready;
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

/**
 * Render creates an API-made database with an empty allow list, which turns external access
 * off. The schema apply and the proof run from this machine, so exactly its address (/32)
 * is allowed, under one label that is replaced when the address changes. Entries with any
 * other label are left as they are.
 */
async function ensureExternalAccess(db, changes) {
  const block = `${await publicIpv4()}/32`;
  const current = db.ipAllowList ?? [];
  if (current.some((entry) => entry.cidrBlock === block)) {
    say(`database: external access already allows this machine only (${current.length} allow-list entries)`);
    return db;
  }
  const next = [...current.filter((entry) => entry.description !== ALLOW_LIST_LABEL), { cidrBlock: block, description: ALLOW_LIST_LABEL }];
  say(`action: allow this machine's public IPv4 address (/32 only) to reach mend-db from outside Render (${next.length} allow-list entries)`);
  const updated = await renderOk("PATCH", `/postgres/${db.id}`, { ipAllowList: next });
  changes.push("updated the mend-db allow list");
  return updated;
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

async function connectionInfo(dbId) {
  const info = await renderOk("GET", `/postgres/${dbId}/connection-info`);
  for (const value of Object.values(info ?? {})) addSecret(value);
  const isUrl = (text) => typeof text === "string" && /^postgres(ql)?:\/\/[^\s]+$/.test(text);
  if (!isUrl(info?.internalConnectionString) || !isUrl(info?.externalConnectionString)) {
    throw new DeployError("Render returned no usable connection strings for mend-db");
  }
  return { internal: info.internalConnectionString, external: info.externalConnectionString };
}

function applySchema(externalUrl, schemaPath, changes) {
  if (!existsSync(schemaPath)) throw new DeployError(`schema file not found: ${schemaPath}`);
  const text = readFileSync(schemaPath, "utf8");
  // The hash says exactly which version of the schema went in, whatever the file is called.
  const fingerprint = createHash("sha256").update(text).digest("hex").slice(0, 12);
  const label = `${path.basename(schemaPath)} (sha256 ${fingerprint})`;
  const out = databaseCall(externalUrl, { op: "schema", path: schemaPath });
  if (out.created.length > 0) {
    changes.push(`created tables ${out.created.join(", ")}`);
    say(`action: applied ${label} to mend-db over TLS, created ${out.created.length} tables: ${out.created.join(", ")}`);
  } else {
    say(`schema: applied ${label} to mend-db over TLS, all ${out.tables.length} tables already existed`);
  }
}

// The keys packages/web/src/server/config.ts reads at commit 9bcbd13, and no others.
// NODE_VERSION rides alongside them: it is a Render build setting, not an app key.
const APP_ENV_KEYS = ["PAYPAL_ENV", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "DATABASE_URL", "PAYPAL_WEBHOOK_ID"];

/** Every env var mend-web should carry, by name. Values come from .env and Render, never from this file. */
function desiredEnv(connection, webhookId) {
  const env = {
    NODE_VERSION: SERVICE.nodeVersion,
    PAYPAL_ENV: "sandbox",
    PAYPAL_CLIENT_ID: settings.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: settings.PAYPAL_CLIENT_SECRET,
    DATABASE_URL: connection.internal,
  };
  if (webhookId !== null) env.PAYPAL_WEBHOOK_ID = webhookId;
  return env;
}

const FORBIDDEN_ENV = ["MEND_DEV", "MEND_TEST_RECEIVER", "RENDER_API_KEY"];

function normalRepo(text) {
  return String(text ?? "").toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
}

function checkServiceSettings(service) {
  const details = service.serviceDetails ?? {};
  const native = details.envSpecificDetails ?? {};
  const wrong = [];
  if (service.type !== "web_service") wrong.push(`type ${service.type}`);
  if (normalRepo(service.repo) !== normalRepo(REPO_URL)) wrong.push(`repo ${service.repo}`);
  if (service.branch !== SERVICE.branch) wrong.push(`branch ${service.branch}`);
  if (service.rootDir !== SERVICE.rootDir) wrong.push(`root directory ${service.rootDir}`);
  if (details.runtime !== "node") wrong.push(`runtime ${details.runtime}`);
  if (native.buildCommand !== SERVICE.buildCommand) wrong.push("build command");
  if (native.startCommand !== SERVICE.startCommand) wrong.push("start command");
  if (details.healthCheckPath !== SERVICE.healthCheckPath) wrong.push(`health check path ${details.healthCheckPath}`);
  if (!SERVICE.plans.includes(details.plan)) wrong.push(`plan ${details.plan}`);
  if (details.region !== SERVICE.region) wrong.push(`region ${details.region}`);
  if (details.numInstances !== 1) wrong.push(`${details.numInstances} instances`);
  if (details.autoscaling?.enabled === true) wrong.push("autoscaling is on");
  if (details.disk) wrong.push("it has a disk");
  if ((service.autoDeployTrigger ?? (service.autoDeploy === "yes" ? "commit" : "off")) !== "commit") wrong.push("auto-deploy on push is off");
  if (service.suspended !== "not_suspended") wrong.push("it is suspended");
  if (wrong.length > 0) throw settingsProblem(SERVICE.name, wrong);
}

async function ensureService(ownerId, env, changes) {
  const found = await findService(ownerId);
  if (found !== null) {
    say(`service: found ${found.name} ${found.id}`);
    checkServiceSettings(found);
    return { service: found, deployId: null };
  }
  say(
    `action: create Render web service ${SERVICE.name}: plan ${SERVICE.plans[0]}, region ${SERVICE.region}, ${REPO_URL} branch ${SERVICE.branch}, root ${SERVICE.rootDir}, Node ${SERVICE.nodeVersion} (about USD 7 a month); env vars by name: ${Object.keys(env).join(", ")}`,
  );
  const created = await renderOk(
    "POST",
    "/services",
    {
      type: "web_service",
      name: SERVICE.name,
      ownerId,
      repo: REPO_URL,
      branch: SERVICE.branch,
      rootDir: SERVICE.rootDir,
      autoDeployTrigger: "commit",
      envVars: Object.entries(env).map(([key, value]) => ({ key, value })),
      serviceDetails: {
        runtime: "node",
        envSpecificDetails: { buildCommand: SERVICE.buildCommand, startCommand: SERVICE.startCommand },
        healthCheckPath: SERVICE.healthCheckPath,
        plan: SERVICE.plans[0],
        region: SERVICE.region,
        numInstances: 1,
        pullRequestPreviewsEnabled: "no",
        previews: { generation: "off" },
      },
    },
    [201],
  );
  changes.push(`created service ${created.service.id}`);
  say(`action: Render created ${created.service.name} ${created.service.id}, first deploy ${created.deployId}`);
  checkServiceSettings(created.service);
  return { service: created.service, deployId: created.deployId ?? null };
}

async function serviceEnv(serviceId) {
  const rows = await renderList(`/services/${serviceId}/env-vars`, "envVar");
  const env = {};
  for (const row of rows) {
    env[row.key] = row.value;
    addSecret(row.value?.startsWith?.("postgres") ? row.value : undefined);
  }
  return env;
}

/** Makes mend-web's env vars match `desired` and drops the keys it must never carry. Returns true if anything changed. */
async function syncEnv(serviceId, desired, changes) {
  const current = await serviceEnv(serviceId);
  let changed = false;
  for (const [key, value] of Object.entries(desired)) {
    if (current[key] === value) continue;
    say(`action: set env var ${key} on mend-web (${key in current ? "changed" : "new"})`);
    await renderOk("PUT", `/services/${serviceId}/env-vars/${key}`, { value });
    changes.push(`set env var ${key}`);
    changed = true;
  }
  for (const key of FORBIDDEN_ENV) {
    if (!(key in current)) continue;
    say(`action: remove env var ${key} from mend-web (it must never be on the live service)`);
    await renderOk("DELETE", `/services/${serviceId}/env-vars/${key}`, undefined, [200, 204]);
    changes.push(`removed env var ${key}`);
    changed = true;
  }
  if (!changed) say(`env: mend-web already has every env var it needs (${Object.keys(desired).length} keys)`);
  return changed;
}

async function waitForDeploy(serviceId, deployId) {
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

async function triggerDeploy(serviceId, reason, changes) {
  say(`action: start a new deploy of mend-web (${reason})`);
  const deploy = await renderOk("POST", `/services/${serviceId}/deploys`, { clearCache: "do_not_clear" }, [201, 202]);
  changes.push(`deployed ${deploy.id}`);
  return waitForDeploy(serviceId, deploy.id);
}

/** Waits out a deploy already running, then makes sure one deploy is live, starting one only if none is. */
async function ensureLive(serviceId, firstDeployId, changes) {
  if (firstDeployId !== null) return waitForDeploy(serviceId, firstDeployId);
  const newest = await latestDeploy(serviceId);
  if (newest !== null && DEPLOY_IN_PROGRESS.has(newest.status)) {
    say(`deploy: ${newest.id} is already running, waiting for it`);
    await waitForDeploy(serviceId, newest.id).catch(() => null);
  }
  const live = (await renderOk("GET", `/services/${serviceId}/deploys?status=live&limit=1`))[0]?.deploy ?? null;
  if (live !== null) {
    say(`deploy: ${live.id} is live`);
    return live;
  }
  return triggerDeploy(serviceId, "no deploy is live", changes);
}

async function waitForHealth(origin) {
  const url = new URL(SERVICE.healthCheckPath, origin);
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
  say(`action: delete PayPal webhook ${id} (${why})`);
  const reply = await paypalCall("DELETE", webhookPath(id));
  if (reply.status !== 204) throw new DeployError(`PayPal webhook delete answered ${paypalProblem(reply)}`);
  changes.push(`deleted webhook ${id}`);
}

function eventNames(hook) {
  return (hook?.event_types ?? []).map((type) => type.name).sort().join(",");
}

/**
 * The PayPal sandbox webhook for mend-web, at the URL built from Render's reported origin
 * (C24). Reused when one already points there, otherwise registered. Leftovers from earlier
 * tunnel proofs (trycloudflare.com) are deleted. A webhook on any other host is never
 * touched unless it is a second copy of ours. The event list is set to exactly EVENT_TYPES.
 */
async function ensureWebhook(origin, knownId, changes) {
  const url = webhookUrlFor(origin);
  const hooks = await listWebhooks();
  for (const hook of hooks.filter((entry) => hostOf(entry.url).endsWith(".trycloudflare.com"))) {
    await deleteWebhook(hook.id, "a leftover pointing at a trycloudflare.com tunnel", changes);
  }
  // The copy recorded in render-state.json is the one kept.
  const ours = hooks.filter((entry) => sameUrl(entry.url, url)).sort((a, b) => Number(b.id === knownId) - Number(a.id === knownId));
  let hook = ours[0] ?? null;
  for (const copy of ours.slice(1)) await deleteWebhook(copy.id, `a second copy of ${hook.id} for the same URL`, changes);

  const wanted = [...EVENT_TYPES].sort().join(",");
  const subscriptions = EVENT_TYPES.map((name) => ({ name }));
  if (hook === null) {
    say(`action: register a PayPal sandbox webhook for ${url} with ${EVENT_TYPES.length} event types`);
    const reply = await paypalCall("POST", "/v1/notifications/webhooks", { url, event_types: subscriptions });
    if (reply.status !== 201) throw new DeployError(`PayPal webhook create answered ${paypalProblem(reply)}`);
    hook = reply.body;
    webhookPath(hook?.id);
    changes.push(`registered webhook ${hook.id}`);
    say(`action: PayPal registered webhook ${hook.id}`);
  } else {
    say(`webhook: found ${hook.id} for ${url}`);
  }
  if (eventNames(hook) !== wanted) {
    say(`action: set the event types of PayPal webhook ${hook.id} to the ${EVENT_TYPES.length} Mend listens for`);
    const reply = await paypalCall("PATCH", webhookPath(hook.id), [{ op: "replace", path: "/event_types", value: subscriptions }]);
    if (reply.status !== 200) throw new DeployError(`PayPal webhook update answered ${paypalProblem(reply)}`);
    hook = reply.body;
    changes.push(`updated webhook ${hook.id} event types`);
  }
  if (eventNames(hook) !== wanted || !sameUrl(hook.url, url)) throw new DeployError(`PayPal webhook ${hook.id} does not match the URL and events asked for`);
  webhookPath(hook.id);
  return { id: hook.id, url, eventTypes: EVENT_TYPES.length };
}

function stateFor(workspace, db, service, origin, webhook, extra = {}) {
  const details = service.serviceDetails ?? {};
  return {
    workspace,
    database: {
      id: db.id,
      name: db.name,
      plan: db.plan,
      region: db.region,
      postgres: db.version,
      diskSizeGB: db.diskSizeGB,
      dashboardUrl: db.dashboardUrl,
    },
    service: {
      id: service.id,
      name: service.name,
      url: origin.origin,
      plan: details.plan,
      region: details.region,
      dashboardUrl: service.dashboardUrl,
    },
    webhook,
    ...extra,
  };
}

/** Finds or creates every piece, in order, and returns the list of things it changed (empty on a repeat run). */
async function up() {
  if (!existsSync(ENGINE_PYTHON)) throw new DeployError("the engine's virtual environment is missing (packages/engine/.venv)");
  const changes = [];
  const workspace = await findWorkspace();
  say(`workspace: "${workspace.name}" ${workspace.id}`);

  const found = await ensureDatabase(workspace.id, changes);
  const db = await ensureExternalAccess(found, changes);
  const connection = await connectionInfo(db.id);
  await waitForExternalConnection(connection.external);
  applySchema(connection.external, options.schemaPath, changes);

  const { service, deployId } = await ensureService(workspace.id, desiredEnv(connection, null), changes);
  const origin = serviceOrigin(service);
  await ensureLive(service.id, deployId, changes);
  await waitForHealth(origin);

  const previous = readState();
  const webhook = await ensureWebhook(origin, previous.webhook?.id ?? null, changes);
  const envChanged = await syncEnv(service.id, desiredEnv(connection, webhook.id), changes);
  // Set before the redeploy starts and cleared once it is live, so a run that dies in
  // between still redeploys next time instead of leaving the new env vars unused.
  const pending = previous.service?.id === service.id ? previous.redeployPendingSince ?? null : null;
  if (envChanged || pending !== null) {
    writeState(stateFor(workspace, db, service, origin, webhook, { redeployPendingSince: pending ?? new Date().toISOString() }));
    await triggerDeploy(service.id, envChanged ? "so the env var changes are live" : "an earlier run changed env vars but never saw them go live", changes);
    await waitForHealth(origin);
  }
  say(`health: ${new URL(SERVICE.healthCheckPath, origin).href} says ok`);

  if (writeState(stateFor(workspace, db, service, origin, webhook))) say("state: wrote scripts/deploy/render-state.json");
  say(`D1 UP: ${origin.origin} live, database ${db.name} ${db.status}, webhook ${webhook.id} registered`);
  return changes;
}

const PAYOUT_MINOR = 100;
const DELIVERY_WAIT_MS = 4 * 60 * 1000;
const LOG_WAIT_MS = 2 * 60 * 1000;
// The shape of a PayPal access token, so a token the web app fetched for itself is caught too.
const TOKEN_SHAPE = /A21AA[A-Za-z0-9_-]{20,}/;
const DELIVERY_HEADER_NAMES = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
};

class ProofFailed extends Error {}

let allPassed = true;

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

/** The web app's own JSON log records (packages/web/src/server/log.ts) found in Render's log entries. */
function appRecords(entries) {
  return entries.flatMap((entry) => {
    const text = String(entry.message ?? "").trim();
    if (!text.startsWith("{")) return [];
    try {
      return [JSON.parse(text)];
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

function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
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

async function otherPaidResources(ownerId, ours) {
  const paid = [];
  for (const service of await renderList(`/services?ownerId=${ownerId}`, "service")) {
    if (service.id !== ours.service && service.type !== "static_site" && service.serviceDetails?.plan !== "free") {
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

/**
 * The live proof. Prints one PASS or FAIL line per check and ends "D1 RESULT: PASS" only
 * when every check passed. Sends one 1.00 USD sandbox payout to MEND_TEST_RECEIVER.
 */
async function prove() {
  const receiver = settings.MEND_TEST_RECEIVER ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(receiver)) throw new DeployError("MEND_TEST_RECEIVER in .env is not an email address");
  const itemCap = Number(settings.MEND_PAYOUT_ITEM_CAP_MINOR);
  if (!Number.isInteger(itemCap) || itemCap < PAYOUT_MINOR) throw new DeployError("MEND_PAYOUT_ITEM_CAP_MINOR in .env is below the 1.00 USD proof payout");
  const state = readState();
  if (!state.service?.id || !state.database?.id || !state.webhook?.id) throw new DeployError("render-state.json is incomplete; run `up` first");

  const workspace = await findWorkspace();
  const service = await renderOk("GET", `/services/${state.service.id}`);
  const db = await renderOk("GET", `/postgres/${state.database.id}`);
  // C24: the address under test comes from Render's own report, not from the state file.
  const origin = serviceOrigin(service);
  const webhookUrl = webhookUrlFor(origin);
  const connection = await connectionInfo(db.id);

  await check("health", async () => {
    const url = new URL(SERVICE.healthCheckPath, origin);
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await response.text();
    line(response.status === 200 && text === "ok", `health: ${url.href} says ok${response.status === 200 ? "" : ` (got ${response.status})`}`);
  });

  await check("plan", async () => {
    const details = service.serviceDetails ?? {};
    const problems = [];
    if (!SERVICE.plans.includes(details.plan)) problems.push(`mend-web plan ${details.plan}`);
    if (details.region !== SERVICE.region) problems.push(`mend-web region ${details.region}`);
    if (!DATABASE.plans.includes(db.plan)) problems.push(`mend-db plan ${db.plan}`);
    if (db.region !== DATABASE.region) problems.push(`mend-db region ${db.region}`);
    if (db.diskSizeGB !== DATABASE.diskSizeGB) problems.push(`mend-db ${db.diskSizeGB} GB`);
    problems.push(...(await otherPaidResources(workspace.id, { service: service.id, database: db.id })).map((item) => `also paid: ${item}`));
    line(
      problems.length === 0,
      `plan: mend-web is Starter, mend-db is basic 256 MB, region virginia; no other paid service in the workspace${problems.length ? ` (${problems.join("; ")})` : ""}`,
    );
  });

  await check("env", async () => {
    const env = await serviceEnv(service.id);
    const problems = [];
    const missing = APP_ENV_KEYS.filter((key) => typeof env[key] !== "string" || env[key] === "");
    if (missing.length > 0) problems.push(`missing ${missing.join(", ")}`);
    if (env.PAYPAL_ENV !== "sandbox") problems.push("PAYPAL_ENV is not sandbox");
    if (env.PAYPAL_CLIENT_ID !== settings.PAYPAL_CLIENT_ID || env.PAYPAL_CLIENT_SECRET !== settings.PAYPAL_CLIENT_SECRET) problems.push("PayPal credentials differ from .env");
    if (env.DATABASE_URL !== connection.internal) problems.push("DATABASE_URL is not mend-db's internal connection string");
    const hooks = (await listWebhooks()).filter((hook) => sameUrl(hook.url, webhookUrl));
    if (hooks.length !== 1 || hooks[0].id !== env.PAYPAL_WEBHOOK_ID) problems.push("PAYPAL_WEBHOOK_ID is not the one PayPal webhook for the live URL");
    const forbidden = FORBIDDEN_ENV.filter((key) => key in env);
    if (forbidden.length > 0) problems.push(`carries ${forbidden.join(", ")}`);
    if (Object.values(env).includes(settings.RENDER_API_KEY)) problems.push("the Render API key is stored under another name");
    line(
      problems.length === 0,
      `env: mend-web has every required key; PAYPAL_ENV is sandbox; no MEND_DEV, MEND_TEST_RECEIVER or RENDER_API_KEY on it${problems.length ? ` (${problems.join("; ")})` : ""}`,
    );
  });

  const payout = await check("payout", async () => {
    const senderBatchId = `mend-d1-${utcStamp(new Date())}`;
    say(`action: send a 1.00 USD PayPal sandbox payout to MEND_TEST_RECEIVER, sender_batch_id ${senderBatchId}`);
    const reply = await paypalCall(
      "POST",
      "/v1/payments/payouts",
      {
        sender_batch_header: { sender_batch_id: senderBatchId, email_subject: "Mend deploy proof", recipient_type: "EMAIL" },
        items: [
          {
            recipient_type: "EMAIL",
            receiver,
            amount: { currency: "USD", value: (PAYOUT_MINOR / 100).toFixed(2) },
            note: "Mend deploy proof payout",
            sender_item_id: "d1-1",
            purpose: "CASHBACK",
          },
        ],
      },
      { "PayPal-Request-Id": senderBatchId },
    );
    const batchId = reply.body?.batch_header?.payout_batch_id;
    if (reply.status !== 201 || typeof batchId !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(batchId)) {
      throw new ProofFailed(`PayPal answered ${paypalProblem(reply)}`);
    }
    line(true, `payout: 1.00 USD to MEND_TEST_RECEIVER sent by REST from this machine, sender_batch_id ${senderBatchId}, PayPal batch ${batchId}`);
    return { batchId, sentAt: new Date() };
  });

  let delivery = null;
  if (payout === null) {
    line(false, "delivery: skipped, no payout was sent");
  } else {
    delivery = await check("delivery", async () => {
      const deadline = payout.sentAt.getTime() + DELIVERY_WAIT_MS;
      let stored = null;
      while (stored === null) {
        const rows = databaseRows(
          connection.external,
          "select transmission_id, event_id, event_type, raw from paypal_events where event_type like %s and strpos(raw, %s) > 0 order by received_at",
          ["PAYMENT.PAYOUTS-ITEM.%", payout.batchId],
        );
        stored = rows.find((row) => JSON.parse(row.raw)?.resource?.payout_batch_id === payout.batchId) ?? null;
        if (stored === null) {
          if (Date.now() > deadline) throw new ProofFailed("no PAYMENT.PAYOUTS-ITEM.* event for the payout reached mend-db within 4 minutes");
          await sleep(5_000);
        }
      }
      const seconds = Math.round((Date.now() - payout.sentAt.getTime()) / 1000);
      const copies = databaseRows(connection.external, "select count(*)::int as n from paypal_events where event_id = %s", [stored.event_id])[0].n;
      const record = await waitForLogRecord(
        workspace.id,
        service.id,
        new Date(payout.sentAt.getTime() - 60_000),
        "the receiver's log line for the stored delivery",
        (entry) => entry.kind === "webhook" && entry.outcome === "stored" && entry.transmission_id === stored.transmission_id,
      );
      line(
        copies === 1 && record.status === 200,
        `delivery: a real ${stored.event_type} event reached the Render service, was verified by PayPal and stored once in mend-db (${seconds} s after the payout, event ${stored.event_id})`,
      );
      return { stored, headers: record.delivery };
    });
  }

  await check("forgery", async () => {
    if (delivery === null) throw new ProofFailed("skipped, no stored delivery to alter");
    const headers = { "content-type": "application/json" };
    for (const [key, name] of Object.entries(DELIVERY_HEADER_NAMES)) {
      if (typeof delivery.headers?.[key] !== "string") throw new ProofFailed("the receiver's log line lacks the delivery headers");
      headers[name] = delivery.headers[key];
    }
    const altered = alterOneCharacter(delivery.stored.raw);
    const sentAt = new Date();
    const response = await fetch(webhookUrl, { method: "POST", headers, body: altered, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const ref = /\(ref ([0-9a-f-]{36})\)$/.exec(await response.text())?.[1] ?? "";
    const record = ref === ""
      ? null
      : await waitForLogRecord(workspace.id, service.id, new Date(sentAt.getTime() - 30_000), "the receiver's log line for the forgery", (entry) => entry.ref === ref);
    const forgedRows = databaseRows(connection.external, "select count(*)::int as n from paypal_events where raw = %s", [altered])[0].n;
    const original = databaseRows(connection.external, "select raw from paypal_events where transmission_id = %s", [delivery.stored.transmission_id])[0]?.raw;
    line(
      response.status === 400 && record?.reason === "verify_failure" && forgedRows === 0 && original === delivery.stored.raw,
      `forgery: an altered copy of that delivery sent to the live URL is refused with 400 and stores nothing (answer ${response.status}, receiver logged ${record?.reason ?? "nothing"})`,
    );
  });

  await check("idempotent", async () => {
    const before = readFileSync(STATE_PATH, "utf8");
    say("idempotent: running `up` again");
    const changes = await up();
    const unchanged = readFileSync(STATE_PATH, "utf8") === before;
    line(
      changes.length === 0 && unchanged,
      `idempotent: running \`up\` again changed nothing (no new service, database or webhook)${changes.length ? ` (changed: ${changes.join("; ")})` : ""}${unchanged ? "" : " (render-state.json changed)"}`,
    );
  });

  await check("secrets", async () => {
    const entries = await serviceLogs(workspace.id, service.id, new Date(Date.now() - 60 * 60 * 1000));
    const haystacks = [transcript.join("\n"), readFileSync(STATE_PATH, "utf8"), ...entries.map((entry) => String(entry.message ?? ""))];
    const found = haystacks.some((text) => carriesSecret(text) || TOKEN_SHAPE.test(text));
    // If PayPal's token shape ever changes, the shape search above would quietly stop working.
    const shapeChecked = typeof paypalToken === "string" && TOKEN_SHAPE.test(paypalToken);
    line(
      !found && !leakedLine && shapeChecked,
      `secrets: no secret value appears in the script output, render-state.json or the Render service's recent logs (${entries.length} log lines from the last hour read${shapeChecked ? "" : "; PayPal token shape not recognised"})`,
    );
  });

  say(`D1 RESULT: ${allPassed && !leakedLine ? "PASS" : "FAIL"}`);
  if (!(allPassed && !leakedLine)) process.exitCode = 1;
}

const COMMANDS = { status, up, prove };

const options = { schemaPath: DEFAULT_SCHEMA_PATH };

/** Reads the options after the command. Unknown or incomplete options stop the run before anything is called. */
function readOptions(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--schema" && typeof args[i + 1] === "string" && args[i + 1] !== "") {
      options.schemaPath = path.resolve(args[i + 1]);
      i += 1;
    } else {
      throw new DeployError(`unknown or incomplete option: ${args[i]}`);
    }
  }
}

async function main() {
  const command = process.argv[2];
  if (!Object.hasOwn(COMMANDS, command)) {
    console.log(`usage: node scripts/deploy/render.mjs <${Object.keys(COMMANDS).join("|")}> [--schema <file>]`);
    process.exitCode = 2;
    return;
  }
  readOptions(process.argv.slice(3));
  settings = loadSettings();
  await COMMANDS[command]();
  if (leakedLine) process.exitCode = 1;
}

main().catch((error) => {
  // say() still guards this line, so an error message cannot carry a secret out.
  say(`FAIL  ${error instanceof DeployError ? error.message : `unexpected error: ${error?.name ?? "unknown"}: ${error?.message ?? ""}`}`);
  if (process.argv[2] === "prove") say("D1 RESULT: FAIL");
  process.exitCode = 1;
});
