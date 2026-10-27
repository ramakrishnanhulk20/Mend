/**
 * The PayPal webhook receiver: a delivery is stored only after its signature checks out
 * as PayPal's for our webhook id (C9).
 *
 * The signature is checked in this app (webhook-signature.ts) over the body exactly as
 * received and our webhook id, from config, never from the request; PayPal's verify API
 * is never called. The text that was verified is the text that is parsed and stored.
 * Nothing here acts on what an event says: a stored event is only a prompt for the
 * engine to re-read the resource from PayPal (C10). Once one is stored, the engine is
 * asked to process events at once rather than at the next scheduled run; that request
 * is never waited on and never changes the answer PayPal gets. A transmission id that
 * is already stored is answered 200 without checking the signature again and without a
 * write. Callers get a generic answer with a correlation id; the reason stays in the
 * server log, with the sender's address tag (ratelimit.ts addressTag). The first
 * rejection for each reason from each address in a minute is also written to the audit
 * log (C23), best-effort, decided in memory, so a flood leaves one row per reason and
 * address rather than one per request.
 *
 * Anyone can post to the webhook, so what a flood can spend is capped (C20): requests
 * are counted in memory per client address and across everyone (address-limits.ts)
 * before a byte of the body is read or any database query runs, and the body is read
 * only up to the size cap. A forged delivery spends no PayPal API call. One that passes
 * the header, body, time and certificate address checks still costs one database read,
 * the stored-id lookup, which the in-memory counts bound, and the certificate downloads
 * it causes come out of its sender's own share (webhook-signature.ts), never out of
 * PayPal's known certificate. Does not cover a flood spread
 * over many addresses under the shared count: that delays real deliveries (PayPal
 * retries anything not answered 2xx, and the jobs cron re-reads PayPal).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { webhookLimits, webhookRejections } from "./address-limits";
import { appendAudit } from "./audit";
import { loadConfig } from "./config";
import { database } from "./db";
import { runTask } from "./engine";
import { writeLog } from "./log";
import { addressTag, clientAddress, GLOBAL, recordLimitHit } from "./ratelimit";
import { parseStrictJson, StrictJsonError } from "./strict-json";
import { deliverySignatures, signatureHeaderProblem } from "./webhook-signature";

export const MAX_BODY_BYTES = 262_144;
export const MAX_CLOCK_AHEAD_MS = 5 * 60 * 1000;
export const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
// An hour inside C27's 48, so a row is still gone in time when a purge run is late or fails.
export const PURGE_AFTER_HOURS = 47;

const PRINTABLE_NO_SPACE = /^[\x21-\x7e]+$/;

// Header names, and the length and shape each value may have. A repeated header arrives
// joined with ", " and so fails the shape. The signature has room for a 4096-bit RSA
// key's 684 base64 characters.
const DELIVERY_HEADERS = {
  auth_algo: { name: "paypal-auth-algo", max: 100, shape: /^[A-Za-z0-9]+$/ },
  cert_url: { name: "paypal-cert-url", max: 500, shape: PRINTABLE_NO_SPACE },
  transmission_id: { name: "paypal-transmission-id", max: 50, shape: PRINTABLE_NO_SPACE },
  transmission_sig: { name: "paypal-transmission-sig", max: 700, shape: PRINTABLE_NO_SPACE },
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

/** What to answer: the status, the generic body, and for a 429 how many seconds until a retry can pass. */
export type DeliveryResult = { readonly status: number; readonly body: string; readonly retryAfterSeconds?: number };

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

/**
 * Whether this delivery is a genuine event for our webhook id, checked in the app.
 *
 * Returns "rejected" without any download when a PAYPAL-* header is missing or
 * malformed, the body is over 262,144 bytes, or the body is not a single JSON event
 * object with no repeated keys. Otherwise returns "verified" only when the signature
 * checks out (webhook-signature.ts); a certificate that cannot be fetched or does not
 * check out is "rejected" too. Never calls PayPal's API. Throws ConfigError when
 * PAYPAL_WEBHOOK_ID is unusable.
 */
export async function verifyDelivery(rawBody: string, headers: Headers): Promise<"verified" | "rejected"> {
  const delivery = readDeliveryHeaders(headers);
  if (delivery === null || bodyBytes(rawBody) > MAX_BODY_BYTES || "problem" in readEvent(rawBody)) {
    return "rejected";
  }
  const verdict = await deliverySignatures().check(delivery, rawBody, loadConfig().webhookId, clientAddress(headers));
  return verdict.ok ? "verified" : "rejected";
}

async function alreadyStored(transmissionId: string): Promise<boolean> {
  const { rows } = await database().query("select 1 from paypal_events where transmission_id = $1", [transmissionId]);
  return rows.length > 0;
}

async function storeEvent(transmissionId: string, event: WebhookEvent, rawBody: string): Promise<"stored" | "duplicate"> {
  // One now() for both columns, so purge_after is exactly 47 hours after received_at.
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
  429: "too many requests",
  503: "try again later",
};

/** Who sent a request: the address its limits count against, and that address's tag for logs (null when MEND_CSRF_SECRET is unusable). */
type Sender = { readonly address: string; readonly tag: string | null };

function senderOf(headers: Headers): Sender {
  const address = clientAddress(headers);
  try {
    return { address, tag: addressTag(address) };
  } catch {
    // A missing secret already refuses every console route; here it must not change PayPal's answer.
    return { address, tag: null };
  }
}

// Best-effort: once per reason per address a minute, decided in memory, and a failure
// leaves one log line.
async function recordRejection(sender: Sender, reason: string, status: number): Promise<void> {
  if (!webhookRejections.first(`${reason}\n${sender.address}`)) return;
  if (sender.tag === null) {
    writeLog({ kind: "audit", outcome: "not_written", action: "webhook_rejected", reason: "no_tag" });
    return;
  }
  await appendAudit("webhook_rejected", { reason, status, address_tag: sender.tag });
}

// Rate-limit refusals are recorded by refuseOverLimit, once per limit and subject a window.
async function answer(status: number, ref: string, sender: Sender, log: Readonly<Record<string, unknown>>, retryAfterSeconds?: number): Promise<DeliveryResult> {
  writeLog({ kind: "webhook", ref, status, address_tag: sender.tag, ...log });
  if (log.outcome === "refused" && log.reason !== "rate_limited" && typeof log.reason === "string") await recordRejection(sender, log.reason, status);
  const body = `${ANSWERS[status]} (ref ${ref})`;
  return retryAfterSeconds === undefined ? { status, body } : { status, body, retryAfterSeconds };
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
export async function refuseDeclaredLength(headers: Headers): Promise<DeliveryResult | null> {
  const declared = headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared) || Number(declared) <= MAX_BODY_BYTES) return null;
  return answer(413, randomUUID(), senderOf(headers), { outcome: "refused", reason: "declared_oversize" });
}

/**
 * The 429 answer, with the wait until a retry can pass, once this client address has
 * sent 120 requests in the last minute or everyone together 600; otherwise null. The
 * counts live in memory, so deciding runs no query. Only the first refusal per limit
 * and subject in a minute writes an audit row, so a flood refused here costs at most
 * one row a minute per flooding address plus one for the shared count.
 */
async function refuseOverLimit(sender: Sender): Promise<DeliveryResult | null> {
  const hit = webhookLimits.take(sender.address);
  if (hit.allowed) return null;
  if (hit.firstRefusal) await recordLimitHit(hit.limit, hit.limit.per === "address" ? sender.address : GLOBAL);
  return answer(429, randomUUID(), sender, { outcome: "refused", reason: "rate_limited", bucket: hit.limit.bucket }, hit.retryAfterSeconds);
}

/**
 * The body as text, or null once it passes the cap. Reading stops at the first chunk
 * past the cap, so a body with no Content-Length, or a false one, costs at most the cap
 * plus one chunk. Decoded the way request.text() decodes, so the text verified is the
 * text it would have been before.
 */
async function readCappedBody(request: Request): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Handle one webhook request and say what to answer. Before any of the body is read or
 * any query runs: 429 with a wait once this client address has sent 120 requests in the
 * last minute or everyone together 600, counted in memory, then 413 for a declared
 * Content-Length over the cap. The body
 * is then read as a stream: 413 the moment it passes 262,144 bytes, length declared or
 * not, with nothing more read, and 400 if the sender breaks off. The text read goes
 * through handleDelivery.
 */
export async function receiveDelivery(request: Request): Promise<DeliveryResult> {
  const sender = senderOf(request.headers);
  const refused = (await refuseOverLimit(sender)) ?? (await refuseDeclaredLength(request.headers));
  if (refused !== null) return refused;
  let rawBody: string | null;
  try {
    rawBody = await readCappedBody(request);
  } catch {
    return answer(400, randomUUID(), sender, { outcome: "refused", reason: "body_unreadable" });
  }
  if (rawBody === null) return answer(413, randomUUID(), sender, { outcome: "refused", reason: "oversize_stream" });
  return handleDelivery(rawBody, request.headers);
}

/**
 * Handle one webhook delivery and say what to answer PayPal.
 *
 * In this order: a body over 262,144 bytes gets 413; a missing or malformed PAYPAL-*
 * header gets 400; text that is not one JSON event object, has a repeated key at any
 * depth, or nests deeper than 64 gets 400; a transmission time more than 5 minutes
 * ahead or more than 3 days old gets 400; an algorithm other than SHA256withRSA or a
 * certificate address that is not exactly
 * https://api.sandbox.paypal.com/v1/notifications/certs/CERT-<id> gets 400
 * (verify_failure) before any query; a transmission id already stored gets 200 with no
 * signature check and no write; a signature that does not check out, including a
 * certificate that cannot be fetched or does not chain to a trusted root, gets 400
 * (verify_failure, with the failing check in the log) and nothing is stored; so does a
 * certificate address not yet known good once this client address has caused 2
 * certificate downloads this minute or the app 10 (certificate_budget). A verified
 * delivery records its certificate address (webhook-signature.ts), is inserted once,
 * keyed on transmission id (event id is unique too), and the engine is then asked to
 * process events without waiting; a replay gets
 * 200, stores nothing new and asks nothing. A database failure or a missing webhook id
 * setting gets 503 with nothing stored, so PayPal retries.
 *
 * The stored-id check trusts the header without verifying the body, so a forged body
 * under a stored id also gets 200; it is neither stored nor acted on, so nothing is lost.
 */
export async function handleDelivery(rawBody: string, headers: Headers): Promise<DeliveryResult> {
  const ref = randomUUID();
  const sender = senderOf(headers);
  try {
    if (bodyBytes(rawBody) > MAX_BODY_BYTES) {
      return await answer(413, ref, sender, { outcome: "refused", reason: "oversize" });
    }
    const delivery = readDeliveryHeaders(headers);
    if (delivery === null) {
      return await answer(400, ref, sender, { outcome: "refused", reason: "missing_header" });
    }
    const seen = { transmission_id: delivery.transmission_id };
    const reading = readEvent(rawBody);
    if ("problem" in reading) {
      return await answer(400, ref, sender, { outcome: "refused", reason: reading.problem, ...seen });
    }
    const late = timeProblem(delivery.transmission_time, Date.now());
    if (late !== null) {
      return await answer(400, ref, sender, { outcome: "refused", reason: late, ...seen });
    }
    const unusable = signatureHeaderProblem(delivery);
    if (unusable !== null) {
      return await answer(400, ref, sender, { outcome: "refused", reason: "verify_failure", check: unusable, ...seen });
    }

    let stored: boolean;
    try {
      stored = await alreadyStored(delivery.transmission_id);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return await answer(503, ref, sender, { outcome: "unavailable", reason: "db_error", code: typeof code === "string" ? code : null, ...seen });
    }
    if (stored) {
      return await answer(200, ref, sender, { outcome: "duplicate", reason: "transmission_stored", ...seen });
    }

    const verdict = await deliverySignatures().check(delivery, rawBody, loadConfig().webhookId, sender.address);
    if (!verdict.ok) {
      const reason = verdict.problem === "certificate_budget" ? "certificate_budget" : "verify_failure";
      return await answer(400, ref, sender, { outcome: "refused", reason, check: verdict.problem, ...seen });
    }

    const event = reading.event;
    const facts = { ...seen, event_id: event.id, event_type: event.eventType, delivery };
    let outcome: "stored" | "duplicate";
    try {
      outcome = await storeEvent(delivery.transmission_id, event, rawBody);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return await answer(503, ref, sender, { outcome: "unavailable", reason: "db_error", code: typeof code === "string" ? code : null, ...facts });
    }
    const result = await answer(200, ref, sender, { outcome, ...facts });
    if (outcome === "stored") askEngineToProcess(ref);
    return result;
  } catch {
    return answer(503, ref, sender, { outcome: "unavailable", reason: "internal_error" });
  }
}
