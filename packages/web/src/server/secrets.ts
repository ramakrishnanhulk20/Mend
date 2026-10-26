/**
 * The settings whose values are secret (C17), in one list so the two checks that use it
 * cannot drift apart: permissions.ts scrubbed() removes these values from log text, and
 * claude.ts outboundProblem() refuses a model request that holds one.
 *
 * Covers each value exactly as it sits in the environment. Does not cover values made
 * from them, such as the OAuth access tokens PayPal issues for the client secret, or a
 * setting added later and not listed here. PAYPAL_CLIENT_ID is not secret by itself, but
 * it is half of the credential pair, so it is kept out of logs and prompts as well.
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
