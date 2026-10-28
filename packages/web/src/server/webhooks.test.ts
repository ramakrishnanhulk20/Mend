// Covers the webhook route, handleDelivery and verifyDelivery against a real Postgres
// schema (the engine's schema.sql in a throwaway schema) with deliveries really signed
// over transmission id, time, webhook id and the body's CRC-32 by a throwaway certificate
// chain (__fixtures__/test-chain.ts), trusted through the signature checker's injectable
// anchors. It checks that nothing calls PayPal's API, the in-memory counts charged only
// for rejected deliveries and never refusing one that verifies, junk past the counts
// answered without a query, the streamed body cap, strict UTF-8 and the signature over
// the raw bytes, replays answered without a signature check (after the 47-hour purge too,
// from the engine's event_outcomes), the reviewers' flood repros, each sender's share of
// the certificate downloads, PayPal's certificate address remembered in the real
// paypal_certs table across a restart (a fresh checker over the same database), and the
// first rejection per reason and address each minute on the audit record, at most 20 per
// reason a minute, with the address tag in the log line. Does NOT cover: PayPal's real
// certificate (webhook-signature.test.ts checks its chain) or a real PayPal signature and
// delivery timing (render.mjs prove "delivery" does), Render's proxy really writing the
// client address (ratelimit.test.ts names that gap), a flood spread across many
// addresses beyond the shared count, or the engine itself: the engine client is replaced
// by a stand-in that records what it was asked (engine.test.ts covers it).
import { randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { holdDevDatabase, SCHEMA_PATH, type DevDatabase } from "../../scripts/dev-database";
import { POST } from "../app/api/webhooks/paypal/route";
import { testChain } from "./__fixtures__/test-chain";
import { auditRows, webhookLimits, webhookRejections } from "./address-limits";
import { closeDatabase, database } from "./db";
import { runTask } from "./engine";
import { addressTag, writeSuppressedAudit } from "./ratelimit";
import { SignatureChecker } from "./webhook-signature";
import { handleDelivery, MAX_BODY_BYTES, parseTransmissionTime, refuseDeclaredLength, verifyDelivery } from "./webhooks";

const WEBHOOK_ID = "TESTWEBHOOK1";
const SECRET = "fake-client-secret-for-webhook-tests";
const CERT_URL = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-bf9ab596";
const GENERIC_BODY = /^(ok|refused|too large|too many requests|try again later) \(ref [0-9a-f-]{36}\)$/;
const RUN_ID = "brn-6f1c1d3e-2b9a-4f0e-9a51-3c1d2e4f5a6b";
const ROUTE_URL = "http://127.0.0.1:3000/api/webhooks/paypal";
const CHUNK_BYTES = 16 * 1024;

const signing = vi.hoisted(() => ({ checker: null as unknown }));

vi.mock("./engine", () => ({ runTask: vi.fn() }));
vi.mock("@/server/webhooks", async () => await import("./webhooks"));
vi.mock("./webhook-signature", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./webhook-signature")>();
  return { ...actual, deliverySignatures: () => signing.checker };
});
const asked = vi.mocked(runTask);
const chain = testChain();

function trusting(anchors: readonly string[] = [chain.root.pem]): SignatureChecker {
  return new SignatureChecker({ anchors, intermediates: [chain.intermediate.pem] });
}

// The network as the app sees it: PayPal's certificate address serves the test leaf, any
// other certificate path is a download answered 404, and any other request (PayPal's API
// above all) is recorded and answered 404.
const network = {
  certificate: (() => new Response(chain.leaf.pem)) as () => Response | Promise<Response>,
  certFetches: 0,
  otherRequests: [] as string[],
};

async function fakeNetwork(input: string | URL | Request): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.sandbox.paypal.com/v1/notifications/certs/")) {
    network.certFetches += 1;
    return url === CERT_URL ? network.certificate() : new Response("not found", { status: 404 });
  }
  network.otherRequests.push(url);
  return new Response("not found", { status: 404 });
}

function payoutItemEvent(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `WH-${randomUUID()}`,
    event_version: "1.0",
    create_time: "2026-10-20T12:00:00.000Z",
    resource_type: "payouts_item",
    event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
    summary: "A payout item has succeeded",
    resource: { payout_item_id: "8AELMXH8UB2P8", payout_batch_id: "DF6DLUL2WXLZ6", transaction_status: "SUCCESS" },
    links: [],
    ...extra,
  };
}

function paypalTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

type DeliveryOptions = { sentAt?: number; transmissionId?: string; webhookId?: string; forged?: boolean };

// Headers PayPal would send, signed with the test leaf's key over the documented text
// with the CRC-32 of crcOf; forged signs with a key no certificate vouches for.
function signedHeaders(crcOf: Buffer, options: DeliveryOptions = {}) {
  const transmissionId = options.transmissionId ?? randomUUID();
  const time = paypalTime(options.sentAt ?? Date.now());
  const text = `${transmissionId}|${time}|${options.webhookId ?? WEBHOOK_ID}|${crc32(crcOf)}`;
  const key = options.forged ? chain.stranger.keys.privateKey : chain.leafKeys.privateKey;
  const headers = new Headers({
    "content-type": "application/json",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": CERT_URL,
    "paypal-transmission-id": transmissionId,
    "paypal-transmission-sig": sign("sha256", Buffer.from(text, "utf8"), key).toString("base64"),
    "paypal-transmission-time": time,
  });
  return { headers, transmissionId };
}

function signedDelivery(event: Record<string, unknown> | string, options: DeliveryOptions = {}) {
  const body = typeof event === "string" ? event : JSON.stringify(event);
  return { body, ...signedHeaders(Buffer.from(body, "utf8"), options) };
}

// What the route receives: the delivery's headers plus the address Render's proxy appends.
function routeRequest(body: string | Uint8Array | ReadableStream<Uint8Array>, headers: Headers, address: string): Request {
  const sent = new Headers(headers);
  sent.set("x-forwarded-for", address);
  return new Request(ROUTE_URL, { method: "POST", headers: sent, body, duplex: "half" } as RequestInit & { duplex: "half" });
}

// A body with no Content-Length, handed over one 16 KB chunk at a time and only when the
// reader asks, so the meter shows exactly how much the route read.
function meteredBody(bytes: Buffer) {
  const meter = { given: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (meter.given >= bytes.length) {
          controller.close();
          return;
        }
        const piece = bytes.subarray(meter.given, meter.given + CHUNK_BYTES);
        meter.given += piece.length;
        controller.enqueue(new Uint8Array(piece));
      },
      cancel() {
        meter.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, meter };
}

// Every query and connection the app's pool is asked for while work runs.
async function databaseCalls(work: () => Promise<void>): Promise<number> {
  const pool = database();
  const query = vi.spyOn(pool, "query");
  const connect = vi.spyOn(pool, "connect");
  try {
    await work();
    return query.mock.calls.length + connect.mock.calls.length;
  } finally {
    query.mockRestore();
    connect.mockRestore();
  }
}

let dev: DevDatabase;
let admin: pg.Client;
let logLines: string[] = [];
const schema = `web_test_${process.pid}_${Date.now()}`;

async function rowCount(): Promise<number> {
  const result = await admin.query<{ n: number }>("select count(*)::int as n from paypal_events");
  return result.rows[0].n;
}

function logs(): Record<string, unknown>[] {
  return logLines.flatMap((line) => line.split("\n").filter(Boolean)).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function lastLog(): Record<string, unknown> {
  const all = logs();
  return all[all.length - 1];
}

async function rememberedCerts(): Promise<string[]> {
  const { rows } = await admin.query<{ url: string }>("select url from paypal_certs order by url");
  return rows.map((row) => row.url);
}

async function lastAuditId(): Promise<number> {
  const { rows } = await admin.query<{ id: number }>("select coalesce(max(id), 0)::int as id from audit_log");
  return rows[0].id;
}

async function auditSince(id: number): Promise<{ actor: string; action: string; detail: unknown }[]> {
  const { rows } = await admin.query("select actor, action, detail from audit_log where id > $1 order by id", [id]);
  return rows;
}

beforeAll(async () => {
  // dev_url runs the engine's full settings check before it starts Postgres, so every
  // setting it reads is set here; a fresh clone has no .env file to fall back on.
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  vi.stubEnv("PAYPAL_CLIENT_ID", "fake-client-id");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", SECRET);
  vi.stubEnv("MEND_DEV", "1");
  vi.stubEnv("MEND_PAYOUT_ITEM_CAP_MINOR", "1000");
  vi.stubEnv("MEND_CAMPAIGN_CAP_MINOR", "10000");
  vi.stubEnv("MEND_DAILY_CAP_MINOR", "20000");
  dev = await holdDevDatabase();
  admin = new pg.Client({ connectionString: dev.url });
  await admin.connect();
  const quoted = admin.escapeIdentifier(schema);
  await admin.query(`create schema ${quoted}`);
  await admin.query(`set search_path to ${quoted}`);
  await admin.query(readFileSync(SCHEMA_PATH, "utf8"));

  const url = new URL(dev.url);
  url.searchParams.set("options", `-c search_path=${schema}`);
  vi.stubEnv("PAYPAL_WEBHOOK_ID", WEBHOOK_ID);
  vi.stubEnv("DATABASE_URL", url.href);
  vi.stubEnv("MEND_CSRF_SECRET", "csrf-secret-for-webhook-tests-0123456789");
  vi.stubGlobal("fetch", fakeNetwork);
});

afterAll(async () => {
  await closeDatabase();
  if (admin) {
    await admin.query(`drop schema if exists ${admin.escapeIdentifier(schema)} cascade`);
    await admin.end();
  }
  await dev?.release();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await admin.query("truncate paypal_events, paypal_certs, event_outcomes");
  webhookLimits.clear();
  webhookRejections.clear();
  auditRows.clear();
  signing.checker = trusting();
  network.certificate = () => new Response(chain.leaf.pem);
  network.certFetches = 0;
  network.otherRequests = [];
  logLines = [];
  asked.mockReset();
  asked.mockResolvedValue(RUN_ID);
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    logLines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  return () => {
    vi.restoreAllMocks();
    const everything = logLines.join("");
    expect(everything).not.toContain(SECRET);
    expect(network.otherRequests).toEqual([]);
  };
});

describe("a verified delivery", () => {
  it("is stored once with its ids, the exact raw text and a purge time 47 hours after receipt", async () => {
    const event = payoutItemEvent();
    const delivery = signedDelivery(event);
    const result = await handleDelivery(delivery.body, delivery.headers);
    expect(result.status).toBe(200);
    expect(result.body).toMatch(GENERIC_BODY);

    const { rows } = await admin.query(
      "select *, extract(epoch from purge_after - received_at)::int as purge_seconds from paypal_events",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      transmission_id: delivery.transmissionId,
      event_id: event.id,
      event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      resource_id: "8AELMXH8UB2P8",
      raw: delivery.body,
      purge_seconds: 47 * 3600,
    });
    expect(lastLog()).toMatchObject({ outcome: "stored", status: 200, transmission_id: delivery.transmissionId });
  });

  it("is checked in the app: PayPal's API is never called, and one certificate download serves many deliveries", async () => {
    for (let n = 0; n < 3; n += 1) {
      const delivery = signedDelivery(payoutItemEvent());
      expect((await handleDelivery(delivery.body, delivery.headers)).status).toBe(200);
    }
    expect(network.certFetches).toBe(1);
    expect(network.otherRequests).toEqual([]);
    expect(await rowCount()).toBe(3);
  });

  it("is verified on its exact bytes, so odd formatting PayPal signed still passes", async () => {
    const body = `{\n  "id" : "WH-FMT-${randomUUID()}",\t"event_type":"PAYMENT.PAYOUTSBATCH.SUCCESS",\n  "summary":"caf\\u00e9 é 1.0e2",\n  "resource":{"batch_header":{"payout_batch_id":"DF6DLUL2WXLZ6"}}\n}`;
    const delivery = signedDelivery(body);
    expect((await handleDelivery(delivery.body, delivery.headers)).status).toBe(200);
    const { rows } = await admin.query("select raw, resource_id from paypal_events");
    expect(rows[0]).toEqual({ raw: body, resource_id: "DF6DLUL2WXLZ6" });
  });

  it("is refused when the same event is re-serialised, because PayPal signed other bytes", async () => {
    const body = `{ "id": "WH-RS-${randomUUID()}", "event_type": "PAYMENT.PAYOUTS-ITEM.SUCCEEDED" }`;
    const delivery = signedDelivery(body);
    const reserialised = JSON.stringify(JSON.parse(body));
    const result = await handleDelivery(reserialised, delivery.headers);
    expect(result.status).toBe(400);
    expect(lastLog()).toMatchObject({ reason: "verify_failure", check: "signature" });
    expect(await rowCount()).toBe(0);
  });

  it("must be signed over our configured webhook id, never one the request names", async () => {
    const event = payoutItemEvent({ webhook_id: "ATTACKERWEBHOOK" });
    const theirs = signedDelivery(event, { webhookId: "ATTACKERWEBHOOK" });
    theirs.headers.set("paypal-webhook-id", "ATTACKERWEBHOOK");
    expect((await handleDelivery(theirs.body, theirs.headers)).status).toBe(400);
    expect(lastLog()).toMatchObject({ reason: "verify_failure", check: "signature" });
    const ours = signedDelivery(event);
    expect((await handleDelivery(ours.body, ours.headers)).status).toBe(200);
  });
});

describe("replays", () => {
  it("an identical delivery returns 200 and stores nothing new", async () => {
    const delivery = signedDelivery(payoutItemEvent());
    expect((await handleDelivery(delivery.body, delivery.headers)).status).toBe(200);
    const replay = await handleDelivery(delivery.body, delivery.headers);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatch(GENERIC_BODY);
    expect(await rowCount()).toBe(1);
    expect(lastLog()).toMatchObject({ outcome: "duplicate" });
  });

  it("a stored transmission id is answered 200 without a signature check or a write, whatever the body says", async () => {
    const delivery = signedDelivery(payoutItemEvent());
    expect((await handleDelivery(delivery.body, delivery.headers)).status).toBe(200);
    const { rows: before } = await admin.query("select * from paypal_events");
    for (const body of [delivery.body, JSON.stringify(payoutItemEvent())]) {
      const replay = await handleDelivery(body, delivery.headers);
      expect(replay.status).toBe(200);
      expect(lastLog()).toMatchObject({ outcome: "duplicate", reason: "transmission_stored", transmission_id: delivery.transmissionId });
    }
    expect((await admin.query("select * from paypal_events")).rows).toEqual(before);
  });

  it("answers an altered copy as the live forgery check expects: 400 verify_failure under a fresh id, 200 under the stored one", async () => {
    const delivery = signedDelivery(payoutItemEvent());
    expect((await handleDelivery(delivery.body, delivery.headers)).status).toBe(200);
    const altered = delivery.body.replace('"SUCCESS"', '"SUCCESX"');
    const fresh = new Headers(delivery.headers);
    fresh.set("paypal-transmission-id", randomUUID());
    expect((await handleDelivery(altered, fresh)).status).toBe(400);
    expect(lastLog()).toMatchObject({ outcome: "refused", reason: "verify_failure" });
    expect((await handleDelivery(altered, delivery.headers)).status).toBe(200);
    expect(await rowCount()).toBe(1);
  });

  it("the same event under a new transmission id stores nothing new", async () => {
    const event = payoutItemEvent();
    const firstDelivery = signedDelivery(event);
    const resend = signedDelivery(event);
    expect((await handleDelivery(firstDelivery.body, firstDelivery.headers)).status).toBe(200);
    expect((await handleDelivery(resend.body, resend.headers)).status).toBe(200);
    expect(await rowCount()).toBe(1);
  });

  it("a stored delivery deleted by the purge and replayed 50 hours later inserts nothing, because the engine's outcome remembers its id (the auditors' repro)", async () => {
    const delivery = signedDelivery(payoutItemEvent(), { sentAt: Date.now() - 50 * 60 * 60 * 1000 });
    expect((await handleDelivery(delivery.body, delivery.headers)).status).toBe(200);
    await admin.query("insert into event_outcomes (transmission_id, outcome, detail) values ($1, 'status recorded', '{}')", [delivery.transmissionId]);
    await admin.query("delete from paypal_events");
    asked.mockClear();
    const replay = await POST(routeRequest(delivery.body, delivery.headers, "198.51.100.8"));
    expect(replay.status).toBe(200);
    expect(lastLog()).toMatchObject({ outcome: "duplicate", reason: "transmission_stored", transmission_id: delivery.transmissionId });
    expect(await rowCount()).toBe(0);
    expect(asked).not.toHaveBeenCalled();
  });
});

describe("the bytes that are verified", () => {
  it("must be strict UTF-8: an invalid byte gets 400 not_utf8 before any download, even when the signature matches its lenient decoding", async () => {
    const bytes = Buffer.concat([
      Buffer.from(`{"id":"WH-${randomUUID()}","event_type":"PAYMENT.PAYOUTS-ITEM.SUCCEEDED","summary":"caf`, "utf8"),
      Buffer.from([0xff]),
      Buffer.from('"}', "utf8"),
    ]);
    const { headers } = signedHeaders(Buffer.from(new TextDecoder().decode(bytes), "utf8"));
    const response = await POST(routeRequest(bytes, headers, "198.51.100.8"));
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(GENERIC_BODY);
    expect(lastLog()).toMatchObject({ outcome: "refused", reason: "not_utf8" });
    expect(network.certFetches).toBe(0);
    expect(await rowCount()).toBe(0);
  });

  it("are the raw bytes received: a byte-order mark put in front of a signed body is refused, and the body as signed is stored", async () => {
    const delivery = signedDelivery(payoutItemEvent());
    const marked = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(delivery.body, "utf8")]);
    expect((await POST(routeRequest(marked, delivery.headers, "198.51.100.8"))).status).toBe(400);
    expect(await rowCount()).toBe(0);
    expect((await POST(routeRequest(delivery.body, delivery.headers, "198.51.100.8"))).status).toBe(200);
    const { rows } = await admin.query("select raw from paypal_events");
    expect(rows).toEqual([{ raw: delivery.body }]);
  });
});

describe("refusals before the signature is checked", () => {
  async function expectRefused(body: string, headers: Headers, status: number, reason: string): Promise<void> {
    const result = await handleDelivery(body, headers);
    expect(result.status).toBe(status);
    expect(result.body).toMatch(GENERIC_BODY);
    expect(lastLog()).toMatchObject({ outcome: "refused", reason });
    expect(network.certFetches).toBe(0);
    expect(await rowCount()).toBe(0);
  }

  it("a body over 262,144 bytes gets 413", async () => {
    const delivery = signedDelivery(payoutItemEvent({ padding: "x".repeat(300 * 1024) }));
    await expectRefused(delivery.body, delivery.headers, 413, "oversize");
  });

  it("counts bytes, not characters", async () => {
    const event = payoutItemEvent();
    const base = JSON.stringify({ ...event, padding: "" });
    const characters = Math.floor((MAX_BODY_BYTES - Buffer.byteLength(base)) / 3) + 1;
    const delivery = signedDelivery({ ...event, padding: "€".repeat(characters) });
    expect(delivery.body.length).toBeLessThan(MAX_BODY_BYTES);
    await expectRefused(delivery.body, delivery.headers, 413, "oversize");
  });

  it("a body of exactly 262,144 bytes is accepted", async () => {
    const event = payoutItemEvent();
    const base = JSON.stringify({ ...event, padding: "" });
    const delivery = signedDelivery({ ...event, padding: "x".repeat(MAX_BODY_BYTES - Buffer.byteLength(base)) });
    expect(Buffer.byteLength(delivery.body)).toBe(MAX_BODY_BYTES);
    expect((await handleDelivery(delivery.body, delivery.headers)).status).toBe(200);
  });

  it.each([
    "paypal-auth-algo",
    "paypal-cert-url",
    "paypal-transmission-id",
    "paypal-transmission-sig",
    "paypal-transmission-time",
  ])("a missing %s header gets 400", async (name) => {
    const delivery = signedDelivery(payoutItemEvent());
    delivery.headers.delete(name);
    await expectRefused(delivery.body, delivery.headers, 400, "missing_header");
  });

  it.each([
    ["paypal-transmission-id", "a".repeat(51)],
    ["paypal-transmission-sig", "s".repeat(701)],
    ["paypal-auth-algo", "SHA256-withRSA"],
    ["paypal-cert-url", "https://evil.example/cert with space"],
  ])("a malformed %s header gets 400", async (name, value) => {
    const delivery = signedDelivery(payoutItemEvent());
    delivery.headers.set(name, value);
    await expectRefused(delivery.body, delivery.headers, 400, "missing_header");
  });

  it("a header sent twice gets 400", async () => {
    const delivery = signedDelivery(payoutItemEvent());
    delivery.headers.append("paypal-transmission-id", randomUUID());
    await expectRefused(delivery.body, delivery.headers, 400, "missing_header");
  });

  it("leaves room in the signature header for a 4096-bit key's 684 characters", async () => {
    const delivery = signedDelivery(payoutItemEvent());
    delivery.headers.set("paypal-transmission-sig", "A".repeat(684));
    expect((await handleDelivery(delivery.body, delivery.headers)).status).toBe(400);
    expect(lastLog()).toMatchObject({ outcome: "refused", reason: "verify_failure", check: "signature" });
  });

  it.each([
    ["paypal-auth-algo", "SHA1withRSA", "auth_algo"],
    ["paypal-cert-url", "https://evil.example/v1/notifications/certs/CERT-1", "cert_url"],
    ["paypal-cert-url", "https://api.sandbox.paypal.com:8443/v1/notifications/certs/CERT-1", "cert_url"],
    ["paypal-cert-url", "https://api.sandbox.paypal.com/v1/oauth2/token", "cert_url"],
  ])("a %s of %s gets 400 before any query or download", async (name, value, check) => {
    const delivery = signedDelivery(payoutItemEvent());
    delivery.headers.set(name, value);
    // The first rejection writes this reason's audit row for the address; the next is free.
    expect((await handleDelivery(delivery.body, delivery.headers)).status).toBe(400);
    const calls = await databaseCalls(async () => {
      expect((await handleDelivery(delivery.body, delivery.headers)).status).toBe(400);
    });
    expect(calls).toBe(0);
    expect(lastLog()).toMatchObject({ outcome: "refused", reason: "verify_failure", check });
    expect(network.certFetches).toBe(0);
    expect(await rowCount()).toBe(0);
  });

  it.each([
    ['{"id":"WH-1","event_type":"PAYMENT.PAYOUTS-ITEM.SUCCEEDED","id":"WH-2"}', "at the top"],
    ['{"id":"WH-1","event_type":"PAYMENT.PAYOUTS-ITEM.SUCCEEDED","resource":{"payout_item_id":"A","payout_item_id":"B"}}', "inside the resource"],
    ['{"id":"WH-1","\\u0065vent_type":"X","event_type":"PAYMENT.PAYOUTS-ITEM.SUCCEEDED"}', "with one copy escaped"],
  ])("duplicate keys %s (%s) get 400", async (body) => {
    const delivery = signedDelivery(body);
    await expectRefused(delivery.body, delivery.headers, 400, "duplicate_key");
  });

  it.each([
    ["not json", "syntax"],
    ["[1,2,3]", "not_an_event"],
    ['{"event_type":"PAYMENT.PAYOUTS-ITEM.SUCCEEDED"}', "not_an_event"],
    ['{"id":"WH 1","event_type":"PAYMENT.PAYOUTS-ITEM.SUCCEEDED"}', "not_an_event"],
    ['{"id":"WH-1","event_type":"<script>"}', "not_an_event"],
    ["[".repeat(80), "too_deep"],
  ])("body %j gets 400 (%s)", async (body, reason) => {
    const delivery = signedDelivery(body);
    await expectRefused(delivery.body, delivery.headers, 400, reason);
  });

  it.each([
    ["6 minutes ahead", 6 * 60_000, "future_time"],
    ["3 days and 1 minute old", -(3 * 24 * 60 + 1) * 60_000, "stale_time"],
  ])("a transmission time %s gets 400", async (_label, offset, reason) => {
    const delivery = signedDelivery(payoutItemEvent(), { sentAt: Date.now() + offset });
    await expectRefused(delivery.body, delivery.headers, 400, reason);
  });

  it.each(["2026-02-30T00:00:00Z", "2026-10-20T24:00:00Z", "2026-10-20t12:00:00z", "1792497600", "2026-10-20T12:00:00"])(
    "a transmission time of %s gets 400",
    async (value) => {
      const delivery = signedDelivery(payoutItemEvent());
      delivery.headers.set("paypal-transmission-time", value);
      await expectRefused(delivery.body, delivery.headers, 400, "bad_time");
    },
  );

  it.each([
    ["4 minutes ahead", 4 * 60_000],
    ["2 days 23 hours old", -(71 * 60) * 60_000],
  ])("a transmission time %s is inside the window", async (_label, offset) => {
    const delivery = signedDelivery(payoutItemEvent(), { sentAt: Date.now() + offset });
    expect((await handleDelivery(delivery.body, delivery.headers)).status).toBe(200);
  });
});

describe("the signature check", () => {
  it("refuses a signature no trusted certificate made with 400, storing nothing", async () => {
    const delivery = signedDelivery(payoutItemEvent(), { forged: true });
    const result = await handleDelivery(delivery.body, delivery.headers);
    expect(result.status).toBe(400);
    expect(lastLog()).toMatchObject({ outcome: "refused", reason: "verify_failure", check: "signature" });
    expect(await rowCount()).toBe(0);
  });

  it("refuses an altered body with the original headers with 400, storing nothing", async () => {
    const delivery = signedDelivery(payoutItemEvent());
    const altered = delivery.body.replace('"SUCCESS"', '"SUCCESX"');
    expect(altered).not.toBe(delivery.body);
    expect((await handleDelivery(altered, delivery.headers)).status).toBe(400);
    expect(await rowCount()).toBe(0);
  });

  it("refuses a certificate that does not chain to a trusted root with 400", async () => {
    signing.checker = trusting([chain.stranger.pem]);
    const delivery = signedDelivery(payoutItemEvent());
    expect((await handleDelivery(delivery.body, delivery.headers)).status).toBe(400);
    expect(lastLog()).toMatchObject({ reason: "verify_failure", check: "cert_chain" });
    expect(await rowCount()).toBe(0);
  });

  it.each([
    ["a certificate address that answers an error", () => new Response("down", { status: 503 }), "cert_fetch"],
    ["a certificate download that fails", () => Promise.reject(new TypeError("fetch failed")), "cert_fetch"],
    ["a certificate address that serves something else", () => new Response("<html>gateway</html>"), "cert_chain"],
  ])("answers %s with 400 and no call to PayPal's API, storing nothing", async (_label, answer, check) => {
    network.certificate = answer;
    const delivery = signedDelivery(payoutItemEvent());
    const result = await handleDelivery(delivery.body, delivery.headers);
    expect(result.status).toBe(400);
    expect(result.body).toMatch(/^refused \(ref [0-9a-f-]{36}\)$/);
    expect(lastLog()).toMatchObject({ outcome: "refused", reason: "verify_failure", check });
    expect(await rowCount()).toBe(0);
  });
});

describe("the certificate download budget", () => {
  // A delivery from address under a certificate address the test network answers 404.
  function underNewCertificate(certUrl: string, address: string, options: DeliveryOptions = {}): Promise<Response> {
    const delivery = signedDelivery(payoutItemEvent(), options);
    delivery.headers.set("paypal-cert-url", certUrl);
    return POST(routeRequest(delivery.body, delivery.headers, address));
  }

  // Ten first-time certificate addresses from ten senders, which fills the process's 10 a minute.
  async function fillTheCap(label: string): Promise<void> {
    for (let index = 0; index < 10; index += 1) {
      expect((await underNewCertificate(`${CERT_URL}-${label}-${index}`, `203.0.113.${20 + index}`)).status).toBe(400);
      expect(lastLog()).toMatchObject({ check: "cert_fetch" });
    }
    expect((await underNewCertificate(`${CERT_URL}-${label}-10`, "203.0.113.40")).status).toBe(400);
    expect(lastLog()).toMatchObject({ reason: "certificate_budget" });
  }

  it("refuses a third new certificate address from one client address this minute, with 400, reason certificate_budget and its own audit row, while another address still downloads", async () => {
    const before = await lastAuditId();
    for (let index = 0; index < 2; index += 1) expect((await underNewCertificate(`${CERT_URL}-new-${index}`, "198.51.100.70")).status).toBe(400);
    expect(lastLog()).toMatchObject({ outcome: "refused", reason: "verify_failure", check: "cert_fetch" });
    const refused = await underNewCertificate(`${CERT_URL}-new-2`, "198.51.100.70");
    expect(refused.status).toBe(400);
    expect(await refused.text()).toMatch(/^refused \(ref [0-9a-f-]{36}\)$/);
    expect(lastLog()).toMatchObject({ outcome: "refused", reason: "certificate_budget", check: "certificate_budget" });
    expect(network.certFetches).toBe(2);
    expect((await underNewCertificate(`${CERT_URL}-new-3`, "198.51.100.71")).status).toBe(400);
    expect(lastLog()).toMatchObject({ check: "cert_fetch" });
    expect(network.certFetches).toBe(3);
    const row = (reason: string, address: string) => ({ actor: "web", action: "webhook_rejected", detail: { reason, status: 400, address_tag: addressTag(address) } });
    expect(await auditSince(before)).toEqual([row("verify_failure", "198.51.100.70"), row("certificate_budget", "198.51.100.70"), row("verify_failure", "198.51.100.71")]);
    expect(await rowCount()).toBe(0);
  });

  it("answers a genuine delivery 200 after 10 forged ones from one address named PayPal's certificate with a query (the reviewer's round 3 repro)", async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await underNewCertificate(`${CERT_URL}?n=${i}`, "203.0.113.9", { forged: true })).status).toBe(400);
    }
    const genuine = signedDelivery(payoutItemEvent());
    expect((await POST(routeRequest(genuine.body, genuine.headers, "198.51.100.8"))).status).toBe(200);
    expect(await rowCount()).toBe(1);
    expect(network.certFetches).toBe(1);
    expect(logs().filter((entry) => entry.check === "cert_url")).toHaveLength(10);
    expect(await rememberedCerts()).toEqual([CERT_URL]);
  });

  it("answers a genuine delivery 200 after 10 forged ones from one address under 10 new certificate addresses, of which it downloaded 2", async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await underNewCertificate(`${CERT_URL}-forged-${i}`, "203.0.113.9", { forged: true })).status).toBe(400);
    }
    const genuine = signedDelivery(payoutItemEvent());
    expect((await POST(routeRequest(genuine.body, genuine.headers, "198.51.100.8"))).status).toBe(200);
    expect(await rowCount()).toBe(1);
    expect(network.certFetches).toBe(3);
    expect(await rememberedCerts()).toEqual([CERT_URL]);
  });

  it("remembers PayPal's certificate across a restart: a fresh checker over the same database verifies it after 10 first-time addresses from 10 senders filled the cap", async () => {
    const first = signedDelivery(payoutItemEvent());
    expect((await POST(routeRequest(first.body, first.headers, "198.51.100.8"))).status).toBe(200);
    expect(await rememberedCerts()).toEqual([CERT_URL]);
    signing.checker = trusting();
    await fillTheCap("first");
    const fetched = network.certFetches;
    const genuine = signedDelivery(payoutItemEvent());
    expect((await POST(routeRequest(genuine.body, genuine.headers, "198.51.100.8"))).status).toBe(200);
    expect(network.certFetches).toBe(fetched + 1);
    expect(await rowCount()).toBe(2);
  });

  it("forgets a certificate address last verified more than 400 days ago", async () => {
    await admin.query("insert into paypal_certs (url, last_verified_at) values ($1, now() - interval '401 days')", [CERT_URL]);
    await fillTheCap("stale");
    const stale = signedDelivery(payoutItemEvent());
    expect((await POST(routeRequest(stale.body, stale.headers, "198.51.100.8"))).status).toBe(400);
    expect(lastLog()).toMatchObject({ reason: "certificate_budget" });

    await admin.query("update paypal_certs set last_verified_at = now() - interval '399 days'");
    signing.checker = trusting();
    await fillTheCap("recent");
    const recent = signedDelivery(payoutItemEvent());
    expect((await POST(routeRequest(recent.body, recent.headers, "198.51.100.8"))).status).toBe(200);
  });

  it("records the time each certificate address last verified a delivery, in one row, and answers the same when the table cannot be read or written", async () => {
    await admin.query("insert into paypal_certs (url, last_verified_at) values ($1, now() - interval '10 days')", [CERT_URL]);
    const delivery = signedDelivery(payoutItemEvent());
    expect((await handleDelivery(delivery.body, delivery.headers)).status).toBe(200);
    const { rows } = await admin.query("select url, last_verified_at > now() - interval '1 minute' as fresh from paypal_certs");
    expect(rows).toEqual([{ url: CERT_URL, fresh: true }]);

    signing.checker = trusting();
    await admin.query("alter table paypal_certs rename to paypal_certs_away");
    try {
      const unrecorded = signedDelivery(payoutItemEvent());
      expect((await handleDelivery(unrecorded.body, unrecorded.headers)).status).toBe(200);
    } finally {
      await admin.query("alter table paypal_certs_away rename to paypal_certs");
    }
    expect(logs().filter((entry) => entry.outcome === "certs_not_recalled" || entry.outcome === "cert_not_recorded")).toEqual([
      expect.objectContaining({ kind: "webhook", outcome: "certs_not_recalled", code: "42P01" }),
      expect.objectContaining({ kind: "webhook", outcome: "cert_not_recorded", code: "42P01" }),
    ]);
    expect(await rowCount()).toBe(2);
  });
});

describe("storage", () => {
  it("a missing table gets 503 and the delivery can be retried later", async () => {
    await admin.query("alter table paypal_events rename to paypal_events_away");
    const delivery = signedDelivery(payoutItemEvent());
    try {
      const result = await handleDelivery(delivery.body, delivery.headers);
      expect(result.status).toBe(503);
      expect(lastLog()).toMatchObject({ outcome: "unavailable", reason: "db_error", code: "42P01" });
    } finally {
      await admin.query("alter table paypal_events_away rename to paypal_events");
    }
    expect((await handleDelivery(delivery.body, delivery.headers)).status).toBe(200);
    expect(await rowCount()).toBe(1);
  });

  it("stores hostile text as data and leaves the table and prototypes alone", async () => {
    const event = payoutItemEvent({
      id: "WH-x');drop_table_paypal_events;--",
      resource: { id: "'; drop table paypal_events;--" },
    });
    const body = JSON.stringify(event).replace('"resource":{"id"', '"resource":{"__proto__":{"polluted":true},"id"');
    const delivery = signedDelivery(body);
    expect((await handleDelivery(delivery.body, delivery.headers)).status).toBe(200);
    const { rows } = await admin.query("select event_id, resource_id, raw from paypal_events");
    expect(rows).toEqual([{ event_id: "WH-x');drop_table_paypal_events;--", resource_id: null, raw: body }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("asking the engine to process events", () => {
  it("a stored delivery asks the engine once for process_events, and the answer does not wait for it", async () => {
    asked.mockReturnValue(new Promise<string>(() => {}));
    const delivery = signedDelivery(payoutItemEvent());
    expect((await handleDelivery(delivery.body, delivery.headers)).status).toBe(200);
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    expect(asked).toHaveBeenCalledWith("process_events", [], { address: "unknown" });
  });

  it("a replay, a refusal or a 503 asks nothing", async () => {
    const delivery = signedDelivery(payoutItemEvent());
    await handleDelivery(delivery.body, delivery.headers);
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    expect((await handleDelivery(delivery.body, delivery.headers)).status).toBe(200);
    const forged = signedDelivery(payoutItemEvent(), { forged: true });
    expect((await handleDelivery(forged.body, forged.headers)).status).toBe(400);
    await admin.query("alter table paypal_events rename to paypal_events_away");
    try {
      const unstored = signedDelivery(payoutItemEvent());
      expect((await handleDelivery(unstored.body, unstored.headers)).status).toBe(503);
    } finally {
      await admin.query("alter table paypal_events_away rename to paypal_events");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["refuses to start", () => Promise.reject(new Error("MEND_ENGINE_URL must be the engine's private network address"))],
    ["throws at once", () => {
      throw new Error("engine client broke");
    }],
  ])("an engine client that %s leaves the 200 as it was and is logged under the delivery's ref", async (_label, behaviour) => {
    asked.mockImplementation(behaviour as typeof runTask);
    const delivery = signedDelivery(payoutItemEvent());
    const result = await handleDelivery(delivery.body, delivery.headers);
    expect(result.status).toBe(200);
    const ref = /\(ref ([0-9a-f-]{36})\)$/.exec(result.body)?.[1];
    await vi.waitFor(() => expect(logs().some((entry) => entry.outcome === "engine_not_asked")).toBe(true));
    expect(logs().find((entry) => entry.outcome === "stored")).toMatchObject({ ref, status: 200 });
    expect(logs().find((entry) => entry.outcome === "engine_not_asked")).toMatchObject({ kind: "webhook", ref });
    expect(await rowCount()).toBe(1);
  });
});

describe("what a flood can spend", () => {
  const JSON_ONLY = new Headers({ "content-type": "application/json" });

  it("answers 60 forged deliveries from one address 400, then a genuine one from another address 200 (the reviewer's repro)", async () => {
    for (let n = 0; n < 60; n += 1) {
      const forged = signedDelivery(payoutItemEvent(), { forged: true });
      expect((await POST(routeRequest(forged.body, forged.headers, "203.0.113.9"))).status).toBe(400);
    }
    const genuine = signedDelivery(payoutItemEvent());
    expect((await POST(routeRequest(genuine.body, genuine.headers, "198.51.100.8"))).status).toBe(200);
    expect(await rowCount()).toBe(1);
    expect(network.certFetches).toBe(1);
  });

  it("answers junk from an address past 120 rejections a minute 429 with no query and no body read, and still stores a genuine delivery from it", async () => {
    const before = await lastAuditId();
    for (let n = 0; n < 120; n += 1) {
      expect((await POST(routeRequest("{}", JSON_ONLY, "198.51.100.7"))).status).toBe(400);
    }
    const junk = routeRequest("{}", JSON_ONLY, "198.51.100.7");
    const refused = await POST(junk);
    expect(refused.status).toBe(429);
    expect(await refused.text()).toMatch(GENERIC_BODY);
    const wait = Number(refused.headers.get("retry-after"));
    expect(wait > 0 && wait <= 60).toBe(true);
    expect(junk.bodyUsed).toBe(false);
    expect(lastLog()).toMatchObject({ outcome: "refused", reason: "rate_limited", bucket: "webhook_address", rejected: "missing_header" });

    const genuine = signedDelivery(payoutItemEvent());
    expect((await POST(routeRequest(genuine.body, genuine.headers, "198.51.100.7"))).status).toBe(200);
    expect(await rowCount()).toBe(1);

    const forged = signedDelivery(payoutItemEvent(), { forged: true });
    const calls = await databaseCalls(async () => {
      for (let n = 0; n < 10; n += 1) expect((await POST(routeRequest("{}", JSON_ONLY, "198.51.100.7"))).status).toBe(429);
      expect((await POST(routeRequest(forged.body, forged.headers, "198.51.100.7"))).status).toBe(429);
    });
    expect(calls).toBe(0);
    expect(lastLog()).toMatchObject({ outcome: "refused", reason: "rate_limited", rejected: "verify_failure" });
    expect(network.certFetches).toBe(1);
    expect(await auditSince(before)).toEqual([
      { actor: "web", action: "webhook_rejected", detail: { reason: "missing_header", status: 400, address_tag: addressTag("198.51.100.7") } },
      { actor: "web", action: "rate_limit_hit", detail: { bucket: "webhook_address", per: "address", address_tag: addressTag("198.51.100.7") } },
    ]);
  });

  it("never charges a delivery that verifies: 130 genuine deliveries from one address in a minute are all stored", async () => {
    for (let n = 0; n < 130; n += 1) {
      const genuine = signedDelivery(payoutItemEvent());
      expect((await POST(routeRequest(genuine.body, genuine.headers, "198.51.100.9"))).status, `delivery ${n}`).toBe(200);
    }
    expect(await rowCount()).toBe(130);
    expect(webhookLimits.full("198.51.100.9")).toBeNull();
  });

  it("counts and refuses with the database's rate-limit table gone, because the counts live in memory", async () => {
    await admin.query("alter table rate_limit_hits rename to rate_limit_hits_away");
    try {
      for (let n = 0; n < 120; n += 1) expect((await POST(routeRequest("{}", JSON_ONLY, "198.51.100.9"))).status).toBe(400);
      expect((await POST(routeRequest("{}", JSON_ONLY, "198.51.100.9"))).status).toBe(429);
      const genuine = signedDelivery(payoutItemEvent());
      expect((await POST(routeRequest(genuine.body, genuine.headers, "198.51.100.10"))).status).toBe(200);
    } finally {
      await admin.query("alter table rate_limit_hits_away rename to rate_limit_hits");
    }
  });

  it("answers junk from every address 429 once 600 rejections came in within a minute, and still stores a genuine delivery", async () => {
    for (let n = 0; n < 600; n += 1) webhookLimits.take(`10.0.${Math.floor(n / 200)}.${n % 200}`);
    const junk = await POST(routeRequest("{}", JSON_ONLY, "203.0.113.9"));
    expect(junk.status).toBe(429);
    expect(lastLog()).toMatchObject({ outcome: "refused", reason: "rate_limited", bucket: "webhook_all" });
    expect(network.certFetches).toBe(0);
    const genuine = signedDelivery(payoutItemEvent());
    expect((await POST(routeRequest(genuine.body, genuine.headers, "203.0.113.9"))).status).toBe(200);
    expect(await rowCount()).toBe(1);
  });

  it("reads a body sent without Content-Length only up to the cap, then answers 413", async () => {
    const { stream, meter } = meteredBody(Buffer.alloc(300 * 1024, "x"));
    const request = routeRequest(stream, JSON_ONLY, "198.51.100.7");
    expect(request.headers.get("content-length")).toBeNull();
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(await response.text()).toMatch(GENERIC_BODY);
    expect(meter.given).toBeLessThanOrEqual(MAX_BODY_BYTES + CHUNK_BYTES);
    expect(meter.cancelled).toBe(true);
    expect(lastLog()).toMatchObject({ outcome: "refused", reason: "oversize_stream" });
    expect(network.certFetches).toBe(0);
  });

  it("reads a streamed body of exactly the cap whole, so the bytes PayPal signed are the bytes stored", async () => {
    const event = payoutItemEvent();
    const room = MAX_BODY_BYTES - Buffer.byteLength(JSON.stringify({ ...event, padding: "" }));
    // Three-byte characters, so chunk edges fall inside a character.
    const delivery = signedDelivery({ ...event, padding: "€".repeat(Math.floor(room / 3)) + "x".repeat(room % 3) });
    expect(Buffer.byteLength(delivery.body)).toBe(MAX_BODY_BYTES);
    const { stream, meter } = meteredBody(Buffer.from(delivery.body, "utf8"));
    expect((await POST(routeRequest(stream, delivery.headers, "198.51.100.7"))).status).toBe(200);
    expect(meter.given).toBe(MAX_BODY_BYTES);
    const { rows } = await admin.query("select raw from paypal_events");
    expect(rows).toEqual([{ raw: delivery.body }]);
  });
});

describe("verifyDelivery", () => {
  it("says verified for a genuine delivery and rejected for a forged one", async () => {
    const delivery = signedDelivery(payoutItemEvent());
    expect(await verifyDelivery(delivery.body, delivery.headers)).toBe("verified");
    expect(await verifyDelivery(`${delivery.body} `, delivery.headers)).toBe("rejected");
  });

  it("rejects without any download when a header is missing or the body has duplicate keys", async () => {
    const delivery = signedDelivery(payoutItemEvent());
    const headers = new Headers(delivery.headers);
    headers.delete("paypal-transmission-sig");
    expect(await verifyDelivery(delivery.body, headers)).toBe("rejected");
    expect(await verifyDelivery('{"id":"a","id":"b","event_type":"X"}', delivery.headers)).toBe("rejected");
    expect(network.certFetches).toBe(0);
  });

  it("says rejected, without throwing, when the certificate cannot be downloaded", async () => {
    network.certificate = () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const delivery = signedDelivery(payoutItemEvent());
    expect(await verifyDelivery(delivery.body, delivery.headers)).toBe("rejected");
  });
});

describe("refuseDeclaredLength", () => {
  it("refuses a declared length over the cap and passes everything else", async () => {
    expect((await refuseDeclaredLength(new Headers({ "content-length": String(300 * 1024) })))?.status).toBe(413);
    expect(await refuseDeclaredLength(new Headers({ "content-length": String(MAX_BODY_BYTES) }))).toBeNull();
    expect(await refuseDeclaredLength(new Headers())).toBeNull();
  });
});

describe("rejections on the audit record", () => {
  const JSON_ONLY = new Headers({ "content-type": "application/json" });

  it("records the first rejection per reason per address each minute, and the address tag in every log line", async () => {
    const before = await lastAuditId();
    for (let n = 0; n < 3; n += 1) expect((await POST(routeRequest("{}", JSON_ONLY, "198.51.100.60"))).status).toBe(400);
    expect(lastLog()).toMatchObject({ outcome: "refused", reason: "missing_header", address_tag: addressTag("198.51.100.60") });
    const garbled = signedDelivery("not json");
    expect((await POST(routeRequest(garbled.body, garbled.headers, "198.51.100.60"))).status).toBe(400);
    expect((await POST(routeRequest("{}", JSON_ONLY, "198.51.100.61"))).status).toBe(400);
    const genuine = signedDelivery(payoutItemEvent());
    expect((await POST(routeRequest(genuine.body, genuine.headers, "198.51.100.61"))).status).toBe(200);
    expect(lastLog()).toMatchObject({ outcome: "stored", address_tag: addressTag("198.51.100.61") });

    const row = (reason: string, address: string) => ({ actor: "web", action: "webhook_rejected", detail: { reason, status: 400, address_tag: addressTag(address) } });
    expect(await auditSince(before)).toEqual([row("missing_header", "198.51.100.60"), row("syntax", "198.51.100.60"), row("missing_header", "198.51.100.61")]);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      expect((await POST(routeRequest("{}", JSON_ONLY, "198.51.100.60"))).status).toBe(400);
    } finally {
      vi.useRealTimers();
    }
    expect((await auditSince(before)).at(-1)).toEqual(row("missing_header", "198.51.100.60"));
    expect(await auditSince(before)).toHaveLength(4);
  });

  it("writes at most 20 rejection rows per reason a minute across every address, then one audit_rows_suppressed row holding the count", async () => {
    const before = await lastAuditId();
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(start);
      for (let n = 0; n < 25; n += 1) expect((await POST(routeRequest("{}", JSON_ONLY, `198.51.100.${150 + n}`))).status).toBe(400);
      vi.setSystemTime(start + 61_000);
      await writeSuppressedAudit();
    } finally {
      vi.useRealTimers();
    }
    const rows = await auditSince(before);
    expect(rows.filter((row) => row.action === "webhook_rejected")).toHaveLength(20);
    expect(rows.filter((row) => row.action === "audit_rows_suppressed")).toEqual([
      { actor: "web", action: "audit_rows_suppressed", detail: { action: "webhook_rejected", reason: "missing_header", suppressed: 5 } },
    ]);
  });

  it("decides in memory: with the database's rate-limit table gone, three rejections from one address leave one row", async () => {
    const before = await lastAuditId();
    await admin.query("alter table rate_limit_hits rename to rate_limit_hits_away");
    try {
      for (let n = 0; n < 3; n += 1) expect((await POST(routeRequest("{}", JSON_ONLY, "198.51.100.63"))).status).toBe(400);
    } finally {
      await admin.query("alter table rate_limit_hits_away rename to rate_limit_hits");
    }
    expect(await auditSince(before)).toEqual([
      { actor: "web", action: "webhook_rejected", detail: { reason: "missing_header", status: 400, address_tag: addressTag("198.51.100.63") } },
    ]);
  });

  it("answers a rejection the same when its audit row cannot be written, with one log line saying so", async () => {
    await admin.query("alter table audit_log rename to audit_log_away");
    try {
      expect((await POST(routeRequest("{}", JSON_ONLY, "198.51.100.62"))).status).toBe(400);
    } finally {
      await admin.query("alter table audit_log_away rename to audit_log");
    }
    expect(logs().filter((entry) => entry.kind === "audit")).toEqual([
      expect.objectContaining({ outcome: "not_written", action: "webhook_rejected", reason: "db_error" }),
    ]);
    expect(logs().filter((entry) => entry.kind === "webhook").at(-1)).toMatchObject({ status: 400, reason: "missing_header" });
  });
});

describe("parseTransmissionTime", () => {
  it("reads Z and numeric offsets to the same instant", () => {
    expect(parseTransmissionTime("2026-10-20T12:00:00Z")).toBe(Date.UTC(2026, 9, 20, 12));
    expect(parseTransmissionTime("2026-10-20T17:30:00+05:30")).toBe(Date.UTC(2026, 9, 20, 12));
    expect(parseTransmissionTime("2026-10-20T12:00:00.250Z")).toBe(Date.UTC(2026, 9, 20, 12, 0, 0, 250));
    expect(parseTransmissionTime("2026-10-20T12:00:00+24:00")).toBeNull();
  });
});
