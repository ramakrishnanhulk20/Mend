/**
 * Deployment settings for the web app, read from the process environment at first use.
 *
 * The app can only ever talk to the PayPal sandbox. The API host is a constant, not a
 * setting, so no environment value or caller can point it at live PayPal. Error
 * messages name the setting that failed, never its value.
 */
import { z } from "zod";

export const SANDBOX_API_HOST = "api-m.sandbox.paypal.com";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type PayPalCredentials = {
  readonly clientId: string;
  readonly clientSecret: string;
};

export type Config = {
  readonly paypalApiHost: typeof SANDBOX_API_HOST;
  readonly paypal: PayPalCredentials;
  /** The agent's PayPal reads: a second sandbox app without Payouts when one is set, otherwise the main app. */
  readonly paypalRead: PayPalCredentials;
  readonly paypalReadSeparate: boolean;
  readonly webhookId: string;
  readonly databaseUrl: string;
};

export type Env = Readonly<Record<string, string | undefined>>;

const NO_WHITESPACE = /^\S+$/;

const credentialsSchema = z.object({
  PAYPAL_ENV: z.literal("sandbox"),
  PAYPAL_CLIENT_ID: z.string().regex(NO_WHITESPACE),
  PAYPAL_CLIENT_SECRET: z.string().regex(NO_WHITESPACE),
});

const configSchema = credentialsSchema.extend({
  // PayPal's own rule for webhook_id in verify-webhook-signature: letters and digits, at most 50.
  PAYPAL_WEBHOOK_ID: z.string().regex(/^[A-Za-z0-9]{1,50}$/),
  DATABASE_URL: z.string().refine(isPostgresUrl),
});

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    // A host, or a host query parameter naming a socket directory (pgserver on Linux and macOS).
    const reachable = url.hostname !== "" || url.searchParams.has("host");
    return (url.protocol === "postgresql:" || url.protocol === "postgres:") && reachable;
  } catch {
    return false;
  }
}

// Built from issue paths only: zod's own messages can quote the rejected value.
function refusal(issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey> }>): ConfigError {
  const names = [...new Set(issues.map((issue) => String(issue.path[0] ?? "environment")))].sort();
  if (names.includes("PAYPAL_ENV")) {
    return new ConfigError("PAYPAL_ENV must be exactly 'sandbox'");
  }
  return new ConfigError(`missing or invalid setting: ${names.join(", ")}`);
}

// Hidden properties stay out of JSON.stringify, console.log and object spreads, so a
// logged config object never carries a secret.
function withHidden<T extends object>(visible: T, hidden: Record<string, string>): T {
  for (const [key, value] of Object.entries(hidden)) {
    Object.defineProperty(visible, key, { value, enumerable: false });
  }
  return Object.freeze(visible);
}

/**
 * The PayPal sandbox credentials from env, for scripts that call PayPal before a
 * webhook exists. Throws ConfigError unless PAYPAL_ENV is exactly "sandbox" and both
 * keys are set with no whitespace.
 */
export function readCredentials(env: Env): PayPalCredentials {
  const parsed = credentialsSchema.safeParse(env);
  if (!parsed.success) {
    throw refusal(parsed.error.issues);
  }
  return withHidden({ clientId: parsed.data.PAYPAL_CLIENT_ID } as PayPalCredentials, {
    clientSecret: parsed.data.PAYPAL_CLIENT_SECRET,
  });
}

const READ_ID = "PAYPAL_READ_CLIENT_ID";
const READ_SECRET = "PAYPAL_READ_CLIENT_SECRET";

/**
 * The credentials the agent's PayPal reads use. A separate sandbox app, made without the
 * Payouts permission, keeps a leaked or misused read token from ever paying anyone; PayPal
 * itself refuses its token on the Payouts API.
 *
 * Both PAYPAL_READ_CLIENT_ID and PAYPAL_READ_CLIENT_SECRET set with no whitespace: that
 * app, separate true. Neither set (an empty value counts as unset): main, separate false.
 * Throws ConfigError naming the missing or invalid setting when only one is usable, and
 * when the read client id is main's, since that is the same app with the same permissions.
 * The secret is hidden from JSON, inspect and spreads as main's is.
 */
export function readOnlyCredentials(env: Env, main: PayPalCredentials): { credentials: PayPalCredentials; separate: boolean } {
  const id = env[READ_ID];
  const secret = env[READ_SECRET];
  const unset = (value: string | undefined) => value === undefined || value === "";
  if (unset(id) && unset(secret)) return { credentials: main, separate: false };
  const bad = [READ_ID, READ_SECRET].filter((name) => !NO_WHITESPACE.test(env[name] ?? ""));
  if (bad.length > 0) throw new ConfigError(`missing or invalid setting: ${bad.join(", ")}`);
  if (id === main.clientId) throw new ConfigError(`${READ_ID} must belong to a different PayPal app`);
  return {
    credentials: withHidden({ clientId: id } as PayPalCredentials, { clientSecret: secret as string }),
    separate: true,
  };
}

/**
 * Validate a whole environment into a Config. Throws ConfigError unless PAYPAL_ENV is
 * exactly "sandbox", both PayPal keys are set, PAYPAL_WEBHOOK_ID is letters and digits
 * (at most 50), DATABASE_URL is a postgres:// or postgresql:// URL with a host (or a
 * host parameter naming a socket directory), and the read-only pair passes
 * readOnlyCredentials.
 */
export function parseConfig(env: Env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw refusal(parsed.error.issues);
  }
  const paypal = readCredentials(env);
  const read = readOnlyCredentials(env, paypal);
  return withHidden(
    {
      paypalApiHost: SANDBOX_API_HOST,
      paypal,
      paypalRead: read.credentials,
      paypalReadSeparate: read.separate,
      webhookId: parsed.data.PAYPAL_WEBHOOK_ID,
    } as Config,
    { databaseUrl: parsed.data.DATABASE_URL },
  );
}

let loaded: Config | undefined;

/**
 * The app's Config, validated from process.env on the first call and reused after.
 * A failed validation is not cached, so every call refuses until the env is fixed.
 */
export function loadConfig(): Config {
  loaded ??= parseConfig(process.env);
  return loaded;
}
