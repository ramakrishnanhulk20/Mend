/**
 * The one permission table (C18), the one check every route makes, and the answers a
 * route gives.
 *
 * Deny by default: an action not in the table is refused for everyone, and a role
 * not listed for an action is refused for it. The table is the single positive list
 * in the app; nothing else decides who may do what. "anonymous" is the caller with no
 * live session, who may only start one or read the public shop summary. Demo and owner
 * share the campaign actions; the engine holds demo to tighter caps and to its own
 * campaigns (C19, C20). Only the owner may start the scheduled jobs by hand.
 *
 * Answers to the caller are generic, with a correlation id; the reason stays in the
 * server log (C26).
 */
import { z } from "zod";
import { currentPrincipal, type Principal } from "./auth";
import { csrfSecret } from "./csrf";
import { writeLog } from "./log";
import { SECRET_SETTINGS } from "./secrets";

export const ACTIONS = [
  "session.start",
  "session.end",
  "session.read",
  "campaign.draft",
  "campaign.view",
  "campaign.approve",
  "campaign.submit",
  "campaign.simulate",
  "campaign.results",
  "shop.summary",
  "shop.quiet_regulars",
  "run.read",
  "admin.events",
  "admin.reconcile",
  "admin.purge",
  "campaign.plan",
  "campaign.notes",
  "campaign.request_approval",
  "agent.chat",
  "paypal.read",
  "campaign.cancel_unclaimed",
] as const;

export type Action = (typeof ACTIONS)[number];
export type PrincipalRole = Principal["role"];

const PERMISSIONS: Readonly<Record<Action, readonly PrincipalRole[]>> = Object.freeze({
  "session.start": ["anonymous", "demo", "owner"],
  "session.end": ["demo", "owner"],
  "session.read": ["demo", "owner"],
  "campaign.draft": ["demo", "owner"],
  "campaign.view": ["demo", "owner"],
  "campaign.approve": ["demo", "owner"],
  "campaign.submit": ["demo", "owner"],
  "campaign.simulate": ["demo", "owner"],
  "campaign.results": ["demo", "owner"],
  // The landing page's live numbers: counts and stored proof facts only, no person.
  "shop.summary": ["anonymous", "demo", "owner"],
  "shop.quiet_regulars": ["demo", "owner"],
  // The engine run itself is checked against the session that started it (runs.ts).
  "run.read": ["demo", "owner"],
  "admin.events": ["owner"],
  "admin.reconcile": ["owner"],
  "admin.purge": ["owner"],
  // The AI actions: each Claude call also counts against the role's daily caps (claude.ts).
  "campaign.plan": ["demo", "owner"],
  "campaign.notes": ["demo", "owner"],
  // Moves a draft into the approval queue only; approving stays campaign.approve, a person's click (C2).
  "campaign.request_approval": ["demo", "owner"],
  "agent.chat": ["demo", "owner"],
  // The assistant's four read-only PayPal lookups through PayPal's MCP server, identity stripped (paypal-mcp.ts).
  "paypal.read": ["demo", "owner"],
  // Pulls back sent rewards nobody has claimed, so the money returns to the shop; the engine holds demo to its own campaigns.
  "campaign.cancel_unclaimed": ["demo", "owner"],
});

/** True only when the table grants action to role. Any other string, prototype names included, is false. */
export function isAllowed(action: string, role: PrincipalRole): boolean {
  if (!Object.hasOwn(PERMISSIONS, action)) return false;
  return PERMISSIONS[action as Action].includes(role);
}

export type SignedIn = Extract<Principal, { readonly sessionId: string }>;

export type Authorization =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly status: 401 | 403; readonly principal: Principal };

/**
 * The one check every route makes: may this request's principal do action? Reads the
 * session cookie (recording its use). Refused with 401 when nobody is signed in and
 * signing in could help, otherwise 403. Every refusal is logged. Throws ConfigError
 * when MEND_CSRF_SECRET is missing or short: Next.js loads routes on first use, so
 * this is the earliest point a deployment can be refused, and it refuses every route.
 */
export async function authorize(action: Action, request: Request): Promise<Authorization> {
  csrfSecret();
  const principal = await currentPrincipal(request);
  if (isAllowed(action, principal.role)) return { ok: true, principal };
  const signingInHelps = principal.role === "anonymous" && (isAllowed(action, "demo") || isAllowed(action, "owner"));
  const status = signingInHelps ? 401 : 403;
  // The action is logged only when it is one of ours, so a caller-made string never reaches the log.
  const known = Object.hasOwn(PERMISSIONS, action) ? action : "unknown";
  writeLog({ kind: "auth", outcome: "denied", action: known, role: principal.role, status });
  return { ok: false, status, principal };
}

/** The signed-in principal, or null for anonymous. */
export function signedIn(principal: Principal): SignedIn | null {
  return "sessionId" in principal ? principal : null;
}

const MESSAGES: Readonly<Record<number, string>> = {
  400: "The request was not accepted.",
  401: "Sign in first.",
  403: "Not allowed.",
  404: "Not found.",
  409: "That changed since you last looked. Reload it and try again.",
  413: "The request is too large.",
  415: "Send JSON.",
  422: "That breaks a rule for this account.",
  429: "Too many requests. Try again later.",
  500: "Something went wrong.",
  503: "A service this needs is not reachable right now. Try again shortly.",
};

const NO_STORE = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

/** A JSON answer that is never cached, with any Set-Cookie values given. */
export function reply(status: number, body: Readonly<Record<string, unknown>>, cookies: readonly string[] = []): Response {
  const headers = new Headers(NO_STORE);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

const REFUSAL = z.strictObject({ error: z.string().regex(/^[a-z][a-z_]{0,63}$/), message: z.string().max(200), ref: z.uuid() });

/**
 * A refusal: the fixed error code, a generic message for the status and the
 * correlation id, nothing else. Logs the route, status, code and any detail given.
 * Throws if the code or ref has another shape, so no caller text can become a body.
 */
export function refuse(
  route: string,
  ref: string,
  status: number,
  error: string,
  detail: Readonly<Record<string, unknown>> = {},
  headers: Readonly<Record<string, string>> = {},
): Response {
  writeLog({ kind: "api", route, ref, status, outcome: "refused", error, ...detail });
  const response = reply(status, REFUSAL.parse({ error, message: MESSAGES[status] ?? MESSAGES[500], ref }));
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

/**
 * The shortest secret value the checks look for: scrubbed() here, claude.ts
 * outboundProblem() and the audit detail rule all use this one number. A shorter value
 * would match ordinary text too often to be worth removing.
 */
export const MIN_SECRET_CHARS = 6;

/** text with every secret setting's value and every token-shaped string removed, for a log line. */
export function scrubbed(text: string): string {
  let clean = text;
  for (const name of SECRET_SETTINGS) {
    const value = process.env[name];
    if (value !== undefined && value.length >= MIN_SECRET_CHARS) clean = clean.split(value).join("[removed]");
  }
  return clean
    .replace(/\b(?:s1|c1|c2|a1)\.[A-Za-z0-9_-]{20,}/g, "[token]")
    .replace(/\b[0-9a-f]{64}\b/g, "[hex64]")
    .slice(0, 2000);
}

/** The answer to an error nobody planned for: 500, or 503 for a dependency that is down, logged with its detail scrubbed. */
export function failed(route: string, ref: string, error: unknown, status: 500 | 503 = 500): Response {
  const name = error instanceof Error ? error.name : "unknown";
  const message = error instanceof Error ? scrubbed(error.message) : "";
  return refuse(route, ref, status, status === 503 ? "engine_unavailable" : "internal", { exception: name, detail: message });
}
