/**
 * The web app's only way to reach the engine: start a task run, then read it.
 *
 * In production a run is a Render Workflows task run, started with the Render SDK and
 * read back with getTaskRun; a request never waits on the SDK's own .get(), which can
 * hang. In development (MEND_DEV on) the same tasks run through the engine's dev
 * bridge on this machine, and a bridge run lives only in this process's memory.
 *
 * Everything the engine answers is checked against the shape the engine promises
 * before any route uses it (C12): {"ok": true, ...} or {"ok": false, "error": <code>,
 * "ref": <uuid>}. Anything else counts as a failed run.
 */
import { randomUUID } from "node:crypto";
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
] as const;

export type TaskName = (typeof TASK_NAMES)[number];
export type RunStatus = "running" | "succeeded" | "failed";

export const POLL_MS = 500;
const RENDER_API = "https://api.render.com";
const START_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 10_000;
const BRIDGE_TIMEOUT_MS = 120_000;
const MAX_BRIDGE_ANSWER_BYTES = 1_000_000;
const MAX_BRIDGE_RUNS = 500;
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_BRIDGE_TOKEN_CHARS = 32;

const RENDER_RUN_ID = /^trn-[A-Za-z0-9]{1,64}$/;
const BRIDGE_RUN_ID = /^brn-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKFLOW_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,255}$/;
const PRINTABLE_NO_SPACE = /^[\x21-\x7e]+$/;

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

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EngineUnavailable(`${what} timed out`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readAnswer(value: unknown): EngineAnswer | null {
  const parsed = answerSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function renderSettings(): { readonly slug: string; readonly apiKey: string } {
  const slug = process.env.MEND_WORKFLOW_SLUG ?? "";
  const apiKey = process.env.RENDER_API_KEY ?? "";
  if (!WORKFLOW_SLUG.test(slug)) throw new ConfigError("MEND_WORKFLOW_SLUG must be the workflow's slug");
  if (!PRINTABLE_NO_SPACE.test(apiKey)) throw new ConfigError("RENDER_API_KEY is not set");
  return { slug, apiKey };
}

async function renderWorkflows(apiKey: string) {
  const { Render } = await import("@renderinc/sdk");
  // The base URL and mode are fixed here, so no RENDER_LOCAL_DEV_URL or
  // RENDER_USE_LOCAL_DEV in the environment can send the API key anywhere else.
  return new Render({ token: apiKey, baseUrl: RENDER_API, useLocalDev: false }).workflows;
}

function renderFailure(error: unknown): EngineUnavailable {
  if (error instanceof EngineUnavailable) return error;
  const status = typeof (error as { statusCode?: unknown })?.statusCode === "number" ? (error as { statusCode: number }).statusCode : null;
  const name = error instanceof Error ? error.name : "unknown";
  return new EngineUnavailable(`Render answered ${status ?? "nothing"} (${name})`);
}

async function startRenderRun(name: TaskName, args: readonly unknown[], options: RunOptions): Promise<string> {
  const { slug, apiKey } = renderSettings();
  let runId: string;
  try {
    const workflows = await renderWorkflows(apiKey);
    const started = await workflows.startTask(`${slug}/${name}`, [...args], {
      signal: AbortSignal.timeout(START_TIMEOUT_MS),
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    });
    runId = started.taskRunId;
  } catch (error) {
    throw renderFailure(error);
  }
  if (typeof runId !== "string" || !RENDER_RUN_ID.test(runId)) throw new EngineUnavailable("Render gave a run id of an unexpected shape");
  return runId;
}

async function readRenderRun(runId: string): Promise<Run> {
  const { apiKey } = renderSettings();
  let details: { status?: unknown; results?: unknown };
  try {
    const workflows = await renderWorkflows(apiKey);
    details = await withTimeout(workflows.getTaskRun(runId), READ_TIMEOUT_MS, "reading the run");
  } catch (error) {
    throw renderFailure(error);
  }
  // completed is the deprecated name for succeeded; any status not listed is still running.
  if (details.status === "completed" || details.status === "succeeded") {
    const answer = Array.isArray(details.results) && details.results.length >= 1 ? readAnswer(details.results[0]) : null;
    if (answer === null) {
      writeLog({ kind: "engine", outcome: "malformed_answer", run_id: runId });
      return { status: "failed" };
    }
    return { status: "succeeded", result: answer };
  }
  if (details.status === "failed" || details.status === "canceled") return { status: "failed" };
  return { status: "running" };
}

type BridgeRun = { readonly startedAt: number; readonly key: string | null; run: Run };
type BridgeStore = { readonly runs: Map<string, BridgeRun>; readonly keys: Map<string, string> };

// Kept on globalThis because Next.js may load this module once per route bundle: a run
// started by one route must be readable from GET /api/runs/[runId] in the same process.
const STORE_KEY = Symbol.for("mend.engine.bridgeRuns");
const holder = globalThis as typeof globalThis & { [STORE_KEY]?: BridgeStore };
const store: BridgeStore = (holder[STORE_KEY] ??= { runs: new Map(), keys: new Map() });
const bridgeRuns = store.runs;
const bridgeKeys = store.keys;

function bridgeSettings(): { readonly url: URL; readonly token: string } {
  let url: URL;
  try {
    url = new URL(process.env.MEND_BRIDGE_URL ?? "");
  } catch {
    throw new ConfigError("MEND_BRIDGE_URL must be the dev bridge's http address on this machine");
  }
  const bare = url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "";
  // The token travels with every call, so it is only ever sent to this machine.
  if (url.protocol !== "http:" || !isLoopback(url.hostname) || !bare) {
    throw new ConfigError("MEND_BRIDGE_URL must be the dev bridge's http address on this machine");
  }
  const token = process.env.MEND_BRIDGE_TOKEN ?? "";
  if (token.length < MIN_BRIDGE_TOKEN_CHARS || !PRINTABLE_NO_SPACE.test(token)) {
    throw new ConfigError("MEND_BRIDGE_TOKEN must be at least 32 printable characters");
  }
  return { url, token };
}

async function callBridge(url: URL, token: string, name: TaskName, args: readonly unknown[]): Promise<EngineAnswer> {
  const response = await fetch(new URL(`/tasks/${name}`, url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-mend-bridge-token": token },
    body: JSON.stringify({ args }),
    redirect: "error",
    signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
  });
  const text = await response.text();
  if (response.status !== 200) throw new EngineUnavailable(`the bridge answered ${response.status}`);
  if (Buffer.byteLength(text, "utf8") > MAX_BRIDGE_ANSWER_BYTES) throw new EngineUnavailable("the bridge answer is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EngineUnavailable("the bridge answer is not JSON");
  }
  const answer = readAnswer(parsed);
  if (answer === null) throw new EngineUnavailable("the bridge answer is not an engine answer");
  return answer;
}

function remember(runId: string, entry: BridgeRun): void {
  bridgeRuns.set(runId, entry);
  if (entry.key !== null) bridgeKeys.set(entry.key, runId);
  for (const [oldId, old] of bridgeRuns) {
    if (bridgeRuns.size <= MAX_BRIDGE_RUNS) break;
    bridgeRuns.delete(oldId);
    if (old.key !== null && bridgeKeys.get(old.key) === oldId) bridgeKeys.delete(old.key);
  }
}

function startBridgeRun(name: TaskName, args: readonly unknown[], options: RunOptions): string {
  const { url, token } = bridgeSettings();
  const key = options.idempotencyKey ?? null;
  if (key !== null) {
    const earlier = bridgeKeys.get(key);
    const entry = earlier === undefined ? undefined : bridgeRuns.get(earlier);
    if (earlier !== undefined && entry !== undefined && Date.now() - entry.startedAt < IDEMPOTENCY_WINDOW_MS) return earlier;
  }
  const runId = `brn-${randomUUID()}`;
  const entry: BridgeRun = { startedAt: Date.now(), key, run: { status: "running" } };
  remember(runId, entry);
  callBridge(url, token, name, args).then(
    (answer) => {
      entry.run = { status: "succeeded", result: answer };
    },
    (error: unknown) => {
      entry.run = { status: "failed" };
      writeLog({ kind: "engine", outcome: "bridge_failed", task: name, run_id: runId, reason: error instanceof Error ? error.message : "unknown" });
    },
  );
  return runId;
}

/**
 * Start task name with positional args and return the run id at once, without waiting
 * for the run. A repeat with the same idempotencyKey within 24 hours returns the first
 * run's id instead of starting another. Throws EngineUnavailable when the run cannot be
 * started and ConfigError when the engine settings are missing or wrong.
 */
export async function runTask(name: TaskName, args: readonly unknown[], options: RunOptions = {}): Promise<string> {
  checkedArguments(name, options);
  return devMode() ? startBridgeRun(name, args, options) : startRenderRun(name, args, options);
}

/** True when runId has the shape of a run id this deployment's engine mode issues. */
export function isRunId(runId: string): boolean {
  return devMode() ? BRIDGE_RUN_ID.test(runId) : RENDER_RUN_ID.test(runId);
}

/**
 * The run's state: running, succeeded with the engine's checked answer, or failed.
 * Throws RunNotFound for an id this deployment never issued and EngineUnavailable when
 * the state cannot be read.
 */
export async function getRun(runId: string): Promise<Run> {
  if (devMode()) {
    const entry = BRIDGE_RUN_ID.test(runId) ? bridgeRuns.get(runId) : undefined;
    if (entry === undefined) throw new RunNotFound();
    return entry.run;
  }
  if (!RENDER_RUN_ID.test(runId)) throw new RunNotFound();
  return readRenderRun(runId);
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

// Approval codes meaning the campaign is no longer the one the person saw: a different
// hash, a recipient who left (the row is gone, or leaving voided the campaign), or a
// campaign already approved or past approval. Reviewing it again is the way forward.
const CONFLICT_CODES: ReadonlySet<string> = new Set(["hash_mismatch", "recipient_not_member", "voided", "not_open", "approved_before"]);

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
