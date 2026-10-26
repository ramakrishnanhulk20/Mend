/**
 * Log in with PayPal for Mend's join link: where the browser is sent, the signed
 * cookie that carries one sign-in there and back, and the two server calls that turn
 * PayPal's one-time code into the three facts Mend hands on.
 *
 * Only email, email_verified and payer_id ever leave this module (C15). The
 * customer's PayPal token is an argument and a return value, sent only to the sandbox
 * userinfo address, and never stored, logged or put in an error (C17). The browser is
 * sent only to www.sandbox.paypal.com, and server calls go only to the sandbox API host
 * through sandboxUrl() (C16). Errors are fixed sentences with a reason code; PayPal's
 * own words never reach a log or an answer.
 *
 * The cookie is the only record of a sign-in in progress, so a restart loses nothing.
 * It is signed with MEND_CSRF_SECRET under its own label, so no CSRF token or other
 * value this app signs can pass for it. Covers a forged or edited cookie, a late
 * return, and a return to a browser that did not start the sign-in. Does not cover a
 * person handing their own cookie and PayPal code to someone else, which gains that
 * someone nothing the person could not do themselves.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { baseUrl, cookieHeader, readCookie, secureCookies } from "./auth";
import { loadConfig } from "./config";
import { csrfSecret } from "./csrf";
import { HostRefused, PAYPAL_TIMEOUT_MS, sandboxUrl } from "./paypal";
import { parseStrictJson } from "./strict-json";

export const SANDBOX_WEB_HOST = "www.sandbox.paypal.com";
export const CONNECT_PATH = "/connect";
export const LOGIN_SCOPE = "openid email https://uri.paypal.com/services/paypalattributes";
export const CALLBACK_PATH = "/api/join/paypal/callback";
/** The join cookie's name over plain http to this machine in development. */
export const JOIN_COOKIE = "mend_join";
/** The join cookie's name whenever MEND_BASE_URL is https. */
export const SECURE_JOIN_COOKIE = "__Host-mend_join";
export const JOIN_TICKET_SECONDS = 600;

const TOKEN_PATH = "/v1/oauth2/token";
const USERINFO_PATH = "/v1/identity/oauth2/userinfo?schema=paypalv1.1";
const USERINFO_FALLBACK_PATH = "/v1/identity/openidconnect/userinfo?schema=openid";
const MAX_REPLY_CHARS = 65_536;
const MAX_FIELD_NAMES = 50;
const MAX_EMAIL_CHARS = 254;
const TICKET_VERSION = "j1";
const TICKET_LABEL = "mend-join";

const STATE = /^[A-Za-z0-9_-]{43}$/;
const CONSENT_HASH = /^[0-9a-f]{64}$/;
const EXPIRY = /^[1-9][0-9]{0,11}$/;
const MAC = /^[A-Za-z0-9_-]{43}$/;
const AUTH_CODE = /^[\x21-\x7e]{1,2048}$/;
const USER_TOKEN = /^[\x21-\x7e]{1,8192}$/;
const PAYER_ID = /^[A-Z0-9]{13}$/;
const EMAIL = /^[^\s@\p{Cc}\p{Cf}]{1,64}@[^\s@\p{Cc}\p{Cf}]{1,253}$/u;
const FIELD_NAME = /^[A-Za-z0-9_]{1,64}$/;
const ERROR_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const DEBUG_ID = /^[A-Za-z0-9]{1,64}$/;

export type JoinIntent = "join" | "leave";

/** One sign-in in progress, as its cookie carries it. */
export type JoinTicket = {
  readonly state: string;
  readonly intent: JoinIntent;
  /** The consent hash the customer was shown, for a join; null for a leave. */
  readonly consent: string | null;
  /** Unix time in seconds from which the ticket is refused. */
  readonly expiresAt: number;
};

export type TicketProblem = "missing" | "malformed" | "bad_mac" | "expired";

export type UserinfoSource = "paypalv1.1" | "openid";

/** Exactly the three facts Mend hands on from a sign-in, and nothing else PayPal said. */
export type Identity = { readonly email: string; readonly email_verified: boolean; readonly payer_id: string | null };

export type IdentityReading = {
  readonly identity: Identity;
  /** The top-level field names PayPal answered with, sorted: names only, never values (ruling 3). */
  readonly fields: readonly string[];
  readonly source: UserinfoSource;
};

export type LoginFailure =
  | "bad_code"
  | "paypal_unreachable"
  | "reply_too_large"
  | "token_refused"
  | "token_unusable"
  | "userinfo_refused"
  | "userinfo_unusable";

const FAILURES: Readonly<Record<LoginFailure, string>> = {
  bad_code: "the sign-in code has characters PayPal never issues",
  paypal_unreachable: "PayPal did not answer in time or could not be reached",
  reply_too_large: "PayPal's answer was larger than any sign-in answer",
  token_refused: "PayPal refused to swap the sign-in code for a token",
  token_unusable: "the token answer had no usable access token",
  userinfo_refused: "PayPal refused to say who signed in",
  userinfo_unusable: "PayPal's answer about who signed in had no usable email or email_verified",
};

type Reply = { readonly status: number; readonly body: unknown; readonly debugId: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: unknown, key: string): unknown {
  return isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function shaped(value: unknown, shape: RegExp): string | null {
  return typeof value === "string" && shape.test(value) ? value : null;
}

function fieldNames(body: unknown): readonly string[] {
  if (!isRecord(body)) return [];
  return Object.keys(body)
    .filter((name) => FIELD_NAME.test(name))
    .sort()
    .slice(0, MAX_FIELD_NAMES);
}

/** A sign-in step failed. Carries a reason code and PayPal's status, error name and debug id when known; never PayPal's text or a token. */
export class LoginError extends Error {
  readonly reason: LoginFailure;
  readonly status: number | null;
  readonly paypalError: string | null;
  readonly debugId: string | null;
  /** For a userinfo answer that was a JSON object, its field names (names only); otherwise null. */
  readonly fields: readonly string[] | null;
  readonly source: UserinfoSource | null;

  constructor(reason: LoginFailure, reply: Reply | null = null, source: UserinfoSource | null = null) {
    super(FAILURES[reason]);
    this.name = "LoginError";
    this.reason = reason;
    this.status = reply?.status ?? null;
    this.paypalError = shaped(own(reply?.body, "error"), ERROR_NAME) ?? shaped(own(reply?.body, "name"), ERROR_NAME);
    this.debugId = reply?.debugId ?? null;
    this.fields = source !== null && reply !== null && isRecord(reply.body) ? fieldNames(reply.body) : null;
    this.source = source;
  }
}

/** The address PayPal sends the browser back to: MEND_BASE_URL's origin and /api/join/paypal/callback (C24). */
export function callbackUrl(): string {
  return new URL(CALLBACK_PATH, baseUrl()).href;
}

/**
 * The address that sends the browser to PayPal's sandbox sign-in for state. Query, in
 * this order and each percent-encoded: flowEntry=static, the app's client id,
 * response_type=code, the three scopes, the callback address, state, fullPage=true.
 * Throws Error for a state that is not 43 base64url characters, and HostRefused if the
 * result is anything but https on www.sandbox.paypal.com/connect with no port or
 * userinfo.
 */
export function connectUrl(state: string): URL {
  if (!STATE.test(state)) throw new Error("a join state is 43 base64url characters");
  const query = [
    ["flowEntry", "static"],
    ["client_id", loadConfig().paypal.clientId],
    ["response_type", "code"],
    ["scope", LOGIN_SCOPE],
    ["redirect_uri", callbackUrl()],
    ["state", state],
    ["fullPage", "true"],
  ]
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("&");
  const url = new URL(`https://${SANDBOX_WEB_HOST}${CONNECT_PATH}?${query}`);
  const exact =
    url.protocol === "https:" &&
    url.hostname === SANDBOX_WEB_HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === CONNECT_PATH;
  if (!exact) throw new HostRefused("the sign-in address is not PayPal's sandbox sign-in page");
  return url;
}

/** __Host-mend_join over https; mend_join only over plain http to this machine in development. */
export function joinCookieName(): string {
  return secureCookies() ? SECURE_JOIN_COOKIE : JOIN_COOKIE;
}

function ticketBody(ticket: JoinTicket): string {
  return [TICKET_VERSION, ticket.state, ticket.intent, ticket.consent ?? "", String(ticket.expiresAt)].join(".");
}

function ticketMac(body: string): string {
  return createHmac("sha256", csrfSecret()).update(`${TICKET_LABEL}\n${body}`, "utf8").digest("base64url");
}

/**
 * Start one sign-in: a new random state (32 bytes, base64url) and the Set-Cookie value
 * carrying it with intent, consent and an expiry 600 seconds after now, followed by an
 * HMAC-SHA256 over all four keyed with MEND_CSRF_SECRET. The cookie is HttpOnly,
 * SameSite=Lax (PayPal's return is a top-level GET from paypal.com), Path=/,
 * Max-Age=600, and Secure over https. Throws Error unless a join carries a consent hash
 * (64 lowercase hex) and a leave carries none, and ConfigError when MEND_CSRF_SECRET or
 * MEND_BASE_URL is unusable.
 */
export function issueTicket(
  intent: JoinIntent,
  consent: string | null,
  now: number = Date.now(),
): { readonly ticket: JoinTicket; readonly cookie: string } {
  const fits = intent === "join" ? consent !== null && CONSENT_HASH.test(consent) : intent === "leave" && consent === null;
  if (!fits) throw new Error("a join carries a consent hash and a leave carries none");
  const ticket: JoinTicket = {
    state: randomBytes(32).toString("base64url"),
    intent,
    consent,
    expiresAt: Math.floor(now / 1000) + JOIN_TICKET_SECONDS,
  };
  const body = ticketBody(ticket);
  return { ticket, cookie: cookieHeader(joinCookieName(), `${body}.${ticketMac(body)}`, JOIN_TICKET_SECONDS) };
}

/** The Set-Cookie value that removes the join cookie. */
export function clearedTicketCookie(): string {
  return cookieHeader(joinCookieName(), "", 0);
}

/**
 * The sign-in this browser started, read from its join cookie. Refused as missing when
 * there is no cookie or more than one, malformed when any part has the wrong shape,
 * bad_mac when the signature is not this server's (compared in constant time), and
 * expired from its expiry second on. Throws ConfigError when MEND_CSRF_SECRET is unusable.
 */
export function readTicket(
  request: Request,
  now: number = Date.now(),
): { readonly ticket: JoinTicket } | { readonly problem: TicketProblem } {
  const value = readCookie(request, joinCookieName());
  if (value === null || value === "") return { problem: "missing" };
  const parts = value.split(".");
  if (parts.length !== 6) return { problem: "malformed" };
  const [version, state, intent, consent, expiry, mac] = parts;
  const intentFits = (intent === "join" && CONSENT_HASH.test(consent)) || (intent === "leave" && consent === "");
  if (version !== TICKET_VERSION || !STATE.test(state) || !intentFits || !EXPIRY.test(expiry) || !MAC.test(mac)) {
    return { problem: "malformed" };
  }
  const ticket: JoinTicket = { state, intent: intent === "join" ? "join" : "leave", consent: intent === "join" ? consent : null, expiresAt: Number(expiry) };
  // Rebuilt from the parsed parts by the function that signed it, so what is checked is what is used.
  const expected = ticketMac(ticketBody(ticket));
  if (!timingSafeEqual(Buffer.from(mac, "utf8"), Buffer.from(expected, "utf8"))) return { problem: "bad_mac" };
  if (now >= ticket.expiresAt * 1000) return { problem: "expired" };
  return { ticket };
}

/** True only when presented is exactly the ticket's state, compared in constant time. */
export function stateMatches(ticket: JoinTicket, presented: string | null): boolean {
  if (presented === null || !STATE.test(presented)) return false;
  return timingSafeEqual(Buffer.from(presented, "utf8"), Buffer.from(ticket.state, "utf8"));
}

/** The value of query parameter name when it appears exactly once, otherwise null. */
export function oneQueryValue(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : null;
}

async function send(url: URL, init: { readonly method: "GET" | "POST"; readonly headers: Record<string, string>; readonly body?: string }): Promise<Reply> {
  let response: Response;
  let text: string;
  try {
    // One signal covers the headers and the body, so the whole exchange is capped.
    response = await globalThis.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(PAYPAL_TIMEOUT_MS) });
    text = await response.text();
  } catch {
    throw new LoginError("paypal_unreachable");
  }
  const headerDebugId = shaped(response.headers.get("paypal-debug-id"), DEBUG_ID);
  if (text.length > MAX_REPLY_CHARS) throw new LoginError("reply_too_large", { status: response.status, body: null, debugId: headerDebugId });
  let body: unknown = null;
  if (text !== "") {
    try {
      // A repeated key could be read one way here and another way by PayPal's own tools.
      body = parseStrictJson(text);
    } catch {
      body = null;
    }
  }
  return { status: response.status, body, debugId: headerDebugId ?? shaped(own(body, "debug_id"), DEBUG_ID) };
}

/**
 * Swap PayPal's one-time sign-in code for the customer's access token.
 *
 * POST /v1/oauth2/token on the sandbox API with the app's Basic credentials and the
 * form body grant_type=authorization_code, code, and redirect_uri set to the same
 * callback address the sign-in link carried. Redirects are refused and the whole
 * exchange has 15 seconds. Returns the access token, for the caller to hold in a local
 * variable and hand only to readIdentity. Throws LoginError: bad_code before anything
 * is sent for a code that is not 1 to 2048 printable characters; paypal_unreachable;
 * reply_too_large; token_refused for any status but 200; token_unusable when
 * access_token is missing or not 1 to 8192 printable characters.
 */
export async function exchangeCode(code: string): Promise<string> {
  if (typeof code !== "string" || !AUTH_CODE.test(code)) throw new LoginError("bad_code");
  const { clientId, clientSecret } = loadConfig().paypal;
  const reply = await send(sandboxUrl(TOKEN_PATH), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callbackUrl() }).toString(),
  });
  if (reply.status !== 200) throw new LoginError("token_refused", reply);
  const token = own(reply.body, "access_token");
  if (typeof token !== "string" || !USER_TOKEN.test(token)) throw new LoginError("token_unusable", reply);
  return token;
}

function askUserinfo(path: string, userToken: string): Promise<Reply> {
  return send(sandboxUrl(path), { method: "GET", headers: { Accept: "application/json", Authorization: `Bearer ${userToken}` } });
}

// schema=paypalv1.1 answers "emails": [{value, primary, confirmed}] in place of OpenID's
// email and email_verified (first seen live on 26 Oct 2026), and PayPal's older schemas
// write such flags as true or "true". The primary address is the one used; with no
// primary, only a lone address is.
function flag(value: unknown): boolean {
  return value === true || value === "true";
}

function emailOf(body: Record<string, unknown>): { readonly email: unknown; readonly verified: unknown } {
  const list = own(body, "emails");
  if (!Array.isArray(list)) return { email: own(body, "email"), verified: own(body, "email_verified") };
  const entries = list.filter(isRecord);
  const primary = entries.filter((entry) => flag(own(entry, "primary")));
  const chosen = primary.length === 1 ? primary[0] : primary.length === 0 && entries.length === 1 ? entries[0] : null;
  return chosen === null ? { email: undefined, verified: undefined } : { email: own(chosen, "value"), verified: flag(own(chosen, "confirmed")) };
}

/**
 * Ask PayPal who signed in, with the customer's own token as the Bearer.
 *
 * GET /v1/identity/oauth2/userinfo?schema=paypalv1.1, and only when that answers 404,
 * GET /v1/identity/openidconnect/userinfo?schema=openid. Returns a new object holding
 * exactly email, email_verified and payer_id (from emailOf), where payer_id is null unless PayPal sent
 * 13 capital letters or digits; every other field is dropped here. Throws LoginError:
 * token_unusable before anything is sent for a token with spaces or control
 * characters; paypal_unreachable; reply_too_large; userinfo_refused for any status but
 * 200 or a body that is not one JSON object without repeated keys; userinfo_unusable
 * when email is not an address of at most 254 characters or email_verified is not
 * true or false.
 */
export async function readIdentity(userToken: string): Promise<IdentityReading> {
  if (typeof userToken !== "string" || !USER_TOKEN.test(userToken)) throw new LoginError("token_unusable");
  let source: UserinfoSource = "paypalv1.1";
  let reply = await askUserinfo(USERINFO_PATH, userToken);
  if (reply.status === 404) {
    source = "openid";
    reply = await askUserinfo(USERINFO_FALLBACK_PATH, userToken);
  }
  if (reply.status !== 200 || !isRecord(reply.body)) throw new LoginError("userinfo_refused", reply, source);
  const { email, verified } = emailOf(reply.body);
  if (typeof email !== "string" || email.length > MAX_EMAIL_CHARS || !EMAIL.test(email) || typeof verified !== "boolean") {
    throw new LoginError("userinfo_unusable", reply, source);
  }
  const payerId = own(reply.body, "payer_id");
  return {
    identity: { email, email_verified: verified, payer_id: typeof payerId === "string" && PAYER_ID.test(payerId) ? payerId : null },
    fields: fieldNames(reply.body),
    source,
  };
}
