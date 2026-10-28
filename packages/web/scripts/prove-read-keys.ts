/**
 * Read-keys proof: the AI agent's PayPal reads use a second sandbox app that PayPal itself
 * refuses on the Payouts API, and they keep answering while PayPal's hosted MCP server is
 * broken. Against the live PayPal sandbox:
 *   1. the read-only app's token carries no scope naming payouts;
 *   2. a payout batch read with that token answers 403, while the main app reads the same
 *      batch with 200, so the 403 is PayPal's permission check and not a missing batch;
 *   3. the main app creates one order (USD 1.00, intent CAPTURE). Nobody approves it, so it
 *      stays CREATED and no money moves;
 *   4. callPayPalTool("get_order") with the app's default tokens returns that order as
 *      CREATED, with its token minted from the read-only app's keys, and says whether the
 *      answer came through PayPal's MCP server or straight from its REST API;
 *   5. callPayPalTool("list_disputes") returns a disputes list, and the way it came.
 *
 * Run from packages/web: npm run prove:read-keys. Needs PAYPAL_CLIENT_ID,
 * PAYPAL_CLIENT_SECRET, PAYPAL_READ_CLIENT_ID and PAYPAL_READ_CLIENT_SECRET in the repo's
 * .env. Never opens a database: the web config insists on DATABASE_URL and
 * PAYPAL_WEBHOOK_ID, so unused stand-ins are set when .env has none. Prints PASS or FAIL
 * per step with ids, statuses and counts only, never a key or a token, and ends with
 * "READ KEYS RESULT: PASS" only when every step passed.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { readCredentials, readOnlyCredentials, type PayPalCredentials } from "../src/server/config";
import { PayPalClient, sandboxUrl } from "../src/server/paypal";
import { callPayPalTool, McpFailed } from "../src/server/paypal-mcp";

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.resolve(WEB_DIR, "..", "..", ".env");
// A payout batch the shop sent on the sandbox; the main app can read it.
const KNOWN_BATCH_ID = "JKEUJEAFGHFUN";
const UNUSED_WEBHOOK_ID = "READKEYSPROOFNOWEBHOOK";
const UNUSED_DATABASE_URL = "postgresql://unused@127.0.0.1:5432/unused";
const ORDER_ID = /^[A-Z0-9]{17,32}$/;

class ProofFailed extends Error {}

let allPassed = true;

function line(passed: boolean, text: string): void {
  if (!passed) allPassed = false;
  console.log(`${passed ? "PASS" : "FAIL"}  ${text}`);
}

function described(error: unknown): string {
  if (error instanceof McpFailed) return `McpFailed ${error.reason}${error.status === null ? "" : ` (status ${error.status})`}`;
  return error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "unknown failure";
}

async function step<T>(label: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    line(false, `${label}: ${described(error)}`);
    return null;
  }
}

function readEnv(): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...parseEnv(readFileSync(ENV_PATH, "utf8").replace(/^﻿/, "")) };
  for (const name of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_READ_CLIENT_ID", "PAYPAL_READ_CLIENT_SECRET"]) {
    if (process.env[name] !== undefined) merged[name] = process.env[name];
  }
  return merged;
}

function basicOf(credentials: PayPalCredentials): string {
  return `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`;
}

/** A client-credentials token and the scopes PayPal says it carries. */
async function tokenWithScopes(credentials: PayPalCredentials): Promise<{ token: string; scopes: string[] }> {
  const response = await fetch(sandboxUrl("/v1/oauth2/token"), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", Authorization: basicOf(credentials) },
    body: "grant_type=client_credentials",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => null)) as { access_token?: unknown; scope?: unknown } | null;
  if (response.status !== 200 || typeof body?.access_token !== "string") throw new ProofFailed(`the token request answered ${response.status}`);
  return { token: body.access_token, scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [] };
}

async function payoutBatchStatus(token: string): Promise<number> {
  const response = await fetch(sandboxUrl(`/v1/payments/payouts/${KNOWN_BATCH_ID}`), {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel().catch(() => undefined);
  return response.status;
}

type Sent = { readonly host: string; readonly method: string; readonly path: string; readonly readApp: boolean };

/** Records where the app's own PayPal calls go, and whether each token request used the read-only app's keys. */
function recordRequests(readBasic: string): Sent[] {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    sent.push({ host: url.hostname, method: init?.method ?? "GET", path: url.pathname, readApp: authorization === readBasic });
    return original(input, init);
  };
  return sent;
}

async function main(): Promise<void> {
  const env = readEnv();
  const main = readCredentials({ PAYPAL_ENV: "sandbox", PAYPAL_CLIENT_ID: env.PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET: env.PAYPAL_CLIENT_SECRET });
  const read = readOnlyCredentials(env, main);
  if (!read.separate) throw new ProofFailed("PAYPAL_READ_CLIENT_ID and PAYPAL_READ_CLIENT_SECRET must be in .env");
  // The web config is loaded on the first PayPal read; these are its settings for this process only.
  Object.assign(process.env, {
    PAYPAL_ENV: "sandbox",
    PAYPAL_CLIENT_ID: main.clientId,
    PAYPAL_CLIENT_SECRET: main.clientSecret,
    PAYPAL_READ_CLIENT_ID: read.credentials.clientId,
    PAYPAL_READ_CLIENT_SECRET: read.credentials.clientSecret,
    PAYPAL_WEBHOOK_ID: env.PAYPAL_WEBHOOK_ID || UNUSED_WEBHOOK_ID,
    DATABASE_URL: env.DATABASE_URL || UNUSED_DATABASE_URL,
  });

  const readToken = await step("1 scopes", async () => {
    const { token, scopes } = await tokenWithScopes(read.credentials);
    const payouts = scopes.filter((scope) => /payout/i.test(scope)).length;
    line(scopes.length > 0 && payouts === 0, `1 scopes: the read-only app's token carries ${scopes.length} scopes, ${payouts} of them for payouts`);
    return token;
  });

  await step("2 payouts refused", async () => {
    if (readToken === null) throw new ProofFailed("skipped, no read-only token");
    const withRead = await payoutBatchStatus(readToken);
    const withMain = await payoutBatchStatus((await tokenWithScopes(main)).token);
    line(withRead === 403 && withMain === 200, `2 payouts refused: GET payout batch ${KNOWN_BATCH_ID} answers ${withRead} with the read-only token and ${withMain} with the main app's`);
  });

  const orderId = await step("3 order", async () => {
    const reply = await new PayPalClient(main).request("/v2/checkout/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "PayPal-Request-Id": randomUUID() },
      body: JSON.stringify({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }] }),
    });
    const body = reply.body as { id?: unknown; status?: unknown } | null;
    const id = typeof body?.id === "string" && ORDER_ID.test(body.id) ? body.id : null;
    line((reply.status === 201 || reply.status === 200) && id !== null && body?.status === "CREATED", `3 order: the main app created order ${id ?? "none"}, status ${String(body?.status)} (answer ${reply.status}); nobody approves it, so no money moves`);
    return id;
  });

  const sent = recordRequests(basicOf(read.credentials));

  await step("4 get_order", async () => {
    if (orderId === null) throw new ProofFailed("skipped, no order was created");
    const view = await callPayPalTool("get_order", { id: orderId });
    const tokenRequests = sent.filter((entry) => entry.path === "/v1/oauth2/token");
    const fromReadApp = tokenRequests.length > 0 && tokenRequests.every((entry) => entry.readApp);
    const hosts = [...new Set(sent.filter((entry) => entry.path !== "/v1/oauth2/token").map((entry) => entry.host))];
    line(
      view.id === orderId && view.status === "CREATED" && (view.via === "paypal_rest" || view.via === "paypal_mcp") && fromReadApp,
      `4 get_order: order ${String(view.id)} is ${String(view.status)}, via ${String(view.via)} (${view.via === "paypal_rest" ? "PayPal's MCP server is still broken, so the read went straight to its REST API" : "PayPal's MCP server answered"}); token from the read-only app: ${fromReadApp ? "yes" : "no"}; hosts asked: ${hosts.join(", ")}`,
    );
  });

  await step("5 list_disputes", async () => {
    const view = await callPayPalTool("list_disputes", {});
    const disputes = view.disputes;
    line(Array.isArray(disputes) && (view.via === "paypal_rest" || view.via === "paypal_mcp"), `5 list_disputes: ${Array.isArray(disputes) ? disputes.length : "no"} disputes, via ${String(view.via)}`);
  });

  console.log(`READ KEYS RESULT: ${allPassed ? "PASS" : "FAIL"}`);
  if (!allPassed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.log(`FAIL  ${described(error)}`);
  console.log("READ KEYS RESULT: FAIL");
  process.exitCode = 1;
});
