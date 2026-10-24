/**
 * Mend's one repeatable deploy on Render: the web app (mend-web), its database (mend-db),
 * and the PayPal sandbox webhook that points at the web app.
 *
 *   node scripts/deploy/render.mjs status   read-only: what exists and how it is set
 *
 * Secrets are read from the repo's .env and go only to the Render API and PayPal's sandbox
 * API. No secret value is printed or written to disk: every output line passes through
 * say(), which withholds any line that carries one and fails the run.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const ENV_PATH = path.join(REPO_ROOT, ".env");
const STATE_PATH = path.join(HERE, "render-state.json");
const SCHEMA_PATH = path.join(REPO_ROOT, "packages", "engine", "mend_engine", "db", "schema.sql");
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
const CAP_KEYS = ["MEND_PAYOUT_ITEM_CAP_MINOR", "MEND_CAMPAIGN_CAP_MINOR", "MEND_DAILY_CAP_MINOR"];
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
  const badCaps = CAP_KEYS.filter((key) => !/^[1-9]\d{0,8}$/.test(env[key] ?? ""));
  if (badCaps.length > 0) throw new DeployError(`missing or invalid in .env: ${badCaps.join(", ")}`);
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
    const rows = await renderOk("GET", `${apiPath}${join}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
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

async function connectionInfo(dbId) {
  const info = await renderOk("GET", `/postgres/${dbId}/connection-info`);
  for (const value of Object.values(info ?? {})) addSecret(value);
  const isUrl = (text) => typeof text === "string" && /^postgres(ql)?:\/\/[^\s]+$/.test(text);
  if (!isUrl(info?.internalConnectionString) || !isUrl(info?.externalConnectionString)) {
    throw new DeployError("Render returned no usable connection strings for mend-db");
  }
  return { internal: info.internalConnectionString, external: info.externalConnectionString };
}

function applySchema(externalUrl, changes) {
  if (!existsSync(SCHEMA_PATH)) throw new DeployError("packages/engine/mend_engine/db/schema.sql is missing");
  const out = databaseCall(externalUrl, { op: "schema", path: SCHEMA_PATH });
  if (out.created.length > 0) {
    changes.push(`created tables ${out.created.join(", ")}`);
    say(`action: applied schema.sql to mend-db over TLS, created ${out.created.length} tables: ${out.created.join(", ")}`);
  } else {
    say(`schema: applied schema.sql to mend-db over TLS, all ${out.tables.length} tables already existed`);
  }
}

/** Every env var mend-web should carry, by name. Values come from .env and Render, never from this file. */
function desiredEnv(connection, webhookId) {
  const env = {
    NODE_VERSION: SERVICE.nodeVersion,
    PAYPAL_ENV: "sandbox",
    PAYPAL_CLIENT_ID: settings.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: settings.PAYPAL_CLIENT_SECRET,
    DATABASE_URL: connection.internal,
  };
  for (const key of CAP_KEYS) env[key] = settings[key];
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
    if (deploy.status !== shown) {
      say(`deploy: ${deployId} is ${deploy.status}`);
      shown = deploy.status;
    }
    if (deploy.status === "live") return deploy;
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

  const db = await ensureDatabase(workspace.id, changes);
  const connection = await connectionInfo(db.id);
  applySchema(connection.external, changes);

  const { service, deployId } = await ensureService(workspace.id, desiredEnv(connection, null), changes);
  const origin = serviceOrigin(service);
  await syncEnv(service.id, desiredEnv(connection, null), changes);
  await ensureLive(service.id, deployId, changes);
  await waitForHealth(origin);
  say(`health: ${new URL(SERVICE.healthCheckPath, origin).href} says ok`);

  if (writeState(stateFor(workspace, db, service, origin, null))) say("state: wrote scripts/deploy/render-state.json");
  say(`D1 UP (no webhook yet): ${origin.origin} live, database ${db.name} ${db.status}`);
  return changes;
}

const COMMANDS = { status, up };

async function main() {
  const command = process.argv[2];
  if (!Object.hasOwn(COMMANDS, command)) {
    console.log(`usage: node scripts/deploy/render.mjs <${Object.keys(COMMANDS).join("|")}>`);
    process.exitCode = 2;
    return;
  }
  settings = loadSettings();
  await COMMANDS[command]();
  if (leakedLine) process.exitCode = 1;
}

main().catch((error) => {
  // say() still guards this line, so an error message cannot carry a secret out.
  say(`FAIL  ${error instanceof DeployError ? error.message : `unexpected error: ${error?.name ?? "unknown"}: ${error?.message ?? ""}`}`);
  process.exitCode = 1;
});
