/**
 * Who is calling, and the cookies that say so (C18, C24).
 *
 * Owner and demo are separate principals. The owner signs in with MEND_OWNER_PASSWORD,
 * compared in constant time; a demo session needs no password. Every sign-in ends the
 * session the browser already had and issues a new token, so a token planted before
 * sign-in is worthless after it. Cookies are HttpOnly, SameSite=Lax, Path=/ and Secure,
 * except over plain http to this machine in development. Over https the session cookie
 * is __Host-mend_session: browsers accept that name only with Secure, Path=/ and no
 * Domain, so a sibling host cannot plant or overwrite it.
 *
 * The app's own address comes from MEND_BASE_URL, never from Host or X-Forwarded-*
 * headers, so a request cannot change what the server believes its origin is.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { PoolClient } from "pg";
import { ConfigError } from "./config";
import { createSession, endSession, readSession, SESSION_ABSOLUTE_MS, type IssuedSession, type Role } from "./sessions";

/** The session cookie's name over plain http to this machine in development. */
export const SESSION_COOKIE = "mend_session";
/** The session cookie's name whenever MEND_BASE_URL is https. */
export const SECURE_SESSION_COOKIE = "__Host-mend_session";
const HOST_PREFIX = "__Host-";
export const MIN_OWNER_PASSWORD_CHARS = 16;
export const MAX_PASSWORD_CHARS = 1024;

const COOKIE_PART = /^[A-Za-z0-9._-]+$/;

/** MEND_DEV read the way the engine reads it: "1" or "true" is on; unset, "", "0" or "false" is off. */
export function devMode(): boolean {
  const raw = process.env.MEND_DEV?.trim();
  if (raw === undefined || raw === "" || raw === "0" || raw.toLowerCase() === "false") return false;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  throw new ConfigError("MEND_DEV must be 1, 0, true or false");
}

/**
 * True for this machine's own addresses: "localhost", 127.0.0.0/8 and ::1. Takes a
 * hostname as the URL parser gives it (IPv6 in brackets).
 */
export function isLoopback(hostname: string): boolean {
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (host === "localhost") return true;
  if (isIP(host) === 4) return host.split(".")[0] === "127";
  if (isIP(host) !== 6) return false;
  try {
    // The URL parser writes every spelling of ::1 the same way.
    return new URL(`http://[${host}]/`).hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * MEND_BASE_URL, parsed. Throws ConfigError unless it is a bare origin (no path,
 * query, fragment or credentials) on https, or on http only for a loopback host while
 * MEND_DEV is on.
 */
export function baseUrl(): URL {
  const raw = process.env.MEND_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw ?? "");
  } catch {
    throw new ConfigError("MEND_BASE_URL must be the app's own https origin");
  }
  const bare = url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "";
  const scheme = url.protocol === "https:" || (url.protocol === "http:" && devMode() && isLoopback(url.hostname));
  if (!bare || !scheme) throw new ConfigError("MEND_BASE_URL must be the app's own https origin");
  return url;
}

/** Cookies carry Secure unless the app is served over plain http to this machine in development. */
export function secureCookies(): boolean {
  return baseUrl().protocol === "https:";
}

/** __Host-mend_session over https; mend_session only over plain http to this machine in development. */
export function sessionCookieName(): string {
  return secureCookies() ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}

/**
 * The value of cookie name, or null when it is missing or sent more than once. Two
 * copies mean a second cookie was planted (for example from a sibling host), and
 * neither copy is trusted.
 */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  const values: string[] = [];
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at !== -1 && part.slice(0, at).trim() === name) values.push(part.slice(at + 1).trim());
  }
  return values.length === 1 ? values[0] : null;
}

/** A Set-Cookie header value with this app's flags. Throws if name or value hold anything but token characters. */
export function cookieHeader(name: string, value: string, maxAgeSeconds: number): string {
  if (!COOKIE_PART.test(name) || (value !== "" && !COOKIE_PART.test(value)) || !Number.isInteger(maxAgeSeconds)) {
    throw new Error("cookie name or value has characters this app never issues");
  }
  // A browser silently drops a __Host- cookie without Secure, which would sign everyone out.
  if (name.startsWith(HOST_PREFIX) && !secureCookies()) throw new Error("a __Host- cookie needs https");
  const parts = [`${name}=${value}`, "Path=/", `Max-Age=${Math.max(maxAgeSeconds, 0)}`, "HttpOnly", "SameSite=Lax"];
  if (secureCookies()) parts.push("Secure");
  return parts.join("; ");
}

/**
 * True only when given equals MEND_OWNER_PASSWORD. Both sides are hashed to the same
 * length and compared in constant time, so the answer time says nothing about how
 * much of a guess was right. Throws ConfigError when the password is not set or is
 * shorter than 16 characters, so a missing setting refuses every owner sign-in.
 */
export function ownerPasswordMatches(given: unknown): boolean {
  const expected = process.env.MEND_OWNER_PASSWORD ?? "";
  if (expected.length < MIN_OWNER_PASSWORD_CHARS) {
    throw new ConfigError("MEND_OWNER_PASSWORD is not set or shorter than 16 characters");
  }
  const usable = typeof given === "string" && given.length > 0 && given.length <= MAX_PASSWORD_CHARS;
  const guess = createHash("sha256").update(usable ? given : "", "utf8").digest();
  const truth = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(guess, truth) && usable;
}

export type Principal =
  | { readonly role: Role; readonly sessionId: string; readonly expiresAt: Date }
  | { readonly role: "anonymous" };

/** The principal behind this request's session cookie, recording the use, or anonymous. */
export async function currentPrincipal(request: Request): Promise<Principal> {
  const session = await readSession(readCookie(request, sessionCookieName()));
  if (session === null) return { role: "anonymous" };
  return { role: session.role, sessionId: session.sessionId, expiresAt: session.expiresAt };
}

/**
 * End whatever session the browser holds, start a new one for role, and return it
 * with the Set-Cookie value that hands the browser its new token. Given a client, both
 * writes run on it, so the caller's transaction commits or undoes them together with
 * its own writes.
 */
export async function startSession(
  request: Request,
  role: Role,
  client?: PoolClient,
): Promise<{ readonly session: IssuedSession; readonly cookie: string }> {
  await endSession(readCookie(request, sessionCookieName()), client);
  const session = await createSession(role, client);
  return { session, cookie: cookieHeader(sessionCookieName(), session.token, SESSION_ABSOLUTE_MS / 1000) };
}

/** End the browser's session, on client when one is given, and return the Set-Cookie value that clears it. */
export async function endCurrentSession(request: Request, client?: PoolClient): Promise<string> {
  await endSession(readCookie(request, sessionCookieName()), client);
  return cookieHeader(sessionCookieName(), "", 0);
}
