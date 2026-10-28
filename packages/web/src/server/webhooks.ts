/**
 * The PayPal webhook receiver: a delivery is stored only after its signature checks out
 * as PayPal's for our webhook id (C9).
 *
 * The signature is checked in this app (webhook-signature.ts) over the body's bytes
 * exactly as received and our webhook id, from config, never from the request; PayPal's
 * verify API is never called. The body must be strict UTF-8 (a byte-order mark is kept,
 * not dropped), so the text parsed and stored encodes back to exactly the bytes verified.
 * Nothing here acts on what an event says: a stored event is only a prompt for the
 * engine to re-read the resource from PayPal (C10). Once one is stored, the engine is
 * asked to process events at once rather than at the next scheduled run; that request
 * is never waited on and never changes the answer PayPal gets. A transmission id that
 * is already stored, or that the engine has already processed (event_outcomes keeps it
 * after the 47-hour purge deletes the stored row, inside the 72 hours a delivery is
 * accepted), is answered 200 without a write. Callers get a generic answer with a
 * correlation id; the reason stays in the server log, with the sender's address tag
 * (ratelimit.ts addressTag). The first rejection for each reason from each address in a
 * minute is also written to the audit log (C23), best-effort, decided in memory, at most
 * 20 per reason a minute across every address, so a flood leaves a bounded number of rows.
 *
 * Anyone can post to the webhook, so what a flood can spend is capped (C20), and PayPal's
 * own deliveries never wait behind it: the counts in memory per client address and
 * across everyone (address-limits.ts) are charged only for deliveries that are rejected,
 * and a delivery whose signature verifies is never refused for a count. A sender past a
 * count still has its delivery checked, but in the order that spends nothing shared:
 * the header checks before its body is read, then the signature, from the cached
 * certificate, before any database query; a rejection is then answered 429. Under the
 * counts, a delivery that passes the header and body checks costs one database read,
 * the stored-id lookup, before its signature is checked. The body is read only up to the
 * size cap. A forged delivery spends no PayPal API call, and the certificate downloads
 * it causes come out of its sender's own share (webhook-signature.ts), never out of
 * PayPal's known certificate. Does not cover a flood spread over many addresses under
 * the shared count, which costs each request its stored-id read, or a flood of forged
 * deliveries with well-formed headers past the counts, each of which still has its body
 * read and its signature checked.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { webhookLimits, webhookRejections } from "./address-limits";
import { loadConfig } from "./config";
import { database } from "./db";
import { runTask } from "./engine";
import { writeLog } from "./log";
import { addressTag, appendCappedAudit, clientAddress, recordMemoryRefusal } from "./ratelimit";
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

// fatal refuses every byte sequence that is not UTF-8 rather than replacing it, and
// ignoreBOM keeps a leading byte-order mark in the text, so the text always encodes back
// to exactly the bytes it came from.
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function strictText(bytes: Uint8Array): string | null {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return null;
  }
}

// A caller's text is taken as its UTF-8 bytes; the route always passes the request's own bytes.
function asBytes(raw: Uint8Array | string): Buffer {
  return typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
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
 * malformed, the body is over 262,144 bytes, is not strict UTF-8, or is not a single
 * JSON event object with no repeated keys. Otherwise returns "verified" only when the
 * signature over the body's bytes checks out (webhook-signature.ts); a certificate that
 * cannot be fetched or does not check out is "rejected" too. A string body is taken as
 * its UTF-8 bytes. Never calls PayPal's API. Throws ConfigError when PAYPAL_WEBHOOK_ID is
 * unusable.
 */
export async function verifyDelivery(rawBody: Uint8Array | string, headers: Headers): Promise<"verified" | "rejected"> {
  const bytes = asBytes(rawBody);
  const delivery = readDeliveryHeaders(headers);
  const text = strictText(bytes);
  if (delivery === null || bytes.byteLength > MAX_BODY_BYTES || text === null || "problem" in readEvent(text)) {
    return "rejected";
  }
  const verdict = await deliverySignatures().check(delivery, bytes, loadConfig().webhookId, clientAddress(headers));
  return verdict.ok ? "verified" : "rejected";
}

// Seen before: still stored, or already processed by the engine. event_outcomes keeps
// the id after the purge deletes the stored row at 47 hours, while a delivery is
// accepted for 72, so a replay in between is still known.
async function alreadySeen(transmissionId: string): Promise<boolean> {
  const { rows } = await database().query<{ seen: boolean }>(
    `select exists (select 1 from paypal_events where transmission_id = $1)
         or exists (select 1 from event_outcomes where transmission_id = $1) as seen`,
    [transmissionId],
  );
  return rows[0].seen;
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

// Best-effort: once per reason per address a minute and at most 20 per reason a minute
// across every address, decided in memory, and a failure leaves one log line.
async function recordRejection(sender: Sender, reason: string, status: number): Promise<void> {
  if (!webhookRejections.first(`${reason}\n${sender.address}`)) return;
  if (sender.tag === null) {
    writeLog({ kind: "audit", outcome: "not_written", action: "webhook_rejected", reason: "no_tag" });
    return;
  }
  await appendCappedAudit("webhook_rejected", reason, { reason, status, address_tag: sender.tag });
}

// Rate-limit refusals are recorded by receiveDelivery, once per limit and subject a window.
async function answer(status: number, ref: string, sender: Sender, log: Readonly<Record<string, unknown>>, retryAfterSeconds?: number): Promise<DeliveryResult> {
  writeLog({ kind: "webhook", ref, status, address_tag: sender.tag, ...log });
  if (log.outcome === "refused" && log.reason !== "rate_limited" && typeof log.reason === "string") await recordRejection(sender, log.reason, status);
  const body = `${ANSWERS[status]} (ref ${ref})`;
  return retryAfterSeconds === undefined ? { status, body } : { status, body, retryAfterSeconds };
}

/**
 * Ask the engine to run process_events now, without waiting, counted against the
 * sender's address for the engine client's in-flight cap. Never throws: a refusal to
 * start (missing engine settings) is logged under the delivery's ref, and a run that
 * fails or is refused is logged by the engine client. The mend-jobs cron processes
 * anything this misses within 5 minutes.
 */
function askEngineToProcess(ref: string, sender: Sender): void {
  Promise.resolve()
    .then(() => runTask("process_events", [], { address: sender.address }))
    .catch((error: unknown) => {
      writeLog({ kind: "webhook", ref, outcome: "engine_not_asked", reason: error instanceof Error ? error.message : "unknown" });
    });
}

/** What a delivery gets, decided but not yet logged or answered: the status and the log line's fields. */
type Verdict = { readonly status: number; readonly log: Readonly<Record<string, unknown>> };

function refused(status: 400 | 413, reason: string, facts: Readonly<Record<string, unknown>> = {}): Verdict {
  return { status, log: { outcome: "refused", reason, ...facts } };
}

function unavailable(error: unknown, facts: Readonly<Record<string, unknown>>): Verdict {
  const code = (error as { code?: unknown } | null)?.code;
  return { status: 503, log: { outcome: "unavailable", reason: "db_error", code: typeof code === "string" ? code : null, ...facts } };
}

// A rejection is the sender's fault and is charged to its counts; a 503 is ours and is not.
function isRejection(verdict: Verdict): boolean {
  return verdict.status === 400 || verdict.status === 413;
}

function declaredOversize(headers: Headers): Verdict | null {
  const declared = headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared) || Number(declared) <= MAX_BODY_BYTES) return null;
  return refused(413, "declared_oversize");
}

// Every check the PAYPAL-* headers can fail on their own, none of which needs the body
// or a query: their shapes, the transmission time window, the algorithm and the
// certificate address.
function headerVerdict(headers: Headers): { readonly delivery: DeliveryHeaders } | { readonly verdict: Verdict } {
  const delivery = readDeliveryHeaders(headers);
  if (delivery === null) return { verdict: refused(400, "missing_header") };
  const seen = { transmission_id: delivery.transmission_id };
  const late = timeProblem(delivery.transmission_time, Date.now());
  if (late !== null) return { verdict: refused(400, late, seen) };
  const unusable = signatureHeaderProblem(delivery);
  if (unusable !== null) return { verdict: refused(400, "verify_failure", { check: unusable, ...seen }) };
  return { delivery };
}

function headerProblem(headers: Headers): Verdict | null {
  const checked = headerVerdict(headers);
  return "verdict" in checked ? checked.verdict : null;
}

// 200 duplicate for an id seen before, 503 when the lookup fails, otherwise null.
async function replayVerdict(transmissionId: string): Promise<Verdict | null> {
  const seen = { transmission_id: transmissionId };
  try {
    return (await alreadySeen(transmissionId)) ? { status: 200, log: { outcome: "duplicate", reason: "transmission_stored", ...seen } } : null;
  } catch (error) {
    return unavailable(error, seen);
  }
}

/**
 * The verdict on one delivery's bytes. signatureFirst, for a sender past its counts,
 * checks the signature before the stored-id lookup, so a forged delivery from it runs no
 * query; otherwise the lookup comes first and a replay is answered without a signature
 * check.
 */
async function decide(bytes: Buffer, headers: Headers, sender: Sender, signatureFirst: boolean): Promise<Verdict> {
  if (bytes.byteLength > MAX_BODY_BYTES) return refused(413, "oversize");
  const checked = headerVerdict(headers);
  if ("verdict" in checked) return checked.verdict;
  const { delivery } = checked;
  const seen = { transmission_id: delivery.transmission_id };
  const text = strictText(bytes);
  if (text === null) return refused(400, "not_utf8", seen);
  const reading = readEvent(text);
  if ("problem" in reading) return refused(400, reading.problem, seen);

  if (!signatureFirst) {
    const replay = await replayVerdict(delivery.transmission_id);
    if (replay !== null) return replay;
  }
  const signature = await deliverySignatures().check(delivery, bytes, loadConfig().webhookId, sender.address);
  if (!signature.ok) {
    return refused(400, signature.problem === "certificate_budget" ? "certificate_budget" : "verify_failure", { check: signature.problem, ...seen });
  }
  if (signatureFirst) {
    const replay = await replayVerdict(delivery.transmission_id);
    if (replay !== null) return replay;
  }

  const event = reading.event;
  const facts = { ...seen, event_id: event.id, event_type: event.eventType, delivery };
  try {
    return { status: 200, log: { outcome: await storeEvent(delivery.transmission_id, event, text), ...facts } };
  } catch (error) {
    return unavailable(error, facts);
  }
}

// Log and answer a verdict, and once a delivery is stored ask the engine to process it.
async function finish(verdict: Verdict, ref: string, sender: Sender): Promise<DeliveryResult> {
  const result = await answer(verdict.status, ref, sender, verdict.log);
  if (verdict.log.outcome === "stored") askEngineToProcess(ref, sender);
  return result;
}

/**
 * The 413 answer for a request whose Content-Length already exceeds the cap, so the
 * route can refuse it before reading the body. Returns null when no such header is set.
 */
export async function refuseDeclaredLength(headers: Headers): Promise<DeliveryResult | null> {
  const verdict = declaredOversize(headers);
  return verdict === null ? null : answer(verdict.status, randomUUID(), senderOf(headers), verdict.log);
}

/**
 * The body's bytes, or null once they pass the cap. Reading stops at the first chunk
 * past the cap, so a body with no Content-Length, or a false one, costs at most the cap
 * plus one chunk. Nothing is decoded here: the bytes read are the bytes verified.
 */
async function readCappedBody(request: Request): Promise<Buffer | null> {
  if (request.body === null) return Buffer.alloc(0);
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
  return Buffer.concat(chunks);
}

async function readAndDecide(request: Request, sender: Sender, signatureFirst: boolean): Promise<Verdict> {
  let bytes: Buffer | null;
  try {
    bytes = await readCappedBody(request);
  } catch {
    return refused(400, "body_unreadable");
  }
  if (bytes === null) return refused(413, "oversize_stream");
  return decide(bytes, request.headers, sender, signatureFirst);
}

/**
 * Handle one webhook request and say what to answer. First 413 for a declared
 * Content-Length over the cap. Then, for a client address with 120 rejected requests in
 * the last minute, or once everyone together has 600, counted in memory: the header
 * checks before any of the body is read, then the signature before any query. The body
 * is read as a stream: 413 the moment it passes 262,144 bytes, length declared or not,
 * with nothing more read, and 400 if the sender breaks off. Its bytes then go through
 * the checks handleDelivery lists. Every rejection (a 400 or 413) is counted against the
 * sender's address and everyone, and is answered 429, with the wait until a retry can
 * pass, once a count is full; the first such refusal per limit and subject in a minute
 * writes an audit row. A delivery whose signature verifies is never counted and never
 * refused for a count.
 */
export async function receiveDelivery(request: Request): Promise<DeliveryResult> {
  const ref = randomUUID();
  const sender = senderOf(request.headers);
  const flooded = webhookLimits.full(sender.address) !== null;
  let verdict: Verdict;
  try {
    const early = declaredOversize(request.headers) ?? (flooded ? headerProblem(request.headers) : null);
    verdict = early ?? (await readAndDecide(request, sender, flooded));
  } catch {
    verdict = { status: 503, log: { outcome: "unavailable", reason: "internal_error" } };
  }
  if (isRejection(verdict)) {
    const hit = webhookLimits.take(sender.address);
    if (!hit.allowed) {
      await recordMemoryRefusal(hit, sender.address);
      return answer(429, ref, sender, { outcome: "refused", reason: "rate_limited", bucket: hit.limit.bucket, rejected: verdict.log.reason }, hit.retryAfterSeconds);
    }
  }
  return finish(verdict, ref, sender);
}

/**
 * Handle one webhook delivery and say what to answer PayPal. A string body is taken as
 * its UTF-8 bytes.
 *
 * In this order: a body over 262,144 bytes gets 413; a missing or malformed PAYPAL-*
 * header gets 400; a transmission time more than 5 minutes ahead or more than 3 days old
 * gets 400; an algorithm other than SHA256withRSA or a certificate address that is not
 * exactly https://api.sandbox.paypal.com/v1/notifications/certs/CERT-<id> gets 400
 * (verify_failure) before any query; a body that is not strict UTF-8 gets 400
 * (not_utf8); text that is not one JSON event object, has a repeated key at any depth,
 * or nests deeper than 64 gets 400; a transmission id already stored, or already
 * processed by the engine, gets 200 with no signature check and no write; a signature
 * over the body's bytes that does not check out, including a certificate that cannot be
 * fetched or does not chain to a trusted root, gets 400 (verify_failure, with the
 * failing check in the log) and nothing is stored; so does a certificate address not
 * yet known good once this client address has caused 2 certificate downloads this
 * minute or the app 10 (certificate_budget). A verified delivery records its
 * certificate address (webhook-signature.ts), is inserted once, keyed on transmission id
 * (event id is unique too), and the engine is then asked to process events without
 * waiting; a replay gets 200, stores nothing new and asks nothing. A database failure or
 * a missing webhook id setting gets 503 with nothing stored, so PayPal retries.
 *
 * The stored-id check trusts the header without verifying the body, so a forged body
 * under a seen id also gets 200; it is neither stored nor acted on, so nothing is lost.
 */
export async function handleDelivery(rawBody: Uint8Array | string, headers: Headers): Promise<DeliveryResult> {
  const ref = randomUUID();
  const sender = senderOf(headers);
  let verdict: Verdict;
  try {
    verdict = await decide(asBytes(rawBody), headers, sender, false);
  } catch {
    verdict = { status: 503, log: { outcome: "unavailable", reason: "internal_error" } };
  }
  return finish(verdict, ref, sender);
}
