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
export type RunOptions = { readonly idempotencyKey?: string };

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

type LocalRun = { readonly startedAt: number; readonly key: string | null; run: Run };
type RunStore = { readonly runs: Map<string, LocalRun>; readonly keys: Map<string, string> };

// Kept on globalThis because Next.js may load this module once per route bundle: a run
// started by one route must be readable from GET /api/runs/[runId] in the same process.
const STORE_KEY = Symbol.for("mend.engine.runs");
const holder = globalThis as typeof globalThis & { [STORE_KEY]?: RunStore };
const store: RunStore = (holder[STORE_KEY] ??= { runs: new Map(), keys: new Map() });
const localRuns = store.runs;
const localKeys = store.keys;

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

function startRun(target: Target, name: TaskName, args: readonly unknown[], options: RunOptions): string {
  const key = options.idempotencyKey ?? null;
  if (key !== null) {
    const earlier = localKeys.get(key);
    const entry = earlier === undefined ? undefined : localRuns.get(earlier);
    if (earlier !== undefined && entry !== undefined && Date.now() - entry.startedAt < IDEMPOTENCY_WINDOW_MS) return earlier;
  }
  const runId = `brn-${randomUUID()}`;
  const entry: LocalRun = { startedAt: Date.now(), key, run: { status: "running" } };
  remember(runId, entry);
  callEngine(target, name, args).then(
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
  );
  return runId;
}

/**
 * Start task name with positional args and return the run id at once, without waiting
 * for the run: the engine's task server (MEND_ENGINE_URL) in production, the dev bridge
 * (MEND_BRIDGE_URL) with MEND_DEV on. A repeat with the same idempotencyKey within 24
 * hours returns the first run's id instead of starting another. Throws ConfigError,
 * before anything is sent, when that mode's address or token is missing or wrong. A
 * call that then fails makes the run "failed".
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

export type Waited =
  | { readonly state: "finished"; readonly runId: string; readonly status: "succeeded" | "failed"; readonly result?: EngineAnswer }
  | { readonly state: "pending"; readonly httpStatus: 202; readonly runId: string };

/**
 * Start a run and poll it every 500 ms for up to timeoutMs, for use inside a route.
 * Returns the finished run, or, once the time is up, httpStatus 202 with the run id
 * so the route can answer at once and the run carries on. A failed read while polling
 * is treated as still running. Throws as runTask does when the run cannot be started.
 */
export async function runAndWait(name: TaskName, args: readonly unknown[], timeoutMs: number, options: RunOptions = {}): Promise<Waited> {
  return waitForRun(await runTask(name, args, options), timeoutMs);
}

/**
 * Poll a run already started every 500 ms for up to timeoutMs, as runAndWait does. A
 * timeoutMs of 0 reads the run once. Throws RunNotFound for an id never issued.
 */
export async function waitForRun(runId: string, timeoutMs: number): Promise<Waited> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(Math.min(POLL_MS, Math.max(deadline - Date.now(), 0)));
    try {
      const run = await getRun(runId);
      if (run.status !== "running") return { state: "finished", runId, status: run.status, result: run.result };
    } catch (error) {
      if (!(error instanceof EngineUnavailable)) throw error;
    }
    if (Date.now() >= deadline) return { state: "pending", httpStatus: 202, runId };
  }
}

// Codes meaning the campaign is not in the state the request needs. For an approval: a
// different hash, a recipient who left (the row is gone, or leaving voided the
// campaign), or a campaign already approved or past approval, so reviewing it again is
// the way forward. For pulling back unclaimed rewards: a campaign never sent.
const CONFLICT_CODES: ReadonlySet<string> = new Set(["hash_mismatch", "recipient_not_member", "voided", "not_open", "approved_before", "not_submitted"]);

/** The HTTP status a route answers with for an engine refusal code. */
export function statusForEngineError(code: string): number {
  if (CONFLICT_CODES.has(code)) return 409;
  if (code === "not_found") return 404;
  if (code === "invalid_input" || code === "invalid_actor") return 400;
  if (code === "forbidden") return 403;
  if (code === "limit_reached" || code === "over_demo_daily_cap" || code === "over_daily_cap") return 429;
  if (code === "paypal_unavailable") return 503;
  if (code === "internal") return 500;
  // Every other code is a rule the request broke, such as budget_over_cap.
  return 422;
}
