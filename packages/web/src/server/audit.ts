/**
 * The website's rows in the append-only audit log (C17, C23), each with actor "web".
 *
 * A detail is flat: each key a plain lowercase name, each value a short code, a finite
 * number, true, false or null. A string value may hold only letters, digits, "_" and
 * "-", at most 40 of them, and must not contain the value of any secret setting. That
 * rule admits ids, roles, outcomes, bucket names, reason codes and the 12-character
 * address and session tags, and keeps out every email ("@"), every token this app
 * issues ("s1.", "c2." and "a1." carry a dot), every 64-hex session id (too long), any
 * secret, and any free text (spaces). It does not keep out a short single word that
 * happens to be a name: callers pass only values their own code chose.
 *
 * Two forms. With a client, the row is written inside the caller's transaction and any
 * failure, a refused detail included, throws, so the action it records fails with it.
 * Without one, the row is written on its own and a failure only writes one error log
 * line, for records of reads and refusals whose answer must not change.
 */
import type { PoolClient } from "pg";
import { database } from "./db";
import { writeLog } from "./log";
import { secretValues } from "./secrets";

export type AuditDetail = Readonly<Record<string, string | number | boolean | null>>;

export const ACTOR = "web";
const NAME = /^[a-z][a-z_]{0,39}$/;
const VALUE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_KEYS = 16;
const INSERT = "insert into audit_log (actor, action, detail) values ($1, $2, $3::jsonb)";

/** A detail or action this file will not write; problem is a fixed code, never the value. */
export class AuditRefused extends Error {
  constructor(readonly problem: "action" | "key" | "value" | "secret" | "size") {
    super(`audit row refused: ${problem}`);
    this.name = "AuditRefused";
  }
}

function holdsSecret(text: string): boolean {
  return secretValues().some((value) => text.includes(value));
}

function check(action: string, detail: AuditDetail): void {
  if (!NAME.test(action)) throw new AuditRefused("action");
  const entries = Object.entries(detail);
  if (entries.length > MAX_KEYS) throw new AuditRefused("size");
  for (const [key, value] of entries) {
    if (!NAME.test(key)) throw new AuditRefused("key");
    const allowed =
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && VALUE.test(value));
    if (!allowed) throw new AuditRefused("value");
    if (typeof value === "string" && holdsSecret(value)) throw new AuditRefused("secret");
  }
}

/**
 * Append one audit row for action with detail, actor "web".
 *
 * With options.client: the row is inserted on that client, inside whatever transaction
 * it holds. Throws AuditRefused, before any query, for an action or detail outside the
 * rule above, and throws any database error.
 *
 * Without a client: never throws. A refused detail or a failed insert writes one log
 * line (kind "audit", outcome "not_written", the action when it is a plain name, and a
 * reason code) and nothing else.
 */
export async function appendAudit(action: string, detail: AuditDetail, options: { readonly client?: PoolClient } = {}): Promise<void> {
  if (options.client !== undefined) {
    check(action, detail);
    await options.client.query(INSERT, [ACTOR, action, JSON.stringify(detail)]);
    return;
  }
  try {
    check(action, detail);
    await database().query(INSERT, [ACTOR, action, JSON.stringify(detail)]);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    writeLog({
      kind: "audit",
      outcome: "not_written",
      action: NAME.test(action) ? action : "unknown",
      reason: error instanceof AuditRefused ? "refused" : "db_error",
      problem: error instanceof AuditRefused ? error.problem : null,
      code: typeof code === "string" ? code : null,
    });
  }
}

/**
 * Run work on one client inside one transaction and commit it, so writes made there and
 * the audit row recording them (appendAudit with that client) land together or not at
 * all. Rolls back and rethrows when work or the commit fails.
 */
export async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
