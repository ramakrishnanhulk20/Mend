/**
 * Which setting values are secret (C17), decided in one place so the three checks that
 * use it cannot drift apart: permissions.ts scrubbed() removes these values from log
 * text, claude.ts outboundProblem() refuses a model request that holds one, and
 * audit.ts refuses an audit detail that holds one.
 *
 * A setting is secret when it is on the list below, or when its name ends in _SECRET,
 * _TOKEN, _KEY or _PASSWORD in any case, or it is DATABASE_URL. The name rule catches a
 * secret added later without anyone remembering the list; the list keeps the settings
 * whose names the rule does not reach. PAYPAL_CLIENT_ID is not secret by itself, but it
 * is half of the credential pair, so it is kept out of logs and prompts as well.
 *
 * Covers each value exactly as it sits in the environment. Does not cover values made
 * from them, such as the OAuth access tokens PayPal issues for the client secret, or a
 * secret held in a setting whose name follows neither the list nor the rule.
 */
export const SECRET_SETTINGS: readonly string[] = Object.freeze([
  "ANTHROPIC_API_KEY",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "MEND_OWNER_PASSWORD",
  "MEND_CSRF_SECRET",
  "MEND_BRIDGE_TOKEN",
  "MEND_ENGINE_TOKEN",
  "RENDER_API_KEY",
  "DATABASE_URL",
]);

/**
 * The shortest secret value the checks look for. A shorter value would match ordinary
 * text too often to be worth removing.
 */
export const MIN_SECRET_CHARS = 6;

const SECRET_NAME = /(?:_SECRET|_TOKEN|_KEY|_PASSWORD)$/i;

/** True when a setting called name holds a secret by the rule above, list or not. */
export function isSecretName(name: string): boolean {
  return name === "DATABASE_URL" || SECRET_NAME.test(name);
}

/**
 * The value of every secret setting set in env, each at least MIN_SECRET_CHARS long,
 * without repeats, longest first, so a value holding another (a database URL holding its
 * password) is removed whole before the shorter one is looked for.
 */
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = new Set([...SECRET_SETTINGS, ...Object.keys(env).filter(isSecretName)]);
  const values = new Set<string>();
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length >= MIN_SECRET_CHARS) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}
