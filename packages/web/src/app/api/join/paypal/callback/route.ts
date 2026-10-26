import { randomUUID } from "node:crypto";
import { EngineUnavailable, runAndWait, type Waited } from "@/server/engine";
import { writeLog } from "@/server/log";
import {
  clearedTicketCookie,
  exchangeCode,
  LoginError,
  oneQueryValue,
  readIdentity,
  readTicket,
  stateMatches,
  type IdentityReading,
  type JoinIntent,
} from "@/server/paypal-login";
import { reply } from "@/server/permissions";
import { clientAddress, LIMITS, takeHit } from "@/server/ratelimit";
import { successBody } from "@/server/runs";

export const runtime = "nodejs";

const ROUTE = "GET /api/join/paypal/callback";
const WAIT_MS = 20_000;
const PAYPAL_ERROR_CODE = /^[a-z][a-z_]{0,63}$/;

// Rules the customer's PayPal account broke for this join or leave. None of them
// changed anything, and each is the customer's to fix, so each is answered as itself.
const ENGINE_REFUSALS: ReadonlySet<string> = new Set(["bad_identity", "consent_changed", "not_payable", "identity_conflict", "email_unverified"]);

// Generic on purpose (C26): the reason stays in the log line under the same ref.
const MESSAGES: Readonly<Record<number, string>> = {
  400: "The request was not accepted.",
  409: "Nothing was changed. Start again from the join link.",
  429: "Too many requests. Try again later.",
  500: "Something went wrong.",
  502: "PayPal did not answer as expected. Nothing was changed. Try again shortly.",
  503: "A service this needs is not reachable right now. Try again shortly.",
};

type Facts = Readonly<Record<string, unknown>>;

/**
 * The callback's answer, which always clears the join cookie, and its one log line:
 * kind "join", outcome, ref, and whatever facts the step reached, such as the sorted
 * userinfo field names (names only, so the first real sandbox answer records its shape).
 * Callers never pass the email, the code, the state or a token.
 */
function answer(
  status: number,
  body: Readonly<Record<string, unknown>>,
  ref: string,
  outcome: string,
  facts: Facts = {},
  headers: Readonly<Record<string, string>> = {},
): Response {
  writeLog({ kind: "join", route: ROUTE, ref, status, outcome, ...facts });
  let cookies: string[] = [];
  try {
    cookies = [clearedTicketCookie()];
  } catch {
    // MEND_BASE_URL is unusable, so no cookie name can be chosen; the answer still goes out.
  }
  const response = reply(status, body, cookies);
  // The address PayPal sent the browser to carries the one-time code, so no Referer carries it on.
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("cache-control", "no-store");
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

function refusal(status: number, error: string, ref: string, outcome: string, facts: Facts = {}, headers: Readonly<Record<string, string>> = {}): Response {
  return answer(status, { error, message: MESSAGES[status] ?? MESSAGES[500], ref }, ref, outcome, facts, headers);
}

function engineAnswer(task: JoinIntent, waited: Waited, ref: string, facts: Facts): Response {
  const run = { ...facts, task, run_id: waited.runId };
  if (waited.state === "pending") return refusal(503, "engine_unavailable", ref, "engine_unavailable", { ...run, reason: "still_running" });
  if (waited.status === "failed" || waited.result === undefined) {
    return refusal(503, "engine_unavailable", ref, "engine_unavailable", { ...run, reason: "run_failed" });
  }
  const result = waited.result;
  if (!result.ok) {
    if (ENGINE_REFUSALS.has(result.error)) return refusal(409, result.error, result.ref, "refused", { ...run, error: result.error });
    return refusal(500, "internal", result.ref, "failed", { ...run, engine_error: result.error });
  }
  const body = successBody(task, result);
  if (body === null) return refusal(500, "internal", ref, "failed", { ...run, reason: "malformed_answer" });
  return answer(200, body, ref, task === "join" ? "joined" : "left", task === "join" ? { ...run, linked: body.linked } : run);
}

/**
 * PayPal's return from sign-in, a top-level GET from paypal.com. Every answer clears
 * the join cookie and carries Referrer-Policy no-referrer and Cache-Control no-store.
 * In this order: 429 past 20 a minute per client address; 400
 * bad_state, with nothing sent to PayPal, when the join cookie is missing, not signed by
 * this server, expired, or its state differs from ?state (compared in constant time);
 * 200 {outcome: "cancelled"} when PayPal sent ?error; 400 bad_request without exactly
 * one usable ?code. Otherwise the code is swapped for the customer's token, which lives
 * only in this function, userinfo is read with it, and the engine's join (with the
 * consent hash the cookie carried) or leave is handed exactly email, email_verified and
 * payer_id. Answers 200 {outcome: "joined", linked} or {outcome: "left"}; 409 with the
 * engine's refusal code; 502 paypal_unavailable when PayPal fails; 503 when the engine
 * has not answered within 20 seconds; 500 for anything else.
 */
export async function GET(request: Request): Promise<Response> {
  const ref = randomUUID();
  try {
    const hit = await takeHit(LIMITS.joinCallback, clientAddress(request.headers));
    if (!hit.allowed) {
      return refusal(429, "rate_limited", ref, "rate_limited", { bucket: LIMITS.joinCallback.bucket }, { "retry-after": String(hit.retryAfterSeconds) });
    }
    const params = new URL(request.url).searchParams;
    const reading = readTicket(request);
    if ("problem" in reading) return refusal(400, "bad_state", ref, "bad_state", { reason: reading.problem });
    const { ticket } = reading;
    const facts = { intent: ticket.intent };
    if (!stateMatches(ticket, oneQueryValue(params, "state"))) return refusal(400, "bad_state", ref, "bad_state", { ...facts, reason: "state_differs" });
    if (params.has("error")) {
      const reason = oneQueryValue(params, "error");
      return answer(200, { outcome: "cancelled" }, ref, "cancelled", { ...facts, paypal_error: reason !== null && PAYPAL_ERROR_CODE.test(reason) ? reason : "other" });
    }
    const code = oneQueryValue(params, "code");
    if (code === null) return refusal(400, "bad_request", ref, "bad_request", { ...facts, reason: "no_code" });

    let signedIn: IdentityReading;
    try {
      const userToken = await exchangeCode(code);
      signedIn = await readIdentity(userToken);
    } catch (error) {
      if (!(error instanceof LoginError)) throw error;
      const failure = {
        ...facts,
        reason: error.reason,
        paypal_status: error.status,
        paypal_error: error.paypalError,
        debug_id: error.debugId,
        userinfo_path: error.source,
        userinfo_fields: error.fields,
      };
      if (error.reason === "bad_code") return refusal(400, "bad_request", ref, "bad_request", failure);
      return refusal(502, "paypal_unavailable", ref, "paypal_unavailable", failure);
    }

    const seen = { ...facts, userinfo_path: signedIn.source, userinfo_fields: signedIn.fields, payer_id_kept: signedIn.identity.payer_id !== null };
    const args = ticket.intent === "join" ? [signedIn.identity, ticket.consent] : [signedIn.identity];
    return engineAnswer(ticket.intent, await runAndWait(ticket.intent, args, WAIT_MS), ref, seen);
  } catch (error) {
    const unavailable = error instanceof EngineUnavailable;
    return refusal(unavailable ? 503 : 500, unavailable ? "engine_unavailable" : "internal", ref, "failed", { exception: error instanceof Error ? error.name : "unknown" });
  }
}
