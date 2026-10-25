/**
 * The PayPal webhook receiver: a delivery is stored only after PayPal confirms it.
 *
 * PayPal's verify-webhook-signature call is given our webhook id (from config, never
 * from the request) and the event text exactly as received, spliced into the request
 * as raw text. The text that was verified is the text that is parsed and stored.
 * Nothing here acts on what an event says: a stored event is only a prompt for the
 * engine to re-read the resource from PayPal (C10). Once one is stored, the engine is
 * asked to process events at once rather than at the next scheduled run; that request
 * is never waited on and never changes the answer PayPal gets. Callers get a generic
 * answer with a correlation id; the reason stays in the server log.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadConfig } from "./config";
import { database } from "./db";
import { runTask } from "./engine";
import { writeLog } from "./log";
import { paypalFetch, type PayPalReply } from "./paypal";
import { parseStrictJson, StrictJsonError } from "./strict-json";

export const MAX_BODY_BYTES = 262_144;
export const MAX_CLOCK_AHEAD_MS = 5 * 60 * 1000;
export const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
export const PURGE_AFTER_HOURS = 48;
const VERIFY_PATH = "/v1/notifications/verify-webhook-signature";

const PRINTABLE_NO_SPACE = /^[\x21-\x7e]+$/;

// Header names, and the length and shape PayPal's own verify request schema allows for
// each value. A repeated header arrives joined with ", " and so fails the shape.
const DELIVERY_HEADERS = {
  auth_algo: { name: "paypal-auth-algo", max: 100, shape: /^[A-Za-z0-9]+$/ },
  cert_url: { name: "paypal-cert-url", max: 500, shape: PRINTABLE_NO_SPACE },
  transmission_id: { name: "paypal-transmission-id", max: 50, shape: PRINTABLE_NO_SPACE },
  transmission_sig: { name: "paypal-transmission-sig", max: 500, shape: PRINTABLE_NO_SPACE },
  transmission_time: { name: "paypal-transmission-time", max: 100, shape: PRINTABLE_NO_SPACE },
} as const;

type DeliveryHeaders = { readonly [K in keyof typeof DELIVERY_HEADERS]: string };

const RESOURCE_ID = /^[A-Za-z0-9-]{1,64}$/;

const eventSchema = z.object({
  id: z.string().regex(/^[\x21-\x7e]{1,128}$/),
  event_type: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  resource: z.unknown().optional(),
});

type WebhookEvent = { readonly id: string; readonly eventType: string; readonly resourceId: string | null };

export type DeliveryResult = { readonly status: number; readonly body: string };

/** PayPal gave no usable verdict (timeout, network, non-200 or malformed answer). */
export class VerificationUnavailable extends Error {
  readonly debugId: string | null;

  constructor(reason: string, debugId: string | null) {
    super(`webhook verification unavailable: ${reason}`);
    this.name = "VerificationUnavailable";
    this.debugId = debugId;
  }
}

function bodyBytes(rawBody: string): number {
  return Buffer.byteLength(rawBody, "utf8");
}

const DELIVERY_HEADER_KEYS = Object.keys(DELIVERY_HEADERS) as (keyof DeliveryHeaders)[];

function readDeliveryHeaders(headers: Headers): DeliveryHeaders | null {
  const values: Partial<Record<keyof DeliveryHeaders, string>> = {};
  for (const key of DELIVERY_HEADER_KEYS) {
    const rule = DELIVERY_HEADERS[key];
    const value = headers.get(rule.name);
    if (value === null || value.length > rule.max || !rule.shape.test(value)) return null;
    values[key] = value;
  }
  return values as DeliveryHeaders;
}

function first(object: unknown, ...path: string[]): unknown {
  let current = object;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// The id the engine should re-read: a capture or order id, a payout item id, or a
// payout batch id, whichever the resource carries. Anything else is stored as null.
function resourceIdOf(resource: unknown): string | null {
  for (const candidate of [
    first(resource, "id"),
    first(resource, "payout_item_id"),
    first(resource, "batch_header", "payout_batch_id"),
  ]) {
    if (typeof candidate === "string" && RESOURCE_ID.test(candidate)) return candidate;
  }
  return null;
}

type EventReading = { readonly event: WebhookEvent } | { readonly problem: string };

function readEvent(rawBody: string): EventReading {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(rawBody);
  } catch (error) {
    return { problem: error instanceof StrictJsonError ? error.problem : "syntax" };
  }
  const event = eventSchema.safeParse(parsed);
  if (!event.success) return { problem: "not_an_event" };
  return { event: { id: event.data.id, eventType: event.data.event_type, resourceId: resourceIdOf(event.data.resource) } };
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

/**
 * Milliseconds since the epoch for an RFC 3339 time with a Z or numeric offset, or null.
 * Every field must round-trip, so 30 February or 24:00 are refused rather than rolled
 * over the way Date.parse does.
 */
export function parseTransmissionTime(text: string): number | null {
  const match = RFC3339.exec(text);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const millis = match[7] === undefined ? 0 : Number(match[7].slice(0, 3).padEnd(3, "0"));
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return null;
  }
  if (match[8] === "Z") return wall;
  const offsetHours = Number(match[10]);
  const offsetMinutes = Number(match[11]);
  if (offsetHours > 23 || offsetMinutes > 59) return null;
  const sign = match[9] === "+" ? 1 : -1;
  return wall - sign * (offsetHours * 60 + offsetMinutes) * 60_000;
}

function timeProblem(transmissionTime: string, now: number): string | null {
  const sent = parseTransmissionTime(transmissionTime);
  if (sent === null) return "bad_time";
  if (sent > now + MAX_CLOCK_AHEAD_MS) return "future_time";
  if (sent < now - MAX_AGE_MS) return "stale_time";
  return null;
}

function postbackBody(delivery: DeliveryHeaders, webhookId: string, rawBody: string): string {
  const head = JSON.stringify({
    auth_algo: delivery.auth_algo,
    cert_url: delivery.cert_url,
    transmission_id: delivery.transmission_id,
    transmission_sig: delivery.transmission_sig,
    transmission_time: delivery.transmission_time,
    webhook_id: webhookId,
  });
  // Spliced as text: parsing and re-serialising can change bytes PayPal signed.
  return `${head.slice(0, -1)},"webhook_event":${rawBody}}`;
}

async function askPayPal(delivery: DeliveryHeaders, rawBody: string): Promise<"verified" | "rejected"> {
  let reply: PayPalReply;
  try {
    reply = await paypalFetch(VERIFY_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: postbackBody(delivery, loadConfig().webhookId, rawBody),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    throw new VerificationUnavailable(name, null);
  }
  const verdict = first(reply.body, "verification_status");
  if (reply.status !== 200 || typeof verdict !== "string") {
    throw new VerificationUnavailable(`status ${reply.status}`, reply.debugId);
  }
  return verdict === "SUCCESS" ? "verified" : "rejected";
}

/**
 * Ask PayPal whether this delivery is a genuine event for our webhook id.
 *
 * Returns "rejected" without calling PayPal when a PAYPAL-* header is missing or
 * malformed, the body is over 262,144 bytes, or the body is not a single JSON event
 * object with no repeated keys. Otherwise returns "verified" only when PayPal answers
 * SUCCESS. Throws VerificationUnavailable when PayPal gives no usable answer.
 */
export async function verifyDelivery(rawBody: string, headers: Headers): Promise<"verified" | "rejected"> {
  const delivery = readDeliveryHeaders(headers);
  if (delivery === null || bodyBytes(rawBody) > MAX_BODY_BYTES || "problem" in readEvent(rawBody)) {
    return "rejected";
  }
  return askPayPal(delivery, rawBody);
}

async function storeEvent(transmissionId: string, event: WebhookEvent, rawBody: string): Promise<"stored" | "duplicate"> {
  // One now() for both columns, so purge_after is exactly 48 hours after received_at.
  // No conflict target: a repeated transmission id and a re-sent event id are both duplicates.
  const result = await database().query(
    `insert into paypal_events (transmission_id, event_id, event_type, resource_id, received_at, purge_after, raw)
     values ($1, $2, $3, $4, now(), now() + make_interval(hours => $5), $6)
     on conflict do nothing`,
    [transmissionId, event.id, event.eventType, event.resourceId, PURGE_AFTER_HOURS, rawBody],
  );
  return result.rowCount === 1 ? "stored" : "duplicate";
}

const ANSWERS: Readonly<Record<number, string>> = {
  200: "ok",
  400: "refused",
  413: "too large",
  503: "try again later",
};

function answer(status: number, ref: string, log: Readonly<Record<string, unknown>>): DeliveryResult {
  writeLog({ kind: "webhook", ref, status, ...log });
  return { status, body: `${ANSWERS[status]} (ref ${ref})` };
}

/**
 * Ask the engine to run process_events now, without waiting. Never throws: a refusal to
 * start (missing engine settings) is logged under the delivery's ref, and a run that
 * fails is logged by the engine client. The mend-jobs cron processes anything this
 * misses within 5 minutes.
 */
function askEngineToProcess(ref: string): void {
  Promise.resolve()
    .then(() => runTask("process_events", []))
    .catch((error: unknown) => {
      writeLog({ kind: "webhook", ref, outcome: "engine_not_asked", reason: error instanceof Error ? error.message : "unknown" });
    });
}

/**
 * The 413 answer for a request whose Content-Length already exceeds the cap, so the
 * route can refuse it before reading the body. Returns null when no such header is set.
 */
export function refuseDeclaredLength(headers: Headers): DeliveryResult | null {
  const declared = headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared) || Number(declared) <= MAX_BODY_BYTES) return null;
  return answer(413, randomUUID(), { outcome: "refused", reason: "declared_oversize" });
}

/**
 * Handle one webhook delivery and say what to answer PayPal.
 *
 * In this order: a body over 262,144 bytes gets 413; a missing or malformed PAYPAL-*
 * header gets 400; text that is not one JSON event object, has a repeated key at any
 * depth, or nests deeper than 64 gets 400; a transmission time more than 5 minutes
 * ahead or more than 3 days old gets 400; PayPal's verdict other than SUCCESS gets 400
 * and nothing is stored. A verified delivery is inserted once, keyed on transmission
 * id (event id is unique too), and the engine is then asked to process events without
 * waiting; a replay gets 200, stores nothing new and asks nothing. A verification
 * error, timeout or database failure gets 503 with nothing stored, so PayPal retries.
 */
export async function handleDelivery(rawBody: string, headers: Headers): Promise<DeliveryResult> {
  const ref = randomUUID();
  try {
    if (bodyBytes(rawBody) > MAX_BODY_BYTES) {
      return answer(413, ref, { outcome: "refused", reason: "oversize" });
    }
    const delivery = readDeliveryHeaders(headers);
    if (delivery === null) {
      return answer(400, ref, { outcome: "refused", reason: "missing_header" });
    }
    const seen = { transmission_id: delivery.transmission_id };
    const reading = readEvent(rawBody);
    if ("problem" in reading) {
      return answer(400, ref, { outcome: "refused", reason: reading.problem, ...seen });
    }
    const late = timeProblem(delivery.transmission_time, Date.now());
    if (late !== null) {
      return answer(400, ref, { outcome: "refused", reason: late, ...seen });
    }

    let verdict: "verified" | "rejected";
    try {
      verdict = await askPayPal(delivery, rawBody);
    } catch (error) {
      const debugId = error instanceof VerificationUnavailable ? error.debugId : null;
      const reason = error instanceof Error ? error.message : "verification failed";
      return answer(503, ref, { outcome: "unavailable", reason: "verify_error", detail: reason, debug_id: debugId, ...seen });
    }
    if (verdict !== "verified") {
      return answer(400, ref, { outcome: "refused", reason: "verify_failure", ...seen });
    }

    const event = reading.event;
    const facts = { ...seen, event_id: event.id, event_type: event.eventType, delivery };
    let stored: "stored" | "duplicate";
    try {
      stored = await storeEvent(delivery.transmission_id, event, rawBody);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return answer(503, ref, { outcome: "unavailable", reason: "db_error", code: typeof code === "string" ? code : null, ...facts });
    }
    const result = answer(200, ref, { outcome: stored, ...facts });
    if (stored === "stored") askEngineToProcess(ref);
    return result;
  } catch {
    return answer(503, ref, { outcome: "unavailable", reason: "internal_error" });
  }
}
