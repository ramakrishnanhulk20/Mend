/**
 * The engine's settings for the local development database, shared by dev-console.ts and
 * the proofs. migrate, which the dev bridge runs at start, skips the mend_engine and
 * mend_web roles this local database does not have only in development with DATABASE_URL
 * unset (migrate.py is_local_development), so DATABASE_URL is passed empty, which also wins
 * over .env. The engine then uses the held pgserver, and PGOPTIONS, which libpq reads on
 * every connection, points it at one schema instead of public.
 */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export type LocalEngineDatabase = { readonly MEND_DEV: "1"; readonly DATABASE_URL: ""; readonly PGOPTIONS: string };

/**
 * MEND_DEV on, DATABASE_URL empty and PGOPTIONS setting search_path to schema. Throws for
 * a schema name that is not a plain lower-case identifier, because libpq splits PGOPTIONS
 * on spaces and backslashes and the name is not quoted there.
 */
export function localEngineDatabase(schema: string): LocalEngineDatabase {
  if (!SCHEMA_NAME.test(schema)) throw new Error("the schema name must be lower-case letters, digits and underscores, at most 63");
  return { MEND_DEV: "1", DATABASE_URL: "", PGOPTIONS: `-c search_path=${schema}` };
}
