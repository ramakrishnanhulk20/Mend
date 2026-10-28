import { randomUUID, timingSafeEqual } from "node:crypto";
import { joinLimits } from "@/server/address-limits";
import { csrfBinding, csrfSecret, csrfTokenFor, csrfTokenForRequest, originProblem } from "@/server/csrf";
import { EngineUnavailable, runAndWait, TOO_MANY_RUNNING } from "@/server/engine";
import { writeLog } from "@/server/log";
import { connectUrl, issueTicket, SANDBOX_WEB_HOST, type JoinIntent } from "@/server/paypal-login";
import { failed, refuse } from "@/server/permissions";
import { clientAddress, recordMemoryRefusal } from "@/server/ratelimit";
import { successBody } from "@/server/runs";

export const runtime = "nodejs";

const GET_ROUTE = "GET /api/join/paypal/start";
const WAIT_MS = 15_000;

// form-action names PayPal's sign-in host because browsers also check it against the
// redirect that follows the form POST.
const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": `default-src 'none'; form-action 'self' https://${SANDBOX_WEB_HOST}; frame-ancestors 'none'`,
  "x-frame-options": "DENY",
  // Not no-referrer: under that policy browsers send "Origin: null" on the form POST,
  // and the same-origin check then refuses the visitor's own click.
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
};

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** value with the five characters that can end an HTML text run or a quoted attribute replaced by their entities. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

/**
 * The confirmation a visitor clicks to join or leave: for a join, the shop name as a
 * heading and the exact consent words; for a leave, one sentence naming the shop. Each
 * has one button posting intent, csrf and, for a join, the consent hash back to this
 * route. Every value passed in goes through escapeHtml. No style and no script, which
 * the page's Content-Security-Policy forbids anyway.
 */
function confirmationPage(intent: JoinIntent, shopName: string, text: string, hash: string, csrf: string): string {
  const shop = escapeHtml(shopName);
  const words =
    intent === "join"
      ? `<h1>${shop}</h1>\n<p>${escapeHtml(text)}</p>`
      : `<p>Leave the thank-you list of ${shop}. Any reward not yet sent to you is cancelled.</p>`;
  const fields = [
    `<input type="hidden" name="intent" value="${escapeHtml(intent)}">`,
    ...(intent === "join" ? [`<input type="hidden" name="consent" value="${escapeHtml(hash)}">`] : []),
    `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
  ];
  return [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mend</title></head>',
    "<body>",
    words,
    '<form method="post" action="/api/join/paypal/start">',
    ...fields,
    `<button type="submit">${intent === "join" ? "Join with PayPal" : "Leave with PayPal"}</button>`,
    "</form>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

type Shown = { readonly shopName: string; readonly text: string; readonly hash: string };

/** The consent words the engine shows now, or the refusal to send when it cannot say. */
async function currentConsent(request: Request, route: string, ref: string): Promise<{ readonly shown: Shown } | { readonly refusal: Response }> {
  const waited = await runAndWait("consent_text", [], WAIT_MS, { address: clientAddress(request.headers) });
  if (waited.state === "pending") {
    return { refusal: refuse(route, ref, 503, "engine_unavailable", { reason: "consent_still_running", run_id: waited.runId }) };
  }
  if (waited.status === "failed" || waited.result === undefined) {
    return { refusal: refuse(route, ref, 503, "engine_unavailable", { reason: "run_failed", run_id: waited.runId }) };
  }
  if (!waited.result.ok && waited.result.error === TOO_MANY_RUNNING) {
    return { refusal: refuse(route, waited.result.ref, 429, TOO_MANY_RUNNING, { run_id: waited.runId }) };
  }
  if (!waited.result.ok) return { refusal: refuse(route, waited.result.ref, 500, "internal", { engine_error: waited.result.error, run_id: waited.runId }) };
  const body = successBody("consent_text", waited.result);
  if (body === null || typeof body.shopName !== "string" || typeof body.text !== "string" || typeof body.hash !== "string") {
    return { refusal: refuse(route, ref, 500, "internal", { reason: "malformed_answer", run_id: waited.runId }) };
  }
  return { shown: { shopName: body.shopName, text: body.text, hash: body.hash } };
}

/** The 429 refusal once this client address is past the start count in memory, which GET and POST share; otherwise null. */
async function overLimit(request: Request, route: string, ref: string): Promise<Response | null> {
  const address = clientAddress(request.headers);
  const hit = joinLimits.start.take(address);
  if (hit.allowed) return null;
  await recordMemoryRefusal(hit, address);
  return refuse(route, ref, 429, "rate_limited", { bucket: hit.limit.bucket }, { "retry-after": String(hit.retryAfterSeconds) });
}

/**
 * The confirmation page for joining (?intent=join) or leaving (?intent=leave). The
 * visitor's own click on it is the only way into PayPal's sign-in (C28): the POST it
 * sends needs this origin and this browser's CSRF token, and the page cannot be framed.
 * Any other query answers 400. Sets the anonymous CSRF cookie when the browser has
 * nothing to bind a token to. 429 past 20 a minute per client address or 600 from
 * everyone, counted in memory with POST; 429 too_many_running while two engine calls
 * already run for this address; 503 when the engine has not answered within 15 seconds.
 */
export async function GET(request: Request): Promise<Response> {
  const ref = randomUUID();
  try {
    csrfSecret();
    const tooMany = await overLimit(request, GET_ROUTE, ref);
    if (tooMany !== null) return tooMany;
    const params = new URL(request.url).searchParams;
    const names = [...params.keys()];
    const intent = params.get("intent");
    if (names.length !== 1 || names[0] !== "intent" || (intent !== "join" && intent !== "leave")) {
      return refuse(GET_ROUTE, ref, 400, "bad_request", { reason: "bad_query" });
    }
    const consent = await currentConsent(request, GET_ROUTE, ref);
    if ("refusal" in consent) return consent.refusal;
    const { token, cookies } = csrfTokenForRequest(request);
    const headers = new Headers(PAGE_HEADERS);
    for (const cookie of cookies) headers.append("set-cookie", cookie);
    writeLog({ kind: "join", route: GET_ROUTE, ref, status: 200, outcome: "confirmation_shown", intent });
    // Plain markup until the audit is closed; the designed join page replaces it then and posts to this same route.
    const page = confirmationPage(intent, consent.shown.shopName, consent.shown.text, consent.shown.hash, token);
    return new Response(page, { status: 200, headers });
  } catch (error) {
    return failed(GET_ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}

const POST_ROUTE = "POST /api/join/paypal/start";
const MAX_FORM_BYTES = 4096;
const CONSENT_HASH = /^[0-9a-f]{64}$/;
const CSRF_TOKEN = /^c2\.[A-Za-z0-9_-]{43}$/;
// Sorted, so a form's sorted field names can be compared to them directly.
const FORM_FIELDS: Readonly<Record<JoinIntent, string>> = { join: "consent,csrf,intent", leave: "csrf,intent" };

type FormProblem = "not_form" | "too_large" | "not_utf8";

/**
 * The request body as application/x-www-form-urlencoded fields, at most 4 KB. Stops
 * reading as soon as the cap is passed, so a huge or endless body costs no more than that.
 */
async function readForm(request: Request): Promise<{ readonly fields: URLSearchParams } | { readonly problem: FormProblem }> {
  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return { problem: "not_form" };
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_FORM_BYTES)) return { problem: "too_large" };
  if (request.body === null) return { fields: new URLSearchParams() };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FORM_BYTES) {
      await reader.cancel();
      return { problem: "too_large" };
    }
    chunks.push(value);
  }
  try {
    return { fields: new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) };
  } catch {
    return { problem: "not_utf8" };
  }
}

/** True only when presented is exactly the token for this browser's binding, compared in constant time. */
function csrfMatches(request: Request, presented: string): boolean {
  const binding = csrfBinding(request);
  if (binding === null || !CSRF_TOKEN.test(presented)) return false;
  // Both are "c2." and 43 characters, so the buffers have the length timingSafeEqual needs.
  return timingSafeEqual(Buffer.from(presented, "utf8"), Buffer.from(csrfTokenFor(binding), "utf8"));
}

/**
 * The visitor's click on the confirmation page: sends the browser to PayPal's sandbox
 * sign-in. In this order: 429 past the start count; 403 not_allowed unless Origin is
 * exactly this app's origin; 400 bad_request unless the body is a form of at most 4 KB holding
 * exactly intent and csrf, plus consent for a join, each once; 403 not_allowed unless
 * csrf is this browser's token, whether its binding is a session or the anonymous id;
 * for a join, 400 unless consent is 64 lowercase hex and 409 consent_changed unless it
 * is the hash of the words the engine shows now (C28). Then 303 to
 * https://www.sandbox.paypal.com/connect with the signed join cookie (paypal-login.ts).
 * 429 too_many_running while two engine calls already run for this address; 503 when
 * the engine has not answered within 15 seconds.
 */
export async function POST(request: Request): Promise<Response> {
  const ref = randomUUID();
  try {
    csrfSecret();
    const tooMany = await overLimit(request, POST_ROUTE, ref);
    if (tooMany !== null) return tooMany;
    const origin = originProblem(request);
    if (origin !== null) return refuse(POST_ROUTE, ref, 403, "not_allowed", { reason: origin });
    const form = await readForm(request);
    if ("problem" in form) return refuse(POST_ROUTE, ref, 400, "bad_request", { reason: form.problem });
    const names = [...form.fields.keys()];
    if (new Set(names).size !== names.length) return refuse(POST_ROUTE, ref, 400, "bad_request", { reason: "repeated_field" });
    const intent = form.fields.get("intent");
    if (intent !== "join" && intent !== "leave") return refuse(POST_ROUTE, ref, 400, "bad_request", { reason: "bad_intent" });
    if (names.sort().join(",") !== FORM_FIELDS[intent]) return refuse(POST_ROUTE, ref, 400, "bad_request", { reason: "unknown_or_missing_field" });
    if (!csrfMatches(request, form.fields.get("csrf") ?? "")) return refuse(POST_ROUTE, ref, 403, "not_allowed", { reason: "csrf_mismatch" });

    let consent: string | null = null;
    if (intent === "join") {
      const presented = form.fields.get("consent") ?? "";
      if (!CONSENT_HASH.test(presented)) return refuse(POST_ROUTE, ref, 400, "bad_request", { reason: "bad_consent" });
      const current = await currentConsent(request, POST_ROUTE, ref);
      if ("refusal" in current) return current.refusal;
      if (current.shown.hash !== presented) return refuse(POST_ROUTE, ref, 409, "consent_changed");
      consent = presented;
    }
    const { ticket, cookie } = issueTicket(intent, consent);
    const location = connectUrl(ticket.state);
    writeLog({ kind: "join", route: POST_ROUTE, ref, status: 303, outcome: "sent_to_paypal", intent });
    const headers = new Headers({ location: location.href, "referrer-policy": "no-referrer", "cache-control": "no-store" });
    headers.append("set-cookie", cookie);
    return new Response(null, { status: 303, headers });
  } catch (error) {
    return failed(POST_ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}
