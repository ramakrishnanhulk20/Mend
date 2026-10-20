/**
 * M1b live proof: a real PayPal sandbox payout makes PayPal send real, signed webhooks to
 * this app through a temporary public tunnel. The receiver must verify each with PayPal,
 * store it once, and refuse forgeries, replays, oversize bodies and repeated keys.
 *
 * Run from packages/web: npm run prove:m1b. Prints PASS or FAIL per line and ends with
 * "M1B RESULT: PASS" only if every line passed. Always deletes the webhook it created,
 * stops the tunnel and the server, and releases the database, even on failure.
 * Each run sends one 1.00 USD sandbox payout to MEND_TEST_RECEIVER.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { lookup as systemLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { Resolver } from "node:dns/promises";
import { readFileSync } from "node:fs";
import https from "node:https";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import pg from "pg";
import { readCredentials, type Env } from "../src/server/config";
import { HostRefused, PayPalClient, paypalFetch, type FetchFn } from "../src/server/paypal";
import { holdDevDatabase } from "./dev-database";

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.resolve(WEB_DIR, "..", "..", ".env");
const NEXT_BIN = path.join(WEB_DIR, "node_modules", "next", "dist", "bin", "next");
const CLOUDFLARED =
  process.platform === "win32" ? "C:/Program Files (x86)/cloudflared/cloudflared.exe" : "cloudflared";
const DIST_DIR = ".next-verify";
const WEBHOOK_PATH = "/api/webhooks/paypal";
const PAYOUT_MINOR = 100;
const DELIVERY_WAIT_MS = 3 * 60 * 1000;
const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const TOKEN_SHAPE = /A21AA[A-Za-z0-9_-]{20,}/;
const EVENT_TYPES = [
  ...["SUCCEEDED", "FAILED", "BLOCKED", "HELD", "UNCLAIMED", "RETURNED", "REFUNDED", "CANCELED"].map(
    (name) => `PAYMENT.PAYOUTS-ITEM.${name}`,
  ),
  ...["DENIED", "PROCESSING", "SUCCESS"].map((name) => `PAYMENT.PAYOUTSBATCH.${name}`),
];
const DELIVERY_HEADER_NAMES = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const;

type Delivery = { readonly [K in keyof typeof DELIVERY_HEADER_NAMES]: string };
type ServerLog = Record<string, unknown>;

class ProofFailed extends Error {}

let allPassed = true;

function line(passed: boolean, text: string): void {
  if (!passed) allPassed = false;
  console.log(`${passed ? "PASS" : "FAIL"}  ${text}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readEnv(): Env {
  // The process environment wins over the file, as in the engine.
  const fromFile = parseEnv(readFileSync(ENV_PATH, "utf8").replace(/^\uFEFF/, ""));
  const merged: Record<string, string | undefined> = { ...fromFile };
  for (const name of ["PAYPAL_ENV", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "MEND_TEST_RECEIVER", "MEND_PAYOUT_ITEM_CAP_MINOR"]) {
    if (process.env[name] !== undefined) merged[name] = process.env[name];
  }
  return merged;
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
    // Kills the whole tree; a plain kill can leave the server's own children running.
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

// Public DNS first: Windows caches a "not found" answer for minutes, and a brand-new
// tunnel name can be looked up a moment before it exists.
const publicResolver = new Resolver({ timeout: 5_000, tries: 2 });
publicResolver.setServers(["1.1.1.1", "8.8.8.8"]);

function tunnelLookup(
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  publicResolver.resolve4(hostname).then(
    (addresses) => {
      if (options.all) callback(null, addresses.map((address) => ({ address, family: 4 })));
      else callback(null, addresses[0], 4);
    },
    () => systemLookup(hostname, options, callback as never),
  );
}

type PublicReply = { readonly status: number; readonly body: string };

function publicRequest(url: URL, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<PublicReply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { ...init.headers };
    if (init.body !== undefined) headers["content-length"] = Buffer.byteLength(init.body);
    const request = https.request(
      url,
      { method: init.method ?? "GET", headers, lookup: tunnelLookup as never, timeout: 30_000 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on("timeout", () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
    request.end(init.body);
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

function build(): void {
  const result = spawnSync(process.execPath, [NEXT_BIN, "build"], {
    cwd: WEB_DIR,
    env: { ...process.env, NEXT_DIST_DIR: DIST_DIR, NEXT_TELEMETRY_DISABLED: "1" },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const tail = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).slice(-15).join("\n");
    throw new ProofFailed(`next build failed:\n${tail}`);
  }
}

type Server = { readonly child: ChildProcess };

let serverOutput = "";

async function startServer(port: number, env: Record<string, string>): Promise<Server> {
  const inherited = { ...process.env };
  for (const name of Object.keys(inherited)) {
    if (name.startsWith("PAYPAL_") || name === "DATABASE_URL") delete inherited[name];
  }
  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: WEB_DIR,
    env: { ...inherited, ...env, NEXT_DIST_DIR: DIST_DIR, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      serverOutput += chunk;
    });
  }
  const local = new URL(`http://127.0.0.1:${port}/api/health`);
  await waitFor("local server start", 60_000, 500, async () => {
    if (child.exitCode !== null) throw new ProofFailed("server exited during start");
    const response = await fetch(local);
    return response.status === 200 && (await response.text()) === "ok" ? true : null;
  });
  return { child };
}

function serverLogs(): ServerLog[] {
  return serverOutput
    .split(/\r?\n/)
    .filter((text) => text.startsWith("{"))
    .flatMap((text) => {
      try {
        return [JSON.parse(text) as ServerLog];
      } catch {
        return [];
      }
    });
}

function logFor(ref: string): ServerLog | undefined {
  return serverLogs().find((entry) => entry.ref === ref);
}

function refOf(body: string): string {
  return /\(ref ([0-9a-f-]{36})\)$/.exec(body)?.[1] ?? "";
}

type Tunnel = { readonly origin: URL; readonly child: ChildProcess };

async function startTunnel(port: number): Promise<Tunnel> {
  const child = spawn(CLOUDFLARED, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      output += chunk;
    });
  }
  onCleanup("stop the tunnel", () => stopProcess(child));
  const address = await waitFor("tunnel address", 90_000, 500, async () => {
    if (child.exitCode !== null) throw new ProofFailed("cloudflared exited");
    const found = TUNNEL_URL.exec(output)?.[0];
    return found !== undefined && output.includes("Registered tunnel connection") ? found : null;
  });
  // C24: the webhook address comes from the tunnel cloudflared reports, never from a request.
  const origin = new URL(address);
  if (origin.protocol !== "https:" || !TUNNEL_URL.test(origin.origin) || origin.origin !== address) {
    throw new ProofFailed("cloudflared reported an unexpected address");
  }
  return { origin, child };
}

function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function alterOneCharacter(raw: string): string {
  const match = /"summary":"[^"\\]/.exec(raw) ?? /"create_time":"[0-9]/.exec(raw);
  if (match === null) throw new ProofFailed("no character to alter in the stored event");
  const at = match.index + match[0].length - 1;
  const replacement = raw[at] === "X" ? "Y" : "X";
  return raw.slice(0, at) + replacement + raw.slice(at + 1);
}

function deliveryHeaders(delivery: Delivery): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const [key, name] of Object.entries(DELIVERY_HEADER_NAMES)) headers[name] = delivery[key as keyof Delivery];
  return headers;
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const env = readEnv();
  const credentials = readCredentials(env);
  const receiver = env.MEND_TEST_RECEIVER ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(receiver)) throw new ProofFailed("MEND_TEST_RECEIVER is not set to an email address");
  const itemCap = Number(env.MEND_PAYOUT_ITEM_CAP_MINOR);
  if (!Number.isInteger(itemCap) || itemCap < PAYOUT_MINOR) throw new ProofFailed("MEND_PAYOUT_ITEM_CAP_MINOR is below the 1.00 USD proof payout");

  // The proof's own PayPal client. Its token is noted only to search for it later.
  let scriptToken = "";
  const recordingFetch: FetchFn = async (url, init) => {
    const response = await fetch(url, init);
    if (url.pathname === "/v1/oauth2/token") {
      const body = (await response.clone().json()) as { access_token?: unknown };
      if (typeof body.access_token === "string") scriptToken = body.access_token;
    }
    return response;
  };
  const paypal = new PayPalClient(credentials, { fetch: recordingFetch });

  const database = await holdDevDatabase();
  onCleanup("release the dev database", () => database.release());
  const db = new pg.Client({ connectionString: database.url });
  await db.connect();
  onCleanup("close the proof's database connection", () => db.end());

  build();
  const port = await freePort();
  const appEnv = {
    PAYPAL_ENV: "sandbox",
    PAYPAL_CLIENT_ID: credentials.clientId,
    PAYPAL_CLIENT_SECRET: credentials.clientSecret,
    DATABASE_URL: database.url,
  };
  let server = await startServer(port, appEnv);
  onCleanup("stop the server", () => stopProcess(server.child));
  line(true, `server: next start on 127.0.0.1:${port} with DATABASE_URL from dev_url`);

  const tunnel = await startTunnel(port);
  const health = await waitFor("tunnel health check", 120_000, 2_000, async () => {
    const reply = await publicRequest(new URL("/api/health", tunnel.origin));
    return reply.status === 200 && reply.body === "ok" ? reply : null;
  });
  line(health.body === "ok", `tunnel: ${tunnel.origin.origin} reachable, /api/health says ok`);

  const webhookUrl = new URL(WEBHOOK_PATH, tunnel.origin).href;
  const created = await paypal.request("/v1/notifications/webhooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl, event_types: EVENT_TYPES.map((name) => ({ name })) }),
  });
  const webhook = created.body as { id?: unknown; url?: unknown; event_types?: { name?: unknown }[] } | null;
  const webhookId = typeof webhook?.id === "string" && /^[A-Za-z0-9]{1,50}$/.test(webhook.id) ? webhook.id : null;
  if (created.status !== 201 || webhookId === null) {
    throw new ProofFailed(`webhook create answered ${created.status} (debug_id ${created.debugId})`);
  }
  onCleanup("delete the webhook", async () => {
    const deleted = await paypal.request(`/v1/notifications/webhooks/${webhookId}`, { method: "DELETE" });
    line(deleted.status === 204, `cleanup: webhook ${webhookId} deleted${deleted.status === 204 ? "" : ` (status ${deleted.status})`}`);
  });
  const subscribed = new Set((webhook?.event_types ?? []).map((type) => type.name));
  line(
    webhook?.url === webhookUrl && EVENT_TYPES.every((name) => subscribed.has(name)),
    `webhook: created ${webhookId} for ${webhookUrl} with PAYMENT.PAYOUTS-ITEM.* and PAYMENT.PAYOUTSBATCH.* events (${EVENT_TYPES.length} types)`,
  );

  // The webhook id only exists now, so the server restarts with it on the same port.
  await stopProcess(server.child);
  await sleep(1_000);
  server = await startServer(port, { ...appEnv, PAYPAL_WEBHOOK_ID: webhookId });

  const senderBatchId = `mend-m1b-${utcStamp(new Date())}`;
  const payout = await paypal.request("/v1/payments/payouts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "PayPal-Request-Id": senderBatchId },
    body: JSON.stringify({
      sender_batch_header: { sender_batch_id: senderBatchId, email_subject: "Mend webhook proof", recipient_type: "EMAIL" },
      items: [
        {
          recipient_type: "EMAIL",
          receiver,
          amount: { currency: "USD", value: (PAYOUT_MINOR / 100).toFixed(2) },
          note: "Mend webhook proof payout",
          sender_item_id: "m1b-1",
          purpose: "CASHBACK",
        },
      ],
    }),
  });
  const payoutBatchId = (payout.body as { batch_header?: { payout_batch_id?: unknown } } | null)?.batch_header?.payout_batch_id;
  if (payout.status !== 201 || typeof payoutBatchId !== "string") {
    throw new ProofFailed(`payout answered ${payout.status} (debug_id ${payout.debugId})`);
  }
  line(true, `payout: 1.00 USD to MEND_TEST_RECEIVER, sender_batch_id ${senderBatchId}, PayPal batch ${payoutBatchId}`);
  const payoutSentAt = Date.now();

  type Stored = { transmission_id: string; event_id: string; event_type: string; raw: string };
  const stored = await waitFor("a payout item webhook", DELIVERY_WAIT_MS, 3_000, async () => {
    const { rows } = await db.query<Stored>(
      "select transmission_id, event_id, event_type, raw from paypal_events where event_type like 'PAYMENT.PAYOUTS-ITEM.%' and received_at >= $1",
      [startedAt],
    );
    return rows.find((row) => (JSON.parse(row.raw) as { resource?: { payout_batch_id?: unknown } }).resource?.payout_batch_id === payoutBatchId) ?? null;
  });
  const sameEvent = await db.query<{ n: number }>("select count(*)::int as n from paypal_events where event_id = $1", [stored.event_id]);
  const storedLog = serverLogs().find((entry) => entry.transmission_id === stored.transmission_id && entry.outcome === "stored");
  line(
    sameEvent.rows[0].n === 1 && storedLog?.status === 200,
    `delivery: real ${stored.event_type} event ${stored.event_id} verified by PayPal and stored once (${Math.round((Date.now() - payoutSentAt) / 1000)} s after the payout)`,
  );
  const delivery = storedLog?.delivery as Delivery | undefined;
  if (delivery === undefined) throw new ProofFailed("the server log has no headers for the stored delivery");
  const headers = deliveryHeaders(delivery);
  const webhookTarget = new URL(webhookUrl);
  const countRows = async (): Promise<number> =>
    (await db.query<{ n: number }>("select count(*)::int as n from paypal_events")).rows[0].n;

  const before = await countRows();
  const forged = await publicRequest(webhookTarget, { method: "POST", headers, body: alterOneCharacter(stored.raw) });
  const forgedLog = logFor(refOf(forged.body));
  const rawAfterForgery = await db.query<{ raw: string }>("select raw from paypal_events where transmission_id = $1", [stored.transmission_id]);
  line(
    forged.status === 400 && forgedLog?.reason === "verify_failure" && (await countRows()) === before && rawAfterForgery.rows[0]?.raw === stored.raw,
    `forgery: altered body refused with 400, nothing stored${forged.status === 400 ? "" : ` (got ${forged.status}, ${String(forgedLog?.reason)})`}`,
  );

  const replay = await publicRequest(webhookTarget, { method: "POST", headers, body: stored.raw });
  const replayLog = logFor(refOf(replay.body));
  line(
    replay.status === 200 && replayLog?.outcome === "duplicate" && (await countRows()) === before,
    `replay: the identical delivery returns 200 and stores nothing new${replay.status === 200 ? "" : ` (got ${replay.status})`}`,
  );

  const oversize = await publicRequest(webhookTarget, {
    method: "POST",
    headers,
    body: JSON.stringify({ id: "WH-OVERSIZE", event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", padding: "x".repeat(300 * 1024) }),
  });
  line(oversize.status === 413 && (await countRows()) === before, `oversize: 300 KB body refused with 413${oversize.status === 413 ? "" : ` (got ${oversize.status})`}`);

  const duplicated = stored.raw.replace(/^\s*\{/, '{"id":"WH-DUPLICATE-KEY",');
  const duplicate = await publicRequest(webhookTarget, { method: "POST", headers, body: duplicated });
  const duplicateLog = logFor(refOf(duplicate.body));
  line(
    duplicate.status === 400 && duplicateLog?.reason === "duplicate_key" && (await countRows()) === before,
    `duplicate keys: refused with 400${duplicate.status === 400 ? "" : ` (got ${duplicate.status})`}`,
  );

  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    return realFetch(...args);
  }) as typeof fetch;
  let refused = false;
  try {
    await paypalFetch("https://api-m.paypal.com/v1/oauth2/token", { method: "POST", body: "grant_type=client_credentials" });
  } catch (error) {
    refused = error instanceof HostRefused;
  } finally {
    globalThis.fetch = realFetch;
  }
  line(refused && fetchCalls === 0, "host guard: a PayPal call built for api-m.paypal.com is refused before sending");

  const purge = await db.query<{ seconds: number }>(
    "select extract(epoch from purge_after - received_at)::int as seconds from paypal_events where transmission_id = $1",
    [stored.transmission_id],
  );
  line(purge.rows[0]?.seconds === 48 * 3600, "purge: purge_after is 48 hours after received_at");

  const table = await db.query<{ everything: string }>(
    "select coalesce(string_agg(concat_ws(' ', transmission_id, event_id, event_type, resource_id, raw), ' '), '') as everything from paypal_events",
  );
  const haystacks = [serverOutput, table.rows[0].everything];
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
  const tokenShapeChecked = TOKEN_SHAPE.test(scriptToken);
  const leaked = haystacks.some(
    (text) => text.includes(credentials.clientSecret) || text.includes(basic) || (scriptToken !== "" && text.includes(scriptToken)) || TOKEN_SHAPE.test(text),
  );
  line(tokenShapeChecked && !leaked, "secrets: client secret and token absent from server logs and the paypal_events table");
}

let finished = false;

async function finish(code: number): Promise<never> {
  if (!finished) {
    finished = true;
    await cleanUp();
    console.log(`M1B RESULT: ${allPassed && code === 0 ? "PASS" : "FAIL"}`);
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
    line(false, error instanceof ProofFailed || error instanceof Error ? error.message : "unexpected failure");
    return finish(1);
  },
);
