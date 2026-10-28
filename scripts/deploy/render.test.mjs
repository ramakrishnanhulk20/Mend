// Tests render.mjs's own decisions with fetch replaced, so nothing reaches Render or PayPal:
// resources are found by their recorded id or the run stops, nothing is created without
// --create, prove's compare-only guard, this machine's allow-list entry being removed, and
// the read-only PayPal app: copied to mend-web only, required for up, swept as a secret, and
// prove's "read keys" check. Does NOT cover Render's real answers, PayPal's real scopes, the
// migrate and seed commands, or the live proof (node scripts/deploy/render.mjs prove does).
//   node --test scripts/deploy/render.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { testing } from "./render.mjs";

const SETTINGS = {
  RENDER_API_KEY: "rnd.test.key.not.real.0000",
  PAYPAL_CLIENT_ID: "test-client-id",
  PAYPAL_CLIENT_SECRET: "test.client.secret.not.real",
  PAYPAL_READ_CLIENT_ID: "test-read-client-id",
  PAYPAL_READ_CLIENT_SECRET: "test.read.client.secret.not.real",
  PAYPAL_ENV: "sandbox",
  MEND_PAYOUT_ITEM_CAP_MINOR: "1000",
  MEND_CAMPAIGN_CAP_MINOR: "10000",
  MEND_DAILY_CAP_MINOR: "20000",
  MEND_OWNER_PASSWORD: "owner-password-for-tests-0000",
  ANTHROPIC_API_KEY: "anthropic.key.for.tests.not.real.0000",
  MEND_TEST_RECEIVER: "receiver@personal.example",
};
const WORKSPACE = { id: "tea-test", name: "My Workspace", type: "team" };
const DB = {
  id: "dpg-test-a",
  name: "mend-db",
  plan: "basic_256mb",
  region: "virginia",
  databaseName: "mend",
  diskSizeGB: 1,
  highAvailabilityEnabled: false,
  diskAutoscalingEnabled: false,
  readReplicas: [],
  suspended: "not_suspended",
  status: "available",
  owner: { id: WORKSPACE.id },
  ipAllowList: [{ cidrBlock: "198.51.100.7/32", description: "someone else's entry" }],
};
const WEB_ORIGIN = "https://mend-web.onrender.com";
const STATE = {
  workspace: { id: WORKSPACE.id, name: WORKSPACE.name },
  database: { id: DB.id },
  services: { web: { id: "srv-web" }, engine: { id: "srv-engine" }, jobs: { id: "crn-jobs" } },
  webhook: { id: "WH0000000000000001" },
};

function service(id, spec, overrides = {}) {
  return {
    id,
    name: spec.name,
    type: spec.type,
    ownerId: WORKSPACE.id,
    repo: "https://github.com/ramakrishnanhulk20/Mend",
    branch: "main",
    rootDir: spec.rootDir,
    autoDeployTrigger: "commit",
    suspended: "not_suspended",
    serviceDetails: {
      runtime: spec.runtime,
      envSpecificDetails: { buildCommand: spec.buildCommand, startCommand: spec.startCommand },
      plan: "starter",
      region: "virginia",
      numInstances: 1,
      healthCheckPath: spec.healthCheckPath,
      schedule: spec.schedule,
    },
    ...overrides,
  };
}

let calls;
let routes;

function json(status, body) {
  return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function fakeFetch(input, init = {}) {
  const url = new URL(String(input));
  const method = init.method ?? "GET";
  calls.push({ method, url: `${url.origin}${url.pathname}`, body: init.body ?? null });
  const route = routes[`${method} ${url.pathname.replace(/^\/v1/, "")}`];
  if (route !== undefined) return typeof route === "function" ? route(init) : route();
  if (url.hostname === "1.1.1.1") return new Response("ip=203.0.113.5\n", { status: 200 });
  return json(404, { message: "not found" });
}

// The PayPal token request is a POST but changes nothing at PayPal.
function writes() {
  return calls.filter((call) => call.method !== "GET" && !call.url.endsWith("/v1/oauth2/token"));
}

function baseRoutes() {
  const specs = testing.SERVICES;
  return {
    [`GET /owners/${WORKSPACE.id}`]: () => json(200, WORKSPACE),
    [`GET /postgres/${DB.id}`]: () => json(200, DB),
    "GET /services/srv-web": () => json(200, service("srv-web", specs.web, { serviceDetails: { ...service("x", specs.web).serviceDetails, url: WEB_ORIGIN } })),
    "GET /services/srv-engine": () => json(200, service("srv-engine", specs.engine)),
    "GET /services/crn-jobs": () => json(200, service("crn-jobs", specs.jobs)),
    "POST /oauth2/token": () => json(200, { access_token: "fake.paypal.token.not.real.0000", expires_in: 32000 }),
    "GET /notifications/webhooks/WH0000000000000001": () => json(200, { id: "WH0000000000000001", url: `${WEB_ORIGIN}/api/webhooks/paypal`, event_types: [] }),
  };
}

function useState(state) {
  const dir = mkdtempSync(path.join(tmpdir(), "render-test-"));
  const file = path.join(dir, "render-state.json");
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  testing.setStatePath(file);
}

beforeEach(() => {
  calls = [];
  routes = baseRoutes();
  globalThis.fetch = fakeFetch;
  testing.setSettings(SETTINGS);
  testing.setOptions({ create: false, migrate: false, planOnly: false });
  testing.setCompareOnly(false);
  useState(STATE);
});

afterEach(() => {
  testing.setCompareOnly(false);
});

describe("resources are found by their recorded id", () => {
  it("stops, and creates or writes nothing, when Render answers empty for the recorded mend-db (the auditor's repro)", async () => {
    routes[`GET /postgres/${DB.id}`] = () => new Response("", { status: 200 });
    await assert.rejects(testing.up(), (error) => error instanceof testing.DeployError && /recorded mend-db dpg-test-a/.test(error.message));
    assert.deepEqual(writes(), []);
    assert.equal(calls.some((call) => call.url.endsWith("/postgres")), false);
  });

  it("stops when the recorded mend-db is gone", async () => {
    routes[`GET /postgres/${DB.id}`] = () => json(404, { message: "not found" });
    await assert.rejects(testing.resolveResources(STATE), /recorded mend-db dpg-test-a is missing/);
    assert.deepEqual(writes(), []);
  });

  it("stops when the recorded mend-db was renamed or is on another plan", async () => {
    routes[`GET /postgres/${DB.id}`] = () => json(200, { ...DB, name: "someone-elses-db" });
    await assert.rejects(testing.resolveResources(STATE), /renamed/);
    routes[`GET /postgres/${DB.id}`] = () => json(200, { ...DB, plan: "pro_4gb" });
    await assert.rejects(testing.resolveResources(STATE), /plan pro_4gb/);
    assert.deepEqual(writes(), []);
  });

  it("stops when a recorded service is gone, renamed or on another plan", async () => {
    const specs = testing.SERVICES;
    routes["GET /services/srv-engine"] = () => json(404, { message: "not found" });
    await assert.rejects(testing.resolveResources(STATE), /recorded mend-engine srv-engine is missing/);
    routes["GET /services/srv-engine"] = () => json(200, service("srv-engine", specs.engine, { name: "mend-engine-old" }));
    await assert.rejects(testing.resolveResources(STATE), /renamed/);
    routes["GET /services/srv-engine"] = () => json(200, service("srv-engine", specs.engine, { serviceDetails: { ...service("x", specs.engine).serviceDetails, plan: "pro" } }));
    await assert.rejects(testing.resolveResources(STATE), /plan pro/);
    assert.deepEqual(writes(), []);
  });

  it("creates nothing without --create, and never a second copy of one that exists", async () => {
    const unrecorded = { workspace: STATE.workspace };
    routes["GET /postgres"] = () => json(200, []);
    routes["GET /services"] = () => json(200, []);
    routes["GET /notifications/webhooks"] = () => json(200, { webhooks: [] });
    await assert.rejects(testing.resolveResources(unrecorded), /pass --create/);
    testing.setOptions({ create: true });
    routes["GET /postgres"] = () => json(200, [{ postgres: DB, cursor: "c" }]);
    await assert.rejects(testing.resolveResources(unrecorded), /exists but render-state.json records no id/);
    routes["GET /postgres"] = () => json(200, []);
    const plan = await testing.resolveResources(unrecorded);
    assert.equal(plan.db.create, true);
    assert.ok(Object.values(plan.services).every((resolved) => resolved.create === true));
    assert.equal(plan.webhook.create, true);
    assert.deepEqual(writes(), []);
  });

  it("never creates a database under services that already run, even with --create", async () => {
    testing.setOptions({ create: true });
    routes["GET /postgres"] = () => json(200, []);
    await assert.rejects(testing.resolveResources({ ...STATE, database: {} }), /would point them at an empty database/);
    assert.deepEqual(writes(), []);
  });

  it("stops, and writes nothing, when a recorded service connects to another database", async () => {
    routes[`GET /postgres/${DB.id}/connection-info`] = () =>
      json(200, {
        internalConnectionString: "postgresql://mend_owner:owner-pass-not-real-0000@dpg-test-a/mend",
        externalConnectionString: "postgresql://mend_owner:owner-pass-not-real-0000@dpg-test-a.virginia-postgres.render.com/mend",
      });
    routes["GET /services/srv-web/env-vars"] = () => json(200, [{ envVar: { key: "DATABASE_URL", value: "postgresql://mend_web:web-pass-not-real-00000@dpg-other-a/mend" }, cursor: "c" }]);
    routes["GET /services/srv-engine/env-vars"] = () => json(200, []);
    routes["GET /services/crn-jobs/env-vars"] = () => json(200, []);
    await assert.rejects(testing.up(), /mend-web connects to another database than the recorded mend-db/);
    assert.deepEqual(writes(), []);
  });
});

describe("prove is compare-only", () => {
  it("refuses every Render write except this machine's allow-list entry, without sending it", async () => {
    testing.setCompareOnly(true);
    await assert.rejects(testing.renderCall("PUT", "/services/srv-web/env-vars/DATABASE_URL", { value: "x" }), /compare-only/);
    await assert.rejects(testing.renderCall("POST", "/postgres", {}), /compare-only/);
    await assert.rejects(testing.renderCall("PATCH", `/postgres/${DB.id}`, { ipAllowList: [], plan: "pro_4gb" }, { allowList: true }), /compare-only/);
    await assert.rejects(testing.paypalCall("DELETE", "/v1/notifications/webhooks/WH0000000000000001"), /compare-only/);
    assert.deepEqual(writes(), []);
  });

  it("adds this machine's entry for the run and removes it in a finally, leaving other entries alone", async () => {
    let list = DB.ipAllowList;
    routes[`GET /postgres/${DB.id}`] = () => json(200, { ...DB, ipAllowList: list });
    routes[`PATCH /postgres/${DB.id}`] = (init) => {
      list = JSON.parse(init.body).ipAllowList;
      return json(200, { ...DB, ipAllowList: list });
    };
    testing.setCompareOnly(true);
    await assert.rejects(
      testing.withMachineAccess({ ...DB, ipAllowList: list }, async () => {
        assert.ok(list.some((entry) => entry.cidrBlock === "203.0.113.5/32"));
        throw new Error("the proof failed half way");
      }),
      /half way/,
    );
    assert.deepEqual(list, DB.ipAllowList);
    assert.equal(writes().length, 2);
    assert.ok(writes().every((call) => call.method === "PATCH" && call.url.endsWith(`/postgres/${DB.id}`)));
  });

  it("a plan-only step records what it would change and does nothing", async () => {
    testing.setOptions({ planOnly: true });
    const changes = [];
    let ran = false;
    await testing.act(changes, "set env var DATABASE_URL on mend-web", async () => {
      ran = true;
    });
    assert.equal(ran, false);
    assert.deepEqual(changes, ["set env var DATABASE_URL on mend-web"]);
  });
});

describe("the read-only PayPal app", () => {
  const READ_BASIC = `Basic ${Buffer.from(`${SETTINGS.PAYPAL_READ_CLIENT_ID}:${SETTINGS.PAYPAL_READ_CLIENT_SECRET}`).toString("base64")}`;
  const READ_TOKEN = "fake.read.only.token.not.real.0000";
  const WEB_ENV = { PAYPAL_READ_CLIENT_ID: "on-render", PAYPAL_READ_CLIENT_SECRET: "on-render" };

  // PayPal as the live check of 28 Oct saw it: the read-only token has no payouts scope and is refused a payout batch.
  function readPayPal({ scope = "https://uri.paypal.com/services/payments/refund openid", payoutStatus = 403 } = {}) {
    routes["POST /oauth2/token"] = (init) =>
      init.headers.Authorization === READ_BASIC
        ? json(200, { access_token: READ_TOKEN, expires_in: 32000, ...(scope === null ? {} : { scope }) })
        : json(200, { access_token: "fake.paypal.token.not.real.0000", expires_in: 32000 });
    for (const id of ["JKEUJEAFGHFUN", "RUNBATCH123"]) {
      routes[`GET /payments/payouts/${id}`] = (init) => json(init.headers.Authorization === `Bearer ${READ_TOKEN}` ? payoutStatus : 200, { name: "NOT_AUTHORIZED" });
    }
  }

  it("is copied from .env to mend-web only", () => {
    const values = { roleConnections: { mend_web: { internal: "postgresql://mend_web:x@dpg-test-a/mend" }, mend_engine: { internal: "postgresql://mend_engine:x@dpg-test-a/mend" } }, engineToken: "t", csrfSecret: "c" };
    const web = testing.desiredEnv(testing.SERVICES.web, values);
    assert.equal(web.PAYPAL_READ_CLIENT_ID, SETTINGS.PAYPAL_READ_CLIENT_ID);
    assert.equal(web.PAYPAL_READ_CLIENT_SECRET, SETTINGS.PAYPAL_READ_CLIENT_SECRET);
    for (const key of ["engine", "jobs"]) {
      const env = testing.desiredEnv(testing.SERVICES[key], values);
      assert.equal("PAYPAL_READ_CLIENT_ID" in env || "PAYPAL_READ_CLIENT_SECRET" in env, false, key);
    }
  });

  it("is required for up and prove, naming the missing setting and never a value", () => {
    for (const key of ["PAYPAL_READ_CLIENT_ID", "PAYPAL_READ_CLIENT_SECRET"]) {
      testing.setSettings({ ...SETTINGS, [key]: undefined });
      assert.throws(() => testing.checkDeploySettings(), (error) => error instanceof testing.DeployError && error.message === `missing or invalid in .env: ${key}`);
    }
    testing.setSettings({ ...SETTINGS, PAYPAL_READ_CLIENT_ID: SETTINGS.PAYPAL_CLIENT_ID });
    assert.throws(() => testing.checkDeploySettings(), (error) => /must belong to a different PayPal app/.test(error.message) && !error.message.includes(SETTINGS.PAYPAL_CLIENT_ID));
    testing.setSettings(SETTINGS);
    assert.doesNotThrow(() => testing.checkDeploySettings());
  });

  it("is swept as a secret: both values and their base64 pair", () => {
    for (const value of [SETTINGS.PAYPAL_READ_CLIENT_ID, SETTINGS.PAYPAL_READ_CLIENT_SECRET, READ_BASIC.slice("Basic ".length)]) {
      assert.equal(testing.carriesSecret(`a line holding ${value}`), true, value);
    }
  });

  it("passes the read keys check when mend-web holds both names and PayPal refuses the token a payout batch", async () => {
    readPayPal();
    const result = await testing.readKeysCheck(WEB_ENV, null);
    assert.equal(result.passed, true, result.text);
    assert.match(result.text, /carries 2 scopes, none for payouts, and PayPal answers 403/);
    assert.ok(calls.some((call) => call.url.endsWith("/v1/payments/payouts/JKEUJEAFGHFUN")));
    assert.equal(testing.carriesSecret(result.text), false);
    assert.equal(testing.carriesSecret(`Bearer ${READ_TOKEN}`), true);
    await testing.readKeysCheck(WEB_ENV, "RUNBATCH123");
    assert.ok(calls.some((call) => call.url.endsWith("/v1/payments/payouts/RUNBATCH123")));
    assert.deepEqual(writes(), []);
  });

  it("fails the read keys check on a missing name, a payouts scope, no scopes at all, or a payout batch PayPal hands over", async () => {
    readPayPal();
    const missing = await testing.readKeysCheck({ PAYPAL_READ_CLIENT_ID: "on-render" }, null);
    assert.equal(missing.passed, false);
    assert.match(missing.text, /mend-web lacks PAYPAL_READ_CLIENT_SECRET/);
    readPayPal({ scope: "https://uri.paypal.com/services/payments/payouts openid" });
    assert.equal((await testing.readKeysCheck(WEB_ENV, null)).passed, false);
    readPayPal({ scope: null });
    assert.equal((await testing.readKeysCheck(WEB_ENV, null)).passed, false);
    readPayPal({ payoutStatus: 200 });
    const handedOver = await testing.readKeysCheck(WEB_ENV, null);
    assert.equal(handedOver.passed, false);
    assert.match(handedOver.text, /answered 200, not 403/);
  });
});
