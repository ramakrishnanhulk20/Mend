/**
 * The web app's one Postgres pool. The app never creates tables: schema changes live in
 * packages/engine/mend_engine/db/schema.sql, and a missing table fails the query.
 */
import { Pool } from "pg";
import { loadConfig } from "./config";
import { writeLog } from "./log";

export const DB_TIMEOUT_MS = 15_000;

let pool: Pool | undefined;

/** The shared pool, created from DATABASE_URL on first use. */
export function database(): Pool {
  if (pool === undefined) {
    const created = new Pool({
      connectionString: loadConfig().databaseUrl,
      max: 5,
      connectionTimeoutMillis: DB_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
      statement_timeout: DB_TIMEOUT_MS,
      query_timeout: DB_TIMEOUT_MS,
      application_name: "mend-web",
    });
    // Without a listener, an idle connection dropped by the server crashes the process.
    created.on("error", (error: Error & { code?: unknown }) => {
      writeLog({ kind: "db", outcome: "idle_connection_lost", code: typeof error.code === "string" ? error.code : null });
    });
    pool = created;
  }
  return pool;
}

/** Ends the pool; the next database() call opens a new one. */
export async function closeDatabase(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}
