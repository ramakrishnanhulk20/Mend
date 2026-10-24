/**
 * A temporary public PayPal webhook for the engine's live proofs (prove_m5 drives it).
 *
 * Builds and starts the web app, opens a quick cloudflared tunnel to it, registers a
 * PayPal webhook for the event types given as arguments, and restarts the app with that
 * webhook id so it verifies and stores real deliveries in the dev database. Stdout carries
 * JSON lines only: {"ready": true, ...} once deliveries can arrive. Everything stays open
 * until stdin closes (the driver closing it, or dying). Then the webhook is deleted and the
 * tunnel, server and database handle are stopped, one {"cleanup": ...} line per step and a
 * final {"done": true, "ok": ...}. Failures before ready print {"ready": false, "error": ...}
 * and clean up the same way.
 *
 * Run from packages/web: node node_modules/tsx/dist/cli.mjs scripts/webhook-session.ts EVENT_TYPE ...
 */
import type { ChildProcess } from "node:child_process";
import { readCredentials } from "../src/server/config";
import { PayPalClient } from "../src/server/paypal";
import { holdDevDatabase } from "./dev-database";
import { buildApp, freePort, HarnessFailed, readEnv, sleep, startServer, startTunnel, stopProcess } from "./webhook-tunnel";

const WEBHOOK_PATH = "/api/webhooks/paypal";
const EVENT_TYPE = /^[A-Z][A-Z0-9._-]{0,127}$/;
const WEBHOOK_ID = /^[A-Za-z0-9]{1,50}$/;
const MAX_EVENT_TYPES = 50;

function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

type Step = { readonly name: string; readonly run: () => Promise<Record<string, unknown>> };
const cleanups: Step[] = [];
let cleanedUp = false;
let allClean = true;

async function cleanUp(): Promise<void> {
  if (cleanedUp) return;
  cleanedUp = true;
  while (cleanups.length > 0) {
    const step = cleanups.pop();
    if (step === undefined) break;
    try {
      const result = await step.run();
      if (result.ok === false) allClean = false;
      emit({ cleanup: step.name, ok: true, ...result });
    } catch (error) {
      allClean = false;
      emit({ cleanup: step.name, ok: false, error: error instanceof Error ? error.message : "unknown error" });
    }
  }
  emit({ done: true, ok: allClean });
}

// Counts of what the receiver logged, by outcome and event type, so a driver can see what
// arrived even when nothing was stored. The log lines carry ids and headers, never secrets.
const deliveries: Record<string, number> = {};
let pending = "";

function countDeliveries(chunk: string): void {
  pending += chunk;
  const lines = pending.split(/\r?\n/);
  pending = lines.pop() ?? "";
  for (const text of lines) {
    if (!text.startsWith("{")) continue;
    try {
      const entry = JSON.parse(text) as { kind?: unknown; outcome?: unknown; event_type?: unknown; reason?: unknown };
      if (entry.kind !== "webhook") continue;
      const key = `${String(entry.outcome)} ${typeof entry.event_type === "string" ? entry.event_type : String(entry.reason)}`;
      deliveries[key] = (deliveries[key] ?? 0) + 1;
    } catch {
      // Not a log record.
    }
  }
}

async function main(): Promise<void> {
  const eventTypes = process.argv.slice(2);
  if (eventTypes.length === 0 || eventTypes.length > MAX_EVENT_TYPES || !eventTypes.every((name) => EVENT_TYPE.test(name))) {
    throw new HarnessFailed("give 1 to 50 PayPal event type names as arguments");
  }
  const credentials = readCredentials(readEnv(["PAYPAL_ENV", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]));
  const paypal = new PayPalClient(credentials);

  const database = await holdDevDatabase();
  cleanups.push({ name: "database", run: async () => (await database.release(), {}) });

  buildApp();
  const port = await freePort();
  const appEnv = {
    PAYPAL_ENV: "sandbox",
    PAYPAL_CLIENT_ID: credentials.clientId,
    PAYPAL_CLIENT_SECRET: credentials.clientSecret,
    DATABASE_URL: database.url,
  };
  let server: ChildProcess = await startServer(port, appEnv, countDeliveries);
  cleanups.push({ name: "server", run: async () => (await stopProcess(server), { deliveries }) });

  let tunnel: ChildProcess | undefined;
  cleanups.push({ name: "tunnel", run: async () => (tunnel === undefined ? {} : (await stopProcess(tunnel), {})) });
  const origin = await startTunnel(port, (child) => {
    tunnel = child;
  });

  const webhookUrl = new URL(WEBHOOK_PATH, origin).href;
  const created = await paypal.request("/v1/notifications/webhooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl, event_types: eventTypes.map((name) => ({ name })) }),
  });
  const webhook = created.body as { id?: unknown; event_types?: { name?: unknown }[] } | null;
  const webhookId = typeof webhook?.id === "string" && WEBHOOK_ID.test(webhook.id) ? webhook.id : null;
  if (created.status !== 201 || webhookId === null) {
    throw new HarnessFailed(`webhook create answered ${created.status} (debug_id ${created.debugId})`);
  }
  cleanups.push({
    name: "webhook",
    run: async () => {
      const deleted = await paypal.request(`/v1/notifications/webhooks/${webhookId}`, { method: "DELETE" });
      return { ok: deleted.status === 204, webhook_id: webhookId, status: deleted.status };
    },
  });
  const subscribed = new Set((webhook?.event_types ?? []).map((type) => type.name));
  const missing = eventTypes.filter((name) => !subscribed.has(name));

  // The webhook id only exists now, so the server restarts with it on the same port.
  await stopProcess(server);
  await sleep(1_000);
  server = await startServer(port, { ...appEnv, PAYPAL_WEBHOOK_ID: webhookId }, countDeliveries);
  emit({ ready: true, webhook_id: webhookId, webhook_url: webhookUrl, event_types: eventTypes.length, not_subscribed: missing });
}

function waitForStdinToClose(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.on("end", resolve);
    process.stdin.on("close", resolve);
    process.stdin.on("error", resolve);
    process.stdin.resume();
  });
}

process.once("SIGINT", () => {
  void cleanUp().then(() => process.exit(130));
});

main().then(
  async () => {
    await waitForStdinToClose();
    await cleanUp();
    process.exit(allClean ? 0 : 1);
  },
  async (error: unknown) => {
    emit({ ready: false, error: error instanceof Error ? error.message : "unexpected failure" });
    await cleanUp();
    process.exit(1);
  },
);
