// Covers handleDelivery and verifyDelivery against a real Postgres schema (the engine's
// schema.sql in a throwaway schema) and a fake PayPal verify endpoint that only says
// SUCCESS for the exact bytes it signed. Does NOT cover: PayPal's real verdicts, real
// signatures or delivery timing (the live proof, npm run prove:m1b, does), the HTTP
// route wrapper, rate limiting (not built yet), or the engine itself: the engine client
// is replaced by a stand-in that records what it was asked (engine.test.ts covers it).
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { holdDevDatabase, SCHEMA_PATH, type DevDatabase } from "../../scripts/dev-database";
import { closeDatabase } from "./db";
import { runTask } from "./engine";
import {
  handleDelivery,
  MAX_BODY_BYTES,
  parseTransmissionTime,
  refuseDeclaredLength,
  VerificationUnavailable,
  verifyDelivery,
} from "./webhooks";

const WEBHOOK_ID = "TESTWEBHOOK1";
const SECRET = "fake-client-secret-for-webhook-tests";
const TOKEN = "A21AAfakeTokenForWebhookTests";
const VERIFY_PATH = "/v1/notifications/verify-webhook-signature";
const CERT_URL = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77";
const GENERIC_BODY = /^(ok|refused|too large|try again later) \(ref [0-9a-f-]{36}\)$/;
const RUN_ID = "brn-6f1c1d3e-2b9a-4f0e-9a51-3c1d2e4f5a6b";

vi.mock("./engine", () => ({ runTask: vi.fn() }));
const asked = vi.mocked(runTask);

type Mode = "honest" | "failure" | "server_error" | "timeout" | "garbage";

const paypal = {
  mode: "honest" as Mode,
  signed: new Map<string, { body: string; certUrl: string }>(),
  verifyRequests: [] as string[],
};

function signatureFor(transmissionId: string, body: string): string {
  return createHash("sha256").update(`${transmissionId}|${body}|${WEBHOOK_ID}`).digest("base64");
}

// Plays PayPal: SUCCESS only when the spliced event text is byte for byte what was
// signed, with the certificate URL it was signed under.
async function fakePayPal(url: URL, init: RequestInit): Promise<Response> {
  if (url.pathname === "/v1/oauth2/token") {
    return Response.json({ access_token: TOKEN, expires_in: 32_400 });
  }
  if (url.pathname !== VERIFY_PATH) return new Response("not found", { status: 404 });
  const raw = String(init.body);
  paypal.verifyRequests.push(raw);
  if (paypal.mode === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  if (paypal.mode === "server_error") {
    return Response.json({ name: "INTERNAL_SERVICE_ERROR", debug_id: "f00dfeed1234" }, { status: 500 });
  }
  if (paypal.mode === "garbage") return new Response("<html>gateway</html>", { status: 200 });
  const request = JSON.parse(raw) as Record<string, string>;
  const marker = ',"webhook_event":';
  const event = raw.slice(raw.indexOf(marker) + marker.length, -1);
  const genuine =
    request.webhook_id === WEBHOOK_ID &&
    paypal.signed.get(request.transmission_id)?.body === event &&
    paypal.signed.get(request.transmission_id)?.certUrl === request.cert_url &&
    request.transmission_sig === signatureFor(request.transmission_id, event);
  return Response.json({ verification_status: genuine && paypal.mode === "honest" ? "SUCCESS" : "FAILURE" });
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

function signedDelivery(event: Record<string, unknown> | string, options: { sentAt?: number; transmissionId?: string } = {}) {
  const body = typeof event === "string" ? event : JSON.stringify(event);
  const transmissionId = options.transmissionId ?? randomUUID();
  paypal.signed.set(transmissionId, { body, certUrl: CERT_URL });
  const headers = new Headers({
    "content-type": "application/json",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": CERT_URL,
    "paypal-transmission-id": transmissionId,
    "paypal-transmission-sig": signatureFor(transmissionId, body),
    "paypal-transmission-time": paypalTime(options.sentAt ?? Date.now()),
  });
  return { body, headers, transmissionId };
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
  vi.stubGlobal("fetch", fakePayPal);
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
  await admin.query("truncate paypal_events");
  paypal.mode = "honest";
  paypal.verifyRequests = [];
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
    expect(everything).not.toContain(TOKEN);
  };
});

describe("a verified delivery", () => {
  it("is stored once with its ids, the exact raw text and a 48 hour purge time", async () => {
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
      purge_seconds: 48 * 3600,
    });
    expect(lastLog()).toMatchObject({ outcome: "stored", status: 200, transmission_id: delivery.transmissionId });
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
    expect(await rowCount()).toBe(0);
  });

  it("sends PayPal our configured webhook id, never one from the request", async () => {
    const delivery = signedDelivery(payoutItemEvent({ webhook_id: "ATTACKERWEBHOOK" }));
    delivery.headers.set("paypal-webhook-id", "ATTACKERWEBHOOK");
    await handleDelivery(delivery.body, delivery.headers);
    const sent = JSON.parse(paypal.verifyRequests[0]) as { webhook_id: string; webhook_event: Record<string, unknown> };
    expect(sent.webhook_id).toBe(WEBHOOK_ID);
    expect(sent.webhook_event.webhook_id).toBe("ATTACKERWEBHOOK");
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

  it("the same event under a new transmission id stores nothing new", async () => {
    const event = payoutItemEvent();
    const firstDelivery = signedDelivery(event);
    const resend = signedDelivery(event);
    expect((await handleDelivery(firstDelivery.body, firstDelivery.headers)).status).toBe(200);
    expect((await handleDelivery(resend.body, resend.headers)).status).toBe(200);
    expect(await rowCount()).toBe(1);
  });
});

describe("refusals before PayPal is asked", () => {
  async function expectRefused(body: string, headers: Headers, status: number, reason: string): Promise<void> {
    const result = await handleDelivery(body, headers);
    expect(result.status).toBe(status);
    expect(result.body).toMatch(GENERIC_BODY);
    expect(lastLog()).toMatchObject({ outcome: "refused", reason });
    expect(paypal.verifyRequests).toHaveLength(0);
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
    ["paypal-transmission-sig", "s".repeat(501)],
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

describe("PayPal's verdict", () => {
  it("FAILURE gets 400 and stores nothing", async () => {
    paypal.mode = "failure";
    const delivery = signedDelivery(payoutItemEvent());
    const result = await handleDelivery(delivery.body, delivery.headers);
    expect(result.status).toBe(400);
    expect(lastLog()).toMatchObject({ outcome: "refused", reason: "verify_failure" });
    expect(await rowCount()).toBe(0);
  });

  it("an altered body with the original headers gets 400 and stores nothing", async () => {
    const delivery = signedDelivery(payoutItemEvent());
    const altered = delivery.body.replace('"SUCCESS"', '"SUCCESX"');
    expect(altered).not.toBe(delivery.body);
    expect((await handleDelivery(altered, delivery.headers)).status).toBe(400);
    expect(await rowCount()).toBe(0);
  });

  it("a cert URL on another host gets 400 and stores nothing", async () => {
    const delivery = signedDelivery(payoutItemEvent());
    delivery.headers.set("paypal-cert-url", "https://evil.example/cert.pem");
    expect((await handleDelivery(delivery.body, delivery.headers)).status).toBe(400);
    expect(await rowCount()).toBe(0);
  });

  it.each([
    ["a verify timeout", "timeout" as const],
    ["a PayPal server error", "server_error" as const],
    ["an answer that is not a verdict", "garbage" as const],
  ])("%s gets 503 and stores nothing, so PayPal retries", async (_label, mode) => {
    paypal.mode = mode;
    const delivery = signedDelivery(payoutItemEvent());
    const result = await handleDelivery(delivery.body, delivery.headers);
    expect(result.status).toBe(503);
    expect(result.body).toMatch(/^try again later \(ref [0-9a-f-]{36}\)$/);
    expect(lastLog()).toMatchObject({ outcome: "unavailable", reason: "verify_error" });
    expect(await rowCount()).toBe(0);
  });

  it("keeps PayPal's debug id in the log and out of the answer", async () => {
    paypal.mode = "server_error";
    const delivery = signedDelivery(payoutItemEvent());
    const result = await handleDelivery(delivery.body, delivery.headers);
    expect(result.body).not.toContain("f00dfeed1234");
    expect(lastLog()).toMatchObject({ debug_id: "f00dfeed1234" });
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
    expect(asked).toHaveBeenCalledWith("process_events", []);
  });

  it("a replay, a refusal or a 503 asks nothing", async () => {
    const delivery = signedDelivery(payoutItemEvent());
    await handleDelivery(delivery.body, delivery.headers);
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    expect((await handleDelivery(delivery.body, delivery.headers)).status).toBe(200);
    paypal.mode = "failure";
    const forged = signedDelivery(payoutItemEvent());
    expect((await handleDelivery(forged.body, forged.headers)).status).toBe(400);
    paypal.mode = "server_error";
    const unverified = signedDelivery(payoutItemEvent());
    expect((await handleDelivery(unverified.body, unverified.headers)).status).toBe(503);
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

describe("verifyDelivery", () => {
  it("says verified for a genuine delivery and rejected for a forged one", async () => {
    const delivery = signedDelivery(payoutItemEvent());
    expect(await verifyDelivery(delivery.body, delivery.headers)).toBe("verified");
    expect(await verifyDelivery(`${delivery.body} `, delivery.headers)).toBe("rejected");
  });

  it("rejects without asking PayPal when a header is missing or the body has duplicate keys", async () => {
    const delivery = signedDelivery(payoutItemEvent());
    const headers = new Headers(delivery.headers);
    headers.delete("paypal-transmission-sig");
    expect(await verifyDelivery(delivery.body, headers)).toBe("rejected");
    expect(await verifyDelivery('{"id":"a","id":"b","event_type":"X"}', delivery.headers)).toBe("rejected");
    expect(paypal.verifyRequests).toHaveLength(0);
  });

  it("throws VerificationUnavailable when PayPal does not answer", async () => {
    paypal.mode = "timeout";
    const delivery = signedDelivery(payoutItemEvent());
    await expect(verifyDelivery(delivery.body, delivery.headers)).rejects.toThrow(VerificationUnavailable);
  });
});

describe("refuseDeclaredLength", () => {
  it("refuses a declared length over the cap and passes everything else", () => {
    expect(refuseDeclaredLength(new Headers({ "content-length": String(300 * 1024) }))?.status).toBe(413);
    expect(refuseDeclaredLength(new Headers({ "content-length": String(MAX_BODY_BYTES) }))).toBeNull();
    expect(refuseDeclaredLength(new Headers())).toBeNull();
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
