/**
 * Guards for every request that changes state (C18, C24), and the bounded JSON body
 * such a request may carry.
 *
 * Two checks, both required. Same origin: the Origin header must be exactly the
 * origin of MEND_BASE_URL, compared after both go through the same URL parser; the
 * Host and X-Forwarded-* headers are never consulted. Token: the x-mend-csrf header
 * must equal an HMAC, keyed with MEND_CSRF_SECRET, of what the request's cookies bind
 * it to, compared in constant time. A signed-in browser's token is bound to its
 * session id hash, so a token from one session fails in every other. A browser not
 * yet signed in holds a random anonymous id in the mend_csrf cookie and its token is
 * bound to that, which keeps sign-in itself guarded. A page on another site can make
 * a browser send our cookies but can neither read the token nor set our header, and
 * it cannot forge Origin.
 *
 * Covers cross-site form posts, cross-site fetches, login CSRF and a token carried
 * from one session into another. Does not cover script running on our own origin
 * (that is C14's job) or a request with no browser involved, which carries no session
 * cookie of a victim to abuse.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { baseUrl, cookieHeader, readCookie, secureCookies, sessionCookieName } from "./auth";
import { ConfigError } from "./config";
import { isSessionToken, SESSION_ABSOLUTE_MS, sessionIdFor } from "./sessions";
import { parseStrictJson, StrictJsonError } from "./strict-json";

export const CSRF_HEADER = "x-mend-csrf";
export const ANONYMOUS_CSRF_COOKIE = "mend_csrf";
export const SECURE_ANONYMOUS_CSRF_COOKIE = "__Host-mend_csrf";
export const MIN_CSRF_SECRET_BYTES = 32;

const CSRF_TOKEN = /^c2\.[A-Za-z0-9_-]{43}$/;
const ANONYMOUS_ID = /^a1\.[A-Za-z0-9_-]{43}$/;
const SESSION_ID = /^[0-9a-f]{64}$/;

export type GuardProblem = "missing_origin" | "bad_origin" | "foreign_origin" | "missing_token" | "token_mismatch";

/** What a token is bound to: a session id hash, or the hash of the browser's anonymous id. */
export type CsrfBinding = { readonly kind: "session" | "anonymous"; readonly id: string };

/**
 * MEND_CSRF_SECRET as bytes. Throws ConfigError when it is missing or shorter than 32
 * bytes, so every token is refused rather than signed with a guessable key.
 */
export function csrfSecret(): Buffer {
  const secret = Buffer.from(process.env.MEND_CSRF_SECRET ?? "", "utf8");
  if (secret.byteLength < MIN_CSRF_SECRET_BYTES) throw new ConfigError("MEND_CSRF_SECRET must be at least 32 bytes");
  return secret;
}

/** The anonymous id cookie's name: __Host-mend_csrf over https, mend_csrf only over plain http in development. */
export function anonymousCsrfCookieName(): string {
  return secureCookies() ? SECURE_ANONYMOUS_CSRF_COOKIE : ANONYMOUS_CSRF_COOKIE;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The token for binding: "c2." and the base64url HMAC-SHA256 of its kind and id. */
export function csrfTokenFor(binding: CsrfBinding): string {
  // The kind is part of the signed text, so an anonymous token can never pass as a session's.
  const mac = createHmac("sha256", csrfSecret()).update(`mend-csrf\n${binding.kind}\n${binding.id}`, "utf8").digest("base64url");
  return `c2.${mac}`;
}

/** The token for a session, by its id hash (64 lowercase hex). Throws for any other shape. */
export function csrfTokenForSession(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error("a session id is 64 lowercase hex characters");
  return csrfTokenFor({ kind: "session", id: sessionId });
}

/**
 * What this request's token must be bound to: its session cookie when it holds one of
 * the right shape, live or not, otherwise its anonymous id cookie, otherwise null.
 * Liveness is authorize()'s question; asking it here too would make a browser whose
 * session lapsed unable to sign in again until its cookie expired.
 */
export function csrfBinding(request: Request): CsrfBinding | null {
  const token = readCookie(request, sessionCookieName());
  if (token !== null && isSessionToken(token)) return { kind: "session", id: sessionIdFor(token) };
  const anonymous = readCookie(request, anonymousCsrfCookieName());
  if (anonymous !== null && ANONYMOUS_ID.test(anonymous)) return { kind: "anonymous", id: sha256(anonymous) };
  return null;
}

/**
 * The token this browser's pages send back, and any cookie needed to make it valid: a
 * browser with nothing to bind to gets a new anonymous id ("a1." and 32 random bytes)
 * in a cookie that lives as long as a session can.
 */
export function csrfTokenForRequest(request: Request): { readonly token: string; readonly cookies: readonly string[] } {
  const binding = csrfBinding(request);
  if (binding !== null) return { token: csrfTokenFor(binding), cookies: [] };
  const anonymous = `a1.${randomBytes(32).toString("base64url")}`;
  return {
    token: csrfTokenFor({ kind: "anonymous", id: sha256(anonymous) }),
    cookies: [cookieHeader(anonymousCsrfCookieName(), anonymous, SESSION_ABSOLUTE_MS / 1000)],
  };
}

/** Why the Origin header is not exactly this app's own origin, or null when it is. */
export function originProblem(request: Request): GuardProblem | null {
  const origin = request.headers.get("origin");
  if (origin === null) return "missing_origin";
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return "bad_origin";
  }
  // A real Origin is a bare origin; anything with a path, credentials or "null" is refused.
  if (parsed.origin !== origin) return "bad_origin";
  return parsed.origin === baseUrl().origin ? null : "foreign_origin";
}

/** Why the header token is not the one this request's cookies bind it to, or null when it is. */
export function tokenProblem(request: Request): GuardProblem | null {
  const header = request.headers.get(CSRF_HEADER);
  const binding = csrfBinding(request);
  if (header === null || !CSRF_TOKEN.test(header) || binding === null) return "missing_token";
  // Both are "c2." and 43 characters, so the buffers have the length timingSafeEqual needs.
  return timingSafeEqual(Buffer.from(header, "utf8"), Buffer.from(csrfTokenFor(binding), "utf8")) ? null : "token_mismatch";
}

/** Both guards, origin first. Null means the request may change state. */
export function stateChangeProblem(request: Request): GuardProblem | null {
  return originProblem(request) ?? tokenProblem(request);
}

export type BodyProblem = "not_json" | "too_large" | "syntax" | "duplicate_key" | "too_deep";

export type BodyReading = { readonly body: unknown } | { readonly problem: BodyProblem };

/**
 * The request body parsed as strict JSON: content type application/json, at most
 * maxBytes, no repeated key at any depth. Stops reading as soon as the cap is passed,
 * so a huge or endless body costs no more than maxBytes.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<BodyReading> {
  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { problem: "not_json" };
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return { problem: "too_large" };
  if (request.body === null) return { problem: "syntax" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { problem: "too_large" };
    }
    chunks.push(value);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return { problem: "syntax" };
  }
  try {
    return { body: parseStrictJson(text) };
  } catch (error) {
    return { problem: error instanceof StrictJsonError ? error.problem : "syntax" };
  }
}
