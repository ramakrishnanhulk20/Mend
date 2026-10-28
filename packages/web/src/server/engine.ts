/**
 * The web app's only way to reach the engine: start a task run, then read it.
 *
 * A run is one POST /tasks/<name> to the engine's task server, made in the background
 * so a route can answer before it finishes, and kept in this process's memory until it
 * is read. In production the server is the private service mend-engine at
 * MEND_ENGINE_URL, called with MEND_ENGINE_TOKEN; Mend runs one web instance, so every
 * route reads the same runs. In development (MEND_DEV on) it is the engine's dev bridge
 * on this machine, at MEND_BRIDGE_URL with MEND_BRIDGE_TOKEN. No Render API key is read
 * or needed in either mode.
 *
 * Everything the engine answers is checked against the shape the engine promises
 * before any route uses it (C12): {"ok": true, ...} or {"ok": false, "error": <code>,
 * "ref": <uuid>}. Anything else counts as a failed run.
 *
 * At most 2 calls are in flight at once for one holder (C20), so no visitor can tie up
 * the engine's workers: the session named by the call's actor argument, the same
 * {role, session} object the engine checks; for a call with no session, the client
 * address the caller passes; for a call naming neither (the owner's admin jobs, which
 * pass no actor, and the public summary), the task itself. A third call is not sent:
 * its run is finished at once with the refusal too_many_running, which routes answer as
 * 429 like any engine refusal. A call stays in flight until the engine answers or the
 * 120-second timeout ends it, also after a route has answered 202. Does not cover many
 * sessions or addresses at once; the per-address limits on opening sessions bound those.
 */
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { devMode, isLoopback } from "./auth";
import { ConfigError } from "./config";
import { writeLog } from "./log";

export const TASK_NAMES = [
  "draft_campaign",
  "view_campaign",
  "approve_campaign",
  "submit_campaign",
  "simulate_return",
  "results",
  "shop_summary",
  "quiet_regulars",
  "process_events",
  "reconcile",
  "purge",
  "draft_limits",
  "note_context",
  "set_note",
  "request_approval",
  "consent_text",
  "join",
  "leave",
  "cancel_unclaimed",
] as const;

export type TaskName = (typeof TASK_NAMES)[number];
export type RunStatus = "running" | "succeeded" | "failed";

export const POLL_MS = 500;
const CALL_TIMEOUT_MS = 120_000;
const MAX_ANSWER_BYTES = 1_000_000;
const MAX_RUNS = 500;
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_TOKEN_CHARS = 32;
const MAX_ADDRESS_CHARS = 64;

/** Engine calls one session, client address or task may have in flight at once. */
export const MAX_IN_FLIGHT = 2;
/** The refusal a run carries when its holder already had MAX_IN_FLIGHT calls in flight. */
export const TOO_MANY_RUNNING = "too_many_running";

// One shape for both modes; runs.ts records ids of this shape against their session.
const RUN_ID = /^brn-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,255}$/;
const PRINTABLE_NO_SPACE = /^[\x21-\x7e]+$/;
// A single DNS label, the form of a Render private network name such as mend-engine-a1b2.
const SINGLE_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const answerSchema = z.union([
  z.looseObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), error: z.string().regex(/^[a-z][a-z_]{0,63}$/), ref: z.uuid() }),
]);

export type EngineAnswer = z.infer<typeof answerSchema>;
export type Run = { readonly status: RunStatus; readonly result?: EngineAnswer };
/**
 * idempotencyKey: a repeat within 24 hours returns the first run. address: the client
 * address (ratelimit.ts clientAddress) a call with no session in its arguments counts
 * against for MAX_IN_FLIGHT.
 */
export type RunOptions = { readonly idempotencyKey?: string; readonly address?: string };

/** The engine could not be asked: a run could not be started or read. */
export class EngineUnavailable extends Error {
  constructor(reason: string) {
    super(`engine unavailable: ${reason}`);
    this.name = "EngineUnavailable";
  }
}

/** No run with this id exists for this deployment. */
export class RunNotFound extends Error {
  constructor() {
    super("no such run");
    this.name = "RunNotFound";
  }
}

function checkedArguments(name: string, options: RunOptions): void {
  if (!(TASK_NAMES as readonly string[]).includes(name)) throw new Error("unknown engine task");
  if (options.idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(options.idempotencyKey)) {
    throw new Error("idempotency key must be 1 to 255 letters, digits or _.:-");
  }
  if (options.address !== undefined && (options.address.length > MAX_ADDRESS_CHARS || !PRINTABLE_NO_SPACE.test(options.address))) {
    throw new Error("a client address must be 1 to 64 printable characters");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readAnswer(value: unknown): EngineAnswer | null {
  const parsed = answerSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Where task calls go in this mode, and the token and header they carry. */
type Target = { readonly mode: "bridge" | "service"; readonly url: URL; readonly token: string; readonly header: string };

type LocalRun = { readonly startedAt: number; readonly key: string | null; run: Run; readonly settled: Promise<Run> };
type RunStore = { readonly runs: Map<string, LocalRun>; readonly keys: Map<string, string>; inFlight?: Map<string, number> };

// Kept on globalThis because Next.js may load this module once per route bundle: a run
// started by one route must be readable from GET /api/runs/[runId] in the same process,
// and the in-flight counts must be one count per holder for the whole process.
const STORE_KEY = Symbol.for("mend.engine.runs");
const holder = globalThis as typeof globalThis & { [STORE_KEY]?: RunStore };
const store: RunStore = (holder[STORE_KEY] ??= { runs: new Map(), keys: new Map() });
const localRuns = store.runs;
const localKeys = store.keys;
const inFlight: Map<string, number> = (store.inFlight ??= new Map());

type Holder = { readonly kind: "session" | "address" | "task"; readonly key: string };

// The actor every signed-in route builds from its principal, and the engine checks.
const ACTOR_KEYS = "role,session";

/** Who a call counts against for MAX_IN_FLIGHT; see the file comment. */
function holderOf(name: TaskName, args: readonly unknown[], options: RunOptions): Holder {
  for (const arg of args) {
    if (typeof arg !== "object" || arg === null || Array.isArray(arg) || Object.keys(arg).sort().join(",") !== ACTOR_KEYS) continue;
    const session: unknown = (arg as { session?: unknown }).session;
    if (typeof session === "string") return { kind: "session", key: `session\n${session}` };
  }
  if (options.address !== undefined) return { kind: "address", key: `address\n${options.address}` };
  return { kind: "task", key: `task\n${name}` };
}

function release(key: string): void {
  const left = (inFlight.get(key) ?? 1) - 1;
  if (left > 0) inFlight.set(key, left);
  else inFlight.delete(key);
}

function bareOrigin(url: URL): boolean {
  return url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "";
}

function checkedToken(name: string): string {
  const token = process.env[name] ?? "";
  if (token.length < MIN_TOKEN_CHARS || !PRINTABLE_NO_SPACE.test(token)) {
    throw new ConfigError(`${name} must be at least 32 printable characters`);
  }
  return token;
}

function bridgeTarget(): Target {
  let url: URL;
  try {
    url = new URL(process.env.MEND_BRIDGE_URL ?? "");
  } catch {
    throw new ConfigError("MEND_BRIDGE_URL must be the dev bridge's http address on this machine");
  }
  // The token travels with every call, so it is only ever sent to this machine.
  if (url.protocol !== "http:" || !isLoopback(url.hostname) || !bareOrigin(url)) {
    throw new ConfigError("MEND_BRIDGE_URL must be the dev bridge's http address on this machine");
  }
  return { mode: "bridge", url, token: checkedToken("MEND_BRIDGE_TOKEN"), header: "x-mend-bridge-token" };
}

/**
 * MEND_ENGINE_URL, checked: plain http to a host that is one DNS label (a Render private
 * network name), an optional port, and nothing else. A one-label name cannot be
 * resolved on the public internet, so the token never leaves Render's network in clear
 * text. This refuses https, IP addresses, localhost, dotted names, userinfo and paths.
 * It does not cover another service inside the same Render workspace taking the name,
 * which needs access to Ram's Render account.
 */
function serviceTarget(): Target {
  let url: URL;
  try {
    url = new URL(process.env.MEND_ENGINE_URL ?? "");
  } catch {
    throw new ConfigError("MEND_ENGINE_URL must be the engine's private network address");
  }
  const privateName = SINGLE_LABEL.test(url.hostname) && isIP(url.hostname) === 0 && !isLoopback(url.hostname);
  if (url.protocol !== "http:" || !privateName || !bareOrigin(url)) {
    throw new ConfigError("MEND_ENGINE_URL must be the engine's private network address");
  }
  return { mode: "service", url, token: checkedToken("MEND_ENGINE_TOKEN"), header: "x-mend-engine-token" };
}

async function callEngine(target: Target, name: TaskName, args: readonly unknown[]): Promise<EngineAnswer> {
  const response = await fetch(new URL(`/tasks/${name}`, target.url), {
    method: "POST",
    headers: { "content-type": "application/json", [target.header]: target.token },
    body: JSON.stringify({ args }),
    // A redirect would carry the token to wherever it points.
    redirect: "error",
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const text = await response.text();
  if (response.status !== 200) throw new EngineUnavailable(`the engine answered ${response.status}`);
  if (Buffer.byteLength(text, "utf8") > MAX_ANSWER_BYTES) throw new EngineUnavailable("the engine answer is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EngineUnavailable("the engine answer is not JSON");
  }
  const answer = readAnswer(parsed);
  if (answer === null) throw new EngineUnavailable("the engine answer is not an engine answer");
  return answer;
}

function remember(runId: string, entry: LocalRun): void {
  localRuns.set(runId, entry);
  if (entry.key !== null) localKeys.set(entry.key, runId);
  for (const [oldId, old] of localRuns) {
    if (localRuns.size <= MAX_RUNS) break;
    localRuns.delete(oldId);
    if (old.key !== null && localKeys.get(old.key) === oldId) localKeys.delete(old.key);
  }
}

// A run finished before any call: holder already has MAX_IN_FLIGHT calls in flight. It
// carries no idempotency key, so a retry with the same key is free to start a real call.
function refusedRun(name: TaskName, holderKind: Holder["kind"]): string {
  const runId = `brn-${randomUUID()}`;
  const run: Run = { status: "succeeded", result: { ok: false, error: TOO_MANY_RUNNING, ref: randomUUID() } };
  remember(runId, { startedAt: Date.now(), key: null, run, settled: Promise.resolve(run) });
  writeLog({ kind: "engine", outcome: "refused_in_flight", task: name, holder: holderKind, run_id: runId, ref: run.result?.ref });
  return runId;
}

function startRun(target: Target, name: TaskName, args: readonly unknown[], options: RunOptions): string {
  const key = options.idempotencyKey ?? null;
  if (key !== null) {
    const earlier = localKeys.get(key);
    const entry = earlier === undefined ? undefined : localRuns.get(earlier);
    if (earlier !== undefined && entry !== undefined && Date.now() - entry.startedAt < IDEMPOTENCY_WINDOW_MS) return earlier;
  }
  const owner = holderOf(name, args, options);
  const running = inFlight.get(owner.key) ?? 0;
  if (running >= MAX_IN_FLIGHT) return refusedRun(name, owner.kind);
  inFlight.set(owner.key, running + 1);
  const runId = `brn-${randomUUID()}`;
  let settle: (run: Run) => void = () => undefined;
  const settled = new Promise<Run>((resolve) => {
    settle = resolve;
  });
  const entry: LocalRun = { startedAt: Date.now(), key, run: { status: "running" }, settled };
  remember(runId, entry);
  callEngine(target, name, args)
    .then(
      (answer) => {
        entry.run = { status: "succeeded", result: answer };
      },
      (error: unknown) => {
        entry.run = { status: "failed" };
        writeLog({
          kind: "engine",
          outcome: "engine_call_failed",
          mode: target.mode,
          task: name,
          run_id: runId,
          reason: error instanceof Error ? error.message : "unknown",
        });
      },
    )
    .finally(() => {
      release(owner.key);
      settle(entry.run);
    });
  return runId;
}

/**
 * Start task name with positional args and return the run id at once, without waiting
 * for the run: the engine's task server (MEND_ENGINE_URL) in production, the dev bridge
 * (MEND_BRIDGE_URL) with MEND_DEV on. A repeat with the same idempotencyKey within 24
 * hours returns the first run's id instead of starting another. When the call's holder
 * already has MAX_IN_FLIGHT calls in flight, nothing is sent and the run is finished at
 * once with the refusal too_many_running. Throws ConfigError, before anything is sent,
 * when that mode's address or token is missing or wrong, and Error for an unknown task,
 * a malformed idempotency key or client address. A call that then fails makes the run
 * "failed".
 */
export async function runTask(name: TaskName, args: readonly unknown[], options: RunOptions = {}): Promise<string> {
  checkedArguments(name, options);
  return startRun(devMode() ? bridgeTarget() : serviceTarget(), name, args, options);
}

/** True when runId has the shape of a run id this process issues. */
export function isRunId(runId: string): boolean {
  return RUN_ID.test(runId);
}

/**
 * The run's state: running, succeeded with the engine's checked answer, or failed.
 * Throws RunNotFound for an id this process never issued, or has since forgotten (it
 * keeps the latest 500, and none across a restart).
 */
export async function getRun(runId: string): Promise<Run> {
  const entry = RUN_ID.test(runId) ? localRuns.get(runId) : undefined;
  if (entry === undefined) throw new RunNotFound();
  return entry.run;
}

/**
 * The run once it is no longer running, at once for one already finished, so a route
 * can act on the answer after it has replied 202. Throws RunNotFound as getRun does.
 */
export async function runSettled(runId: string): Promise<Run> {
  const entry = RUN_ID.test(runId) ? localRuns.get(runId) : undefined;
  if (entry === undefined) throw new RunNotFound();
  return entry.settled;
}

export type Waited =
  | { readonly state: "finished"; readonly runId: string; readonly status: "succeeded" | "failed"; readonly result?: EngineAnswer }
  | { readonly state: "pending"; readonly httpStatus: 202; readonly runId: string };

/**
 * Start a run, read it at once and then every 500 ms for up to timeoutMs, for use
 * inside a route. Returns the finished run, a refused one at once, or, once the time is
 * up, httpStatus 202 with the run id so the route can answer at once and the run carries
 * on. A failed read while polling is treated as still running. Throws as runTask does
 * when the run cannot be started.
 */
export async function runAndWait(name: TaskName, args: readonly unknown[], timeoutMs: number, options: RunOptions = {}): Promise<Waited> {
  return waitForRun(await runTask(name, args, options), timeoutMs);
}

/**
 * Read a run already started at once and then every 500 ms for up to timeoutMs, as
 * runAndWait does. A timeoutMs of 0 reads the run once. Throws RunNotFound for an id
 * never issued.
 */
export async function waitForRun(runId: string, timeoutMs: number): Promise<Waited> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const run = await getRun(runId);
      if (run.status !== "running") return { state: "finished", runId, status: run.status, result: run.result };
    } catch (error) {
      if (!(error instanceof EngineUnavailable)) throw error;
    }
    const left = deadline - Date.now();
    if (left <= 0) return { state: "pending", httpStatus: 202, runId };
    await sleep(Math.min(POLL_MS, left));
  }
}

// Codes meaning the campaign is not in the state the request needs. For an approval: a
// different hash, a recipient who left (the row is gone, or leaving voided the
// campaign), a campaign already approved or past approval, or a member another approved
// campaign is still measuring, so reviewing it again is the way forward. For pulling back
// unclaimed rewards: a campaign never sent.
const CONFLICT_CODES: ReadonlySet<string> = new Set(["hash_mismatch", "recipient_not_member", "voided", "not_open", "approved_before", "not_submitted", "member_held"]);

/** The HTTP status a route answers with for an engine refusal code. */
export function statusForEngineError(code: string): number {
  if (CONFLICT_CODES.has(code)) return 409;
  if (code === "not_found") return 404;
  if (code === "invalid_input" || code === "invalid_actor") return 400;
  if (code === "forbidden") return 403;
  if (code === "limit_reached" || code === "over_demo_daily_cap" || code === "over_daily_cap" || code === TOO_MANY_RUNNING) return 429;
  // busy: another demo send held the spend lock for 10 s; balance_unavailable: PayPal could not report the balance.
  if (code === "paypal_unavailable" || code === "busy" || code === "balance_unavailable") return 503;
  if (code === "internal") return 500;
  // Every other code is a rule the request broke, such as budget_over_cap.
  return 422;
}
