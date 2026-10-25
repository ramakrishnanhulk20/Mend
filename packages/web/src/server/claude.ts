/**
 * Every call Mend makes to Claude, and the rules each one is held to (6n, C15, C17, C20, C26).
 *
 * A client is built here and nowhere else, with the model, the API host and the key
 * fixed in code: the key comes from ANTHROPIC_API_KEY on the server only, and no
 * ANTHROPIC_BASE_URL or auth profile in the environment can move a call elsewhere.
 * One middleware runs on every HTTP attempt the SDK makes, tool-runner rounds and
 * retries included. In order, it refuses any host but api.anthropic.com; refuses a
 * request body holding an email address or the value of a server secret, so personal
 * data and keys never reach the model provider; takes one hit on the caller's daily
 * Claude caps in Postgres and refuses once they are used up; and after the answer logs
 * its token counts and stop reason, never its content.
 *
 * Covers: a bug elsewhere putting an email or a secret into a prompt, a loop spending
 * the key's credit, a base URL changed by the environment. Does not cover personal data
 * that is not an email address (names never enter a prompt by design: notes.ts and
 * agent.ts build every prompt from listed fields), or what the model says back, which
 * every caller treats as untrusted text.
 */
import Anthropic, { type Middleware } from "@anthropic-ai/sdk";
import { writeLog } from "./log";
import { reply, type SignedIn } from "./permissions";
import { GLOBAL, LIMITS, takeHit, type Limit } from "./ratelimit";

export const MODEL = "claude-haiku-5-5";
export const CALL_TIMEOUT_MS = 60_000;
const API_ORIGIN = "https://api.anthropic.com";
const API_HOST = "api.anthropic.com";
const API_KEY_SHAPE = /^[\x21-\x7e]{20,512}$/;
const LABEL = /^R[1-9][0-9]{0,3}$/;
const STOP_REASON = /^[a-z_]{1,32}$/;
const MIN_SECRET_CHARS = 8;
const SECRET_SETTINGS = [
  "ANTHROPIC_API_KEY",
  "PAYPAL_CLIENT_SECRET",
  "MEND_OWNER_PASSWORD",
  "MEND_CSRF_SECRET",
  "MEND_BRIDGE_TOKEN",
  "MEND_ENGINE_TOKEN",
  "RENDER_API_KEY",
  "DATABASE_URL",
];

// The one email rule: redaction before a prompt is built and the refusal in the
// middleware use this same pattern, so what one lets through the other agrees with.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const EMAILS = new RegExp(EMAIL.source, "g");

export type Purpose = "goal" | "note" | "agent";
/** Why the calls of one request stopped early. */
export type Stop = "limit_reached" | "outbound_refused" | "timed_out";
/** What went wrong with a Claude call, as a fixed code a route can answer with. */
export type Failure = Stop | "declined" | "busy" | "unavailable" | "unreadable";

/** The plain answer a person sees for each way the AI part can be unavailable. Code-owned, never model text. */
export const FAILURE_MESSAGES: Readonly<Record<Failure | "no_key", string>> = {
  no_key: "The AI assistant needs an Anthropic API key (ANTHROPIC_API_KEY on the server). Everything else in Mend works without it.",
  limit_reached: "The AI assistant's daily limit for this account is used up. Planning from the form and the rest of Mend still work.",
  outbound_refused: "That request could not be sent to the AI service.",
  timed_out: "The AI service took too long, so the request was stopped.",
  declined: "The AI service declined this request.",
  busy: "The AI service is busy right now. Try again in a minute.",
  unavailable: "The AI service is not reachable right now. Try again shortly.",
  unreadable: "The AI service gave an answer Mend could not read.",
};

/** A call refused by the middleware before anything was sent. */
export class ClaudeStopped extends Error {
  constructor(readonly why: Stop) {
    super(`claude call refused: ${why}`);
    this.name = "ClaudeStopped";
  }
}

/** No usable ANTHROPIC_API_KEY on this server. */
export class ClaudeKeyMissing extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set");
    this.name = "ClaudeKeyMissing";
  }
}

/** The key, or null when ANTHROPIC_API_KEY is unset or not shaped like a key. */
function claudeKey(): string | null {
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  return API_KEY_SHAPE.test(key) ? key : null;
}

/** True when this server can call Claude at all. */
export function hasClaudeKey(): boolean {
  return claudeKey() !== null;
}

/** text with every email address replaced, for anything a person typed before it goes into a prompt. */
export function withoutEmails(text: string): string {
  return text.replace(EMAILS, "[email removed]");
}

/** Why body may not be sent to the model provider, or null when it may. */
export function outboundProblem(body: string): "email" | "secret" | null {
  if (EMAIL.test(body)) return "email";
  for (const name of SECRET_SETTINGS) {
    const value = process.env[name];
    if (value === undefined || value.length < MIN_SECRET_CHARS) continue;
    // A value may sit in the JSON body escaped, so both spellings are looked for.
    if (body.includes(value) || body.includes(JSON.stringify(value).slice(1, -1))) return "secret";
  }
  return null;
}

/**
 * Model text made safe to hand back as plain text (C14): no markdown image, no HTML tag
 * and no angle bracket at all, no control character but newline and tab, no email
 * address, at most maxChars. Rendering it as escaped text stays the browser's job.
 */
export function plainText(text: string, maxChars: number): string {
  return withoutEmails(text)
    .replace(/!\[[^\]]*\]\s*(?:\([^)]*\)|\[[^\]]*\])/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxChars);
}

/**
 * The Claude calls made for one request: whose caps pay for them, how many were made,
 * the tokens they used, why they stopped if they did, and the deadline that aborts
 * them all. close() when the request is done.
 */
export class ClaudeSession {
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  stopped: Stop | null = null;
  readonly #controller = new AbortController();
  readonly #timer: NodeJS.Timeout;

  constructor(
    readonly principal: SignedIn,
    readonly ref: string,
    deadlineMs: number,
  ) {
    this.#timer = setTimeout(() => {
      this.stop("timed_out");
      this.#controller.abort();
    }, deadlineMs);
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  stop(why: Stop): void {
    this.stopped ??= why;
  }

  close(): void {
    clearTimeout(this.#timer);
  }
}

// Demo calls count against the session and against every demo session together; the
// owner's against one shared owner count. Each limit is a rolling 24 hours.
async function spendOneCall(principal: SignedIn): Promise<string | null> {
  const caps: readonly (readonly [Limit, string])[] =
    principal.role === "demo"
      ? [
          [LIMITS.claudeDemoSession, principal.sessionId],
          [LIMITS.claudeDemoAll, GLOBAL],
        ]
      : [[LIMITS.claudeOwner, GLOBAL]];
  for (const [limit, subject] of caps) {
    const hit = await takeHit(limit, subject);
    if (!hit.allowed) return limit.bucket;
  }
  return null;
}

type Usage = {
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
  readonly cache_read_input_tokens?: unknown;
  readonly cache_creation_input_tokens?: unknown;
};

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function guard(session: ClaudeSession, purpose: Purpose, label: string | null): Middleware {
  return async (request, next, context) => {
    const refusal = (why: Stop, reason: string): ClaudeStopped => {
      session.stop(why);
      writeLog({ kind: "claude", ref: session.ref, purpose, label, outcome: "refused", reason });
      return new ClaudeStopped(why);
    };
    let url: URL | null;
    try {
      url = new URL(request.url);
    } catch {
      url = null;
    }
    if (url === null || url.protocol !== "https:" || url.hostname !== API_HOST || url.port !== "") throw refusal("outbound_refused", "host");
    if (typeof request.body !== "string") throw refusal("outbound_refused", "body_shape");
    const problem = outboundProblem(request.body);
    if (problem !== null) throw refusal("outbound_refused", problem);
    const spent = await spendOneCall(session.principal);
    if (spent !== null) throw refusal("limit_reached", spent);
    session.calls += 1;

    const started = Date.now();
    const response = await next(request);
    let usage: Usage = {};
    let stopReason: string | null = null;
    if (response.ok) {
      try {
        const answer = await context.parse<{ usage?: Usage; stop_reason?: unknown }>(response);
        usage = answer.usage ?? {};
        stopReason = typeof answer.stop_reason === "string" && STOP_REASON.test(answer.stop_reason) ? answer.stop_reason : null;
      } catch {
        usage = {};
      }
    }
    const counted = {
      input_tokens: tokens(usage.input_tokens),
      output_tokens: tokens(usage.output_tokens),
      cache_read_tokens: tokens(usage.cache_read_input_tokens),
      cache_write_tokens: tokens(usage.cache_creation_input_tokens),
    };
    session.inputTokens += counted.input_tokens;
    session.outputTokens += counted.output_tokens;
    session.cacheReadTokens += counted.cache_read_tokens;
    session.cacheWriteTokens += counted.cache_write_tokens;
    writeLog({
      kind: "claude",
      ref: session.ref,
      purpose,
      label,
      role: session.principal.role,
      outcome: "answered",
      status: response.status,
      ms: Date.now() - started,
      model: MODEL,
      stop_reason: stopReason,
      ...counted,
    });
    return response;
  };
}

/**
 * A client for one purpose within session: every call it makes passes the middleware
 * above. label (a campaign row ref such as "R3") is logged with each call so a note can
 * be traced to the one customer it was written for. Throws ClaudeKeyMissing when no
 * key is set. One retry, so a passing overload does not fail a request; the retry is
 * counted against the caps like any other call.
 */
export function claudeClient(session: ClaudeSession, purpose: Purpose, label: string | null = null): Anthropic {
  const apiKey = claudeKey();
  if (apiKey === null) throw new ClaudeKeyMissing();
  return new Anthropic({
    apiKey,
    baseURL: API_ORIGIN,
    maxRetries: 1,
    timeout: CALL_TIMEOUT_MS,
    logLevel: "off",
    middleware: [guard(session, purpose, label !== null && LABEL.test(label) ? label : null)],
  });
}

/**
 * The fixed code for an error a Claude call threw, most specific first, with the error's
 * name and status logged under the session's ref (C26). Anything that is not a Claude
 * outcome is rethrown, so a bug is never reported as "the AI was busy".
 */
export function failureOf(error: unknown, session: ClaudeSession): Failure {
  const status = error instanceof Anthropic.APIError && typeof error.status === "number" ? error.status : null;
  writeLog({ kind: "claude", ref: session.ref, outcome: "failed", error: error instanceof Error ? error.name : "unknown", status });
  if (session.stopped !== null) return session.stopped;
  if (error instanceof ClaudeStopped) return error.why;
  if (error instanceof Anthropic.RateLimitError) return "busy";
  if (error instanceof Anthropic.APIUserAbortError) return "timed_out";
  if (error instanceof Anthropic.APIError) return "unavailable";
  if (error instanceof Anthropic.AnthropicError) return "unreadable";
  throw error;
}

/**
 * A refusal whose message says plainly what happened with the AI part (6n, C20): the
 * error code, one of the code-owned messages above, and the correlation id. The detail
 * stays in the log (C26).
 */
export function aiRefusal(route: string, ref: string, status: number, error: Failure | "no_key", detail: Readonly<Record<string, unknown>> = {}): Response {
  writeLog({ kind: "api", route, ref, status, outcome: "refused", error, ...detail });
  return reply(status, { error, message: FAILURE_MESSAGES[error], ref });
}

/** The HTTP status for a Claude failure a route cannot work around. */
export function failureStatus(failure: Failure | "no_key"): number {
  if (failure === "limit_reached") return 429;
  if (failure === "outbound_refused" || failure === "declined" || failure === "unreadable") return 422;
  return 503;
}

/** The system prompt as one block marked for caching: the tools and this block are the stable prefix of every call. */
export function cachedSystem(text: string): Anthropic.TextBlockParam[] {
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}
