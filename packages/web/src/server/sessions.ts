/**
 * Console sessions, stored in Postgres (C18, C19).
 *
 * The browser holds a token: "s1." and 32 random bytes in base64url. The database
 * holds only its SHA-256 (session_id), so the token is never stored, never equals any
 * record id, and a leaked row cannot be replayed as a cookie. A session ends 2 hours
 * after it was last used or 24 hours after it began, whichever comes first; every
 * read checks both limits in the same statement that records the use.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { database } from "./db";

export type Role = "owner" | "demo";

export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 24 * 60 * 60 * 1000;

const TOKEN_SHAPE = /^s1\.[A-Za-z0-9_-]{43}$/;
const ROLES: readonly Role[] = ["owner", "demo"];

export type Session = {
  readonly sessionId: string;
  readonly role: Role;
  readonly expiresAt: Date;
};

/** A session just created. token is not enumerable, so logging the object never prints it. */
export type IssuedSession = Session & { readonly token: string };

/** True when text has the exact shape of a session token. */
export function isSessionToken(text: string): boolean {
  return TOKEN_SHAPE.test(text);
}

/** The stored id for a token: its SHA-256 in lowercase hex. */
export function sessionIdFor(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function asRole(value: unknown): Role | null {
  return ROLES.find((role) => role === value) ?? null;
}

// The caller's client when it passes one, so the write joins its transaction; the shared pool otherwise.
function on(client: PoolClient | undefined): Pick<Pool, "query"> {
  return client ?? database();
}

/**
 * Create a session for role and return it with its token. Sessions past either limit
 * are deleted in the same call, so the table holds only live ones plus at most a
 * day of stragglers. Given a client, both writes run on it, inside whatever
 * transaction it holds.
 */
export async function createSession(role: Role, client?: PoolClient): Promise<IssuedSession> {
  const token = `s1.${randomBytes(32).toString("base64url")}`;
  const sessionId = sessionIdFor(token);
  const pool = on(client);
  await pool.query(
    "delete from sessions where expires_at <= now() or last_seen_at <= now() - make_interval(secs => $1)",
    [SESSION_IDLE_MS / 1000],
  );
  const { rows } = await pool.query<{ expires_at: Date }>(
    "insert into sessions (session_id, role, expires_at) values ($1, $2, now() + make_interval(secs => $3)) returning expires_at",
    [sessionId, role, SESSION_ABSOLUTE_MS / 1000],
  );
  const session = { sessionId, role, expiresAt: rows[0].expires_at } as IssuedSession;
  Object.defineProperty(session, "token", { value: token, enumerable: false });
  return Object.freeze(session);
}

/**
 * The live session for token, recording this use, or null. A token of the wrong
 * shape is refused before any query; a session past its idle or absolute limit, or
 * one that was ended, gives null.
 */
export async function readSession(token: string | null): Promise<Session | null> {
  if (token === null || !isSessionToken(token)) return null;
  const sessionId = sessionIdFor(token);
  const { rows } = await database().query<{ role: string; expires_at: Date }>(
    `update sessions set last_seen_at = now()
      where session_id = $1 and expires_at > now() and last_seen_at > now() - make_interval(secs => $2)
      returning role, expires_at`,
    [sessionId, SESSION_IDLE_MS / 1000],
  );
  const role = asRole(rows[0]?.role);
  if (rows.length !== 1 || role === null) return null;
  return Object.freeze({ sessionId, role, expiresAt: rows[0].expires_at });
}

/** Delete the session for token, if any, on client when one is given. A token of the wrong shape is ignored. */
export async function endSession(token: string | null, client?: PoolClient): Promise<void> {
  if (token === null || !isSessionToken(token)) return;
  await on(client).query("delete from sessions where session_id = $1", [sessionIdFor(token)]);
}
