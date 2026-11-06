/**
 * Every call Mend makes to Claude, and the rules each one is held to (6n, C12, C15, C17, C20, C26).
 *
 * A client is built here and nowhere else, with the model, the API host and the key
 * fixed in code: the key comes from ANTHROPIC_API_KEY on the server only, and no
 * ANTHROPIC_BASE_URL or auth profile in the environment can move a call elsewhere.
 * One middleware runs on every HTTP attempt the SDK makes, tool-runner rounds and
 * retries included. In order, it refuses any host but api.anthropic.com; refuses a
 * request body holding an email address or the value of a server secret, so personal
 * data and keys never reach the model provider; refuses once the caller's tokens for
 * the day reach one of its budgets in claude_usage (TOKEN_BUDGETS); takes one hit on
 * each of the caller's daily Claude call caps in Postgres (a demo visitor's session,
 * its client address and every demo together; the owner's one count) and refuses once
 * one is used up; and after the answer logs its token counts and stop reason, never its
 * content, and adds its tokens to every budget it counts on.
 *
 * Purpose "studio", the dashboard's agents, runs that same middleware but takes every call
 * hit on counts of its own (a session's hour and day, an address's day, one pool), so a
 * chat on the dashboard can never use up the calls the plan, the notes and Ask Mend need.
 * Its tokens count on the same rows as every demo call, so total spend keeps one ceiling,
 * and it stops early at STUDIO_TOKEN_STOPS, which leaves the rest of each budget for plans
 * and notes. An owner's calls are the same for every purpose.
 *
 * Covers: a bug elsewhere putting an email or a secret into a prompt, a loop spending
 * the key's credit, a visitor sending a few huge prompts inside the call caps, a base
 * URL changed by the environment. Does not cover personal data that is not an email
 * address: goal.ts, notes.ts and agent.ts build every prompt from listed fields that hold
 * no customer name, but purpose "studio" is C15's one exception. The dashboard's tables
 * hold a customer's display name and the data agent's execute_query can put it in a
 * prompt. That name is shop_customers.display_name, which identities.py generates from a
 * hash of the customer's reference: a made-up first name and initial, such as "Maya R.",
 * never a real person's name, even on a row for a member who really joined. Nor does
 * this cover what the model says back, which every caller treats as
 * untrusted text. A budget is checked before a call and charged after it, so calls
 * already in flight when a budget fills each finish: one visitor can go over by what
 * its own concurrent calls use, which the call caps bound. Dashboard turns run one at a
 * time per session (studio-agent.ts), so a session goes over its stop by at most one call.
 */
import Anthropic, { type Middleware } from "@anthropic-ai/sdk";
import { database } from "./db";
import { writeLog } from "./log";
import { reply, type SignedIn } from "./permissions";
import { addressTag, GLOBAL, LIMITS, sessionTag, takeHit, type Limit } from "./ratelimit";
import { secretValues } from "./secrets";

export const MODEL = "claude-haiku-5-5";
export const CALL_TIMEOUT_MS = 60_000;
const API_ORIGIN = "https://api.anthropic.com";
const API_HOST = "api.anthropic.com";
const API_KEY_SHAPE = /^[\x21-\x7e]{20,512}$/;
const LABEL = /^R[1-9][0-9]{0,3}$/;
const STOP_REASON = /^[a-z_]{1,32}$/;

// The one email rule, ported from the engine's receiver rule (payouts.py EMAIL_SHAPE:
// printable ASCII but space and "@", then "@", then a dot with a character on each side)
// and used as a search, so it flags at least every address the engine would pay. The
// lookbehind starts a match only where a run of those characters begins, which keeps
// the search linear on a long run with no "@" in it. Redaction before a prompt is built
// and the refusal in the middleware both use it, after the same removal of invisible
// format characters, so what one lets through the other agrees with.
const EMAIL = /(?<![!-?A-~])[!-?A-~]+@[!-?A-~]+\.[!-?A-~]+/;
const EMAILS = new RegExp(EMAIL.source, "g");
const FORMAT_CHARACTERS = /\p{Cf}/gu;
const CONTROLS_BUT_NEWLINE_AND_TAB = /(?![\n\t])\p{Cc}/gu;

export type Purpose = "goal" | "note" | "agent" | "studio";
/** Why the calls of one request stopped early. */
export type Stop = "limit_reached" | "claude_token_cap" | "outbound_refused" | "timed_out";
/** What went wrong with a Claude call, as a fixed code a route can answer with. */
export type Failure = Stop | "declined" | "busy" | "unavailable" | "unreadable";

/** The plain answer a person sees for each way the AI part can be unavailable. Code-owned, never model text. */
export const FAILURE_MESSAGES: Readonly<Record<Failure | "no_key", string>> = {
  no_key: "The AI assistant needs an Anthropic API key (ANTHROPIC_API_KEY on the server). Everything else in Mend works without it.",
  limit_reached: "The AI assistant's daily limit for this account is used up. Planning from the form and the rest of Mend still work.",
  claude_token_cap: "The AI assistant has used today's token budget for this account. Planning from the form and the rest of Mend still work.",
  outbound_refused: "That request could not be sent to the AI service.",
  timed_out: "The AI service took too long, so the request was stopped.",
  declined: "The AI service declined this request.",
  busy: "The AI service is busy right now. Try again in a minute.",
  unavailable: "The AI service is not reachable right now. Try again shortly.",
  unreadable: "The AI service gave an answer Mend could not read.",
};

/** What a person reads when the dashboard's agents reach one of their own limits: only their share is gone, so it says what still works. */
export const STUDIO_SHARE_USED = "The analyst has used its share for now. Try again later. Plans, notes and Ask Mend still work.";

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

function withoutFormatCharacters(text: string): string {
  return text.replace(FORMAT_CHARACTERS, "");
}

/** text with invisible format characters dropped and every email address replaced, for anything a person typed before it goes into a prompt. */
export function withoutEmails(text: string): string {
  return withoutFormatCharacters(text).replace(EMAILS, "[email removed]");
}

/** Why body may not be sent to the model provider, or null when it may. */
export function outboundProblem(body: string): "email" | "secret" | null {
  const visible = withoutFormatCharacters(body);
  if (EMAIL.test(visible)) return "email";
  for (const value of secretValues()) {
    // A value may sit in the JSON body escaped, so both spellings are looked for.
    const escaped = JSON.stringify(value).slice(1, -1);
    if ([body, visible].some((text) => text.includes(value) || text.includes(escaped))) return "secret";
  }
  return null;
}

/**
 * Model text made safe to hand back as plain text (C14): no format character, no control
 * character but newline and tab, no markdown image, no HTML tag and no angle bracket at
 * all, no email address, at most maxChars. Every removal runs before the email rule, so
 * no removed character can join the halves of an address back together. Rendering it as
 * escaped text stays the browser's job.
 */
export function plainText(text: string, maxChars: number): string {
  const stripped = withoutFormatCharacters(text)
    .replace(CONTROLS_BUT_NEWLINE_AND_TAB, "")
    .replace(/!\[[^\]]*\]\s*(?:\([^)]*\)|\[[^\]]*\])/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "");
  return withoutEmails(stripped).trim().slice(0, maxChars);
}

/**
 * The Claude calls made for one request: whose caps pay for them (the principal, and
 * for a demo visitor the client address the request came from, as clientAddress gives
 * it), how many were made, the tokens they used, why they stopped if they did, and the
 * deadline that aborts them all. close() when the request is done.
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
    readonly address: string,
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

/**
 * Each UTC day's Claude tokens, input plus output, with cache reads and cache writes
 * counted as input so every token the model processes is bounded (C12, C20): per demo
 * session, per demo client address so one address cannot spend every demo's share by
 * opening sessions, across all demo traffic, and for the owner. A call is refused once
 * any budget it counts on is reached.
 */
export const TOKEN_BUDGETS = { demoSession: 200_000, demoAddress: 400_000, demoAll: 5_000_000, owner: 2_000_000 } as const;

/** Where "studio" calls stop on each of the same rows, leaving the rest of each of TOKEN_BUDGETS for plans and notes: 50,000, 100,000 and 1,500,000. */
export const STUDIO_TOKEN_STOPS = { session: 150_000, address: 300_000, all: 3_500_000 } as const;

type TokenBudget = { readonly name: string; readonly subject: string; readonly tokens: number };

const UTC_TODAY = "(now() at time zone 'utc')::date";

// claude_usage holds the session and address tags (ratelimit.ts), never the session id
// or the address itself. The prefixes keep the two kinds of tag apart.
function tokenBudgets(session: ClaudeSession, purpose: Purpose): readonly TokenBudget[] {
  const { principal } = session;
  if (principal.role !== "demo") return [{ name: "owner", subject: "owner", tokens: TOKEN_BUDGETS.owner }];
  const studio = purpose === "studio";
  const prefix = studio ? "studio" : "demo";
  return [
    { name: `${prefix}_session`, subject: `session:${sessionTag(principal.sessionId)}`, tokens: studio ? STUDIO_TOKEN_STOPS.session : TOKEN_BUDGETS.demoSession },
    { name: `${prefix}_address`, subject: `address:${addressTag(session.address)}`, tokens: studio ? STUDIO_TOKEN_STOPS.address : TOKEN_BUDGETS.demoAddress },
    { name: `${prefix}_all`, subject: "demo_all", tokens: studio ? STUDIO_TOKEN_STOPS.all : TOKEN_BUDGETS.demoAll },
  ];
}

/** The first budget whose tokens today have reached its size, or null. A stored total that cannot be read counts as reached. */
async function reachedBudget(budgets: readonly TokenBudget[]): Promise<TokenBudget | null> {
  const { rows } = await database().query<{ subject: string; used: string }>(
    `select subject, (input_tokens + output_tokens)::text as used from claude_usage where day = ${UTC_TODAY} and subject = any($1::text[])`,
    [budgets.map((budget) => budget.subject)],
  );
  const used = new Map(rows.map((row) => [row.subject, Number(row.used)]));
  const spent = (subject: string): number => {
    const total = used.get(subject) ?? 0;
    return Number.isSafeInteger(total) ? total : Number.POSITIVE_INFINITY;
  };
  return budgets.find((budget) => spent(budget.subject) >= budget.tokens) ?? null;
}

/** One statement adds a call's tokens to today's row of every budget it counts on. */
async function addTokens(budgets: readonly TokenBudget[], input: number, output: number): Promise<void> {
  if (input === 0 && output === 0) return;
  await database().query(
    `insert into claude_usage (day, subject, input_tokens, output_tokens)
     select ${UTC_TODAY}, subject, $2::bigint, $3::bigint from unnest($1::text[]) as subject
     on conflict (day, subject) do update
       set input_tokens = claude_usage.input_tokens + excluded.input_tokens,
           output_tokens = claude_usage.output_tokens + excluded.output_tokens`,
    [budgets.map((budget) => budget.subject), input, output],
  );
}

type Refused = { readonly why: Stop; readonly reason: string };

/** The call caps one call counts against, narrowest first. */
function callCaps(session: ClaudeSession, purpose: Purpose): readonly (readonly [Limit, string])[] {
  const { principal } = session;
  if (principal.role !== "demo") return [[LIMITS.claudeOwner, GLOBAL]];
  if (purpose === "studio") {
    return [
      [LIMITS.claudeStudioSessionHour, principal.sessionId],
      [LIMITS.claudeStudioSession, principal.sessionId],
      [LIMITS.claudeStudioAddress, session.address],
      [LIMITS.claudeStudioAll, GLOBAL],
    ];
  }
  return [
    [LIMITS.claudeDemoSession, principal.sessionId],
    [LIMITS.claudeDemoAddress, session.address],
    [LIMITS.claudeDemoAll, GLOBAL],
  ];
}

// The token budgets are read first, so a refused call takes no hit on the call caps.
// Demo calls then count against the session, against its client address, and against
// every demo session together, with "studio" calls on counts of their own; the owner's
// against one shared owner count. The address is counted before the global cap, so one
// address stopped there never fills the count every other visitor needs.
async function spendOneCall(session: ClaudeSession, budgets: readonly TokenBudget[], purpose: Purpose): Promise<Refused | null> {
  const reached = await reachedBudget(budgets);
  if (reached !== null) return { why: "claude_token_cap", reason: `tokens_${reached.name}` };
  const { principal } = session;
  for (const [limit, subject] of callCaps(session, purpose)) {
    // The session lets a shared pool keep its last share for visitors who have not drawn on it yet.
    const hit = await takeHit(limit, subject, { session: principal.sessionId });
    if (!hit.allowed) return { why: "limit_reached", reason: limit.bucket };
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
    const budgets = tokenBudgets(session, purpose);
    const refused = await spendOneCall(session, budgets, purpose);
    if (refused !== null) throw refusal(refused.why, refused.reason);
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
    // A failed write throws, so the request fails rather than letting tokens go uncounted.
    await addTokens(budgets, counted.input_tokens + counted.cache_read_tokens + counted.cache_write_tokens, counted.output_tokens);
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
 * stays in the log (C26). purpose "studio" reads STUDIO_SHARE_USED for its two limits.
 */
export function aiRefusal(route: string, ref: string, status: number, error: Failure | "no_key", detail: Readonly<Record<string, unknown>> = {}, purpose: Purpose | null = null): Response {
  writeLog({ kind: "api", route, ref, status, outcome: "refused", error, ...detail });
  const ownShare = purpose === "studio" && (error === "limit_reached" || error === "claude_token_cap");
  return reply(status, { error, message: ownShare ? STUDIO_SHARE_USED : FAILURE_MESSAGES[error], ref });
}

/** The HTTP status for a Claude failure a route cannot work around. */
export function failureStatus(failure: Failure | "no_key"): number {
  if (failure === "limit_reached" || failure === "claude_token_cap") return 429;
  if (failure === "outbound_refused" || failure === "declined" || failure === "unreadable") return 422;
  return 503;
}

/** The system prompt as one block marked for caching: the tools and this block are the stable prefix of every call. */
export function cachedSystem(text: string): Anthropic.TextBlockParam[] {
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}
