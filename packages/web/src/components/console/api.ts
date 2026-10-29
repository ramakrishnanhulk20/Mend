import { z, type ZodType } from "zod";
import type { HistoryEntry } from "./agent";

const CSRF_HEADER = "x-mend-csrf";
const POLL_EVERY_MS = 2000;
const POLL_UNTIL_MS = 120_000;
const MAX_RETRY_AFTER_SECONDS = 3600;

export class ApiError extends Error {
  status: number;
  code: string;
  retryAfterSeconds: number | null;
  ref: string | null;

  constructor(
    status: number,
    code: string,
    details: { message?: string; retryAfterSeconds?: number | null; ref?: string | null } = {},
  ) {
    super(details.message ?? code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
    this.ref = details.ref ?? null;
  }
}

/** Whole seconds from a Retry-After header, only when it is 0 to 3600. HTTP dates are not used by our routes. */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (!/^\d{1,4}$/.test(text)) return null;
  const seconds = Number(text);
  return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : null;
}

const ErrorBody = z.looseObject({
  error: z.string().min(1).max(64),
  ref: z.string().max(64).nullish(),
  message: z.string().max(300).nullish(),
});

export async function readError(response: Response): Promise<ApiError> {
  const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const parsed = ErrorBody.safeParse(body);
  if (!parsed.success) return new ApiError(response.status, "unexpected", { retryAfterSeconds });
  return new ApiError(response.status, parsed.data.error, {
    message: parsed.data.message ?? undefined,
    retryAfterSeconds,
    ref: parsed.data.ref ?? null,
  });
}

export const SessionSchema = z.discriminatedUnion("signedIn", [
  z.looseObject({ signedIn: z.literal(false), csrf: z.string().min(1) }),
  z.looseObject({
    signedIn: z.literal(true),
    role: z.string().min(1),
    expiresAt: z.string().min(1),
    csrf: z.string().min(1),
  }),
]);

export const DemoSessionSchema = z.looseObject({
  signedIn: z.literal(true),
  role: z.literal("demo"),
  expiresAt: z.string().min(1),
  csrf: z.string().min(1),
});

const LogoutSchema = z.looseObject({ signedIn: z.literal(false) });

const count = z.number().int().min(0);

const QuietRegularSchema = z.looseObject({
  position: z.number().int().min(1),
  displayName: z.string(),
  purchaseDays: count,
  daysSilent: count,
  score: z.number().min(0),
  // Net of refunds, so a customer who was refunded more than they paid would read below zero.
  paidNetMinor: z.number().int(),
  member: z.boolean(),
  // True for a demo stand-in the seed script joined. Older answers have no such field.
  standIn: z.boolean().default(false),
});

export const QuietRegularsSchema = z.looseObject({
  asOf: z.string().nullable(),
  total: count,
  rows: z.array(QuietRegularSchema),
});

const PlanSettingsSchema = z.looseObject({
  goalText: z.string(),
  asOf: z.string(),
  budgetMinor: z.number().int().min(1),
  perRecipientMinor: z.number().int().min(1),
  holdoutShare: z.string().regex(/^0\.\d{2}$/),
  maxCandidates: z.number().int().min(2),
});

export const PlanSchema = z.looseObject({
  settings: PlanSettingsSchema.nullable(),
  changes: z.array(z.string()),
  goal: z.enum([
    "read",
    "unclear",
    "no_key",
    "limit_reached",
    "claude_token_cap",
    "outbound_refused",
    "timed_out",
    "declined",
    "busy",
    "unavailable",
    "unreadable",
  ]),
  notice: z.string().nullable(),
});

// A draft that finished while the page was polling comes back as the plain draft: no plan, no aiCalls.
export const DraftSchema = z.looseObject({
  campaignId: z.string().min(1),
  candidates: count,
  rewarded: count,
  heldBack: count,
  totalMinor: count,
  plan: PlanSchema.optional(),
  aiCalls: count.optional(),
});

const CampaignRowSchema = z.looseObject({
  ref: z.string().min(1),
  role: z.enum(["reward", "holdout"]),
  rank: z.number().int().min(1),
  // Null when the customer has left the list. Older answers have no such field. Either way the row shows only its rank.
  displayName: z.string().nullish(),
  amountMinor: count.nullable(),
  note: z.string().nullable(),
  standIn: z.boolean(),
});

export const CampaignViewSchema = z.looseObject({
  campaignId: z.string().min(1),
  status: z.string(),
  goalText: z.string(),
  asOf: z.string(),
  budgetMinor: count,
  perRecipientMinor: count,
  holdoutShare: z.string(),
  totalMinor: count,
  rows: z.array(CampaignRowSchema),
  reviewHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  reviewProblem: z.string().nullable(),
});

export const NotesSchema = z.looseObject({
  campaignId: z.string().min(1),
  rewarded: count,
  written: count,
  template: count,
  skipped: count,
  ai: z.enum(["used", "no_key"]),
  stopped: z.enum(["limit_reached", "claude_token_cap", "outbound_refused", "timed_out"]).nullable(),
  notice: z.string().nullable(),
  aiCalls: count,
});

export const ApprovedSchema = z.looseObject({
  campaignId: z.string().min(1),
  snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
  approvedAt: z.string().min(1),
});

export const SubmitSchema = z.looseObject({
  campaignId: z.string().min(1),
  status: z.string(),
  sent: z.boolean(),
  payoutBatchId: z.string().nullable(),
});

export const SimulateSchema = z.looseObject({
  campaignId: z.string().min(1),
  ref: z.string().min(1),
  paypalOrderId: z.string().min(1),
  paypalStatus: z.string().min(1),
});

const ArmSchema = z.looseObject({
  members: count,
  realReturns: count,
  realRate: z.number().min(0).max(1).nullable(),
  simulatedReturns: count,
});

const PayoutsSchema = z.looseObject({
  items: count,
  byStatus: z.record(z.string(), count),
  claimedMinor: count,
  unclaimedMinor: count,
  returnedMinor: count,
  failedMinor: count,
  pendingMinor: count,
  unclaimedReturnBy: z.string().nullable(),
});

const ResultRowSchema = z.looseObject({
  ref: z.string().min(1),
  role: z.enum(["reward", "holdout"]),
  rank: z.number().int().min(1),
  displayName: z.string().nullish(),
  standIn: z.boolean(),
  // Mend's ledger word for the reward's payment, such as UNCLAIMED. Null for a held-back row or a reward not sent yet.
  payoutStatus: z.string().nullable(),
  simulatedReturn: z.boolean(),
  realReturn: z.boolean(),
});

export const ResultsSchema = z.looseObject({
  campaignId: z.string().min(1),
  status: z.string(),
  rewarded: ArmSchema,
  holdout: ArmSchema,
  spendMinor: count,
  feesMinor: count,
  windowStartsAt: z.string().nullable(),
  windowEndsAt: z.string().nullable(),
  windowOpen: z.boolean(),
  pValue: z.number().min(0).max(1).nullable(),
  verdict: z.string().min(1),
  payouts: PayoutsSchema,
  rows: z.array(ResultRowSchema),
});

export const CancelSchema = z.looseObject({
  campaignId: z.string().min(1),
  cancelled: count,
  returnedMinor: count,
  stillUnclaimed: count,
  notCancellable: count,
  incomplete: z.boolean(),
  // PayPal's own error, kept here for the logs; the visitor is never shown it.
  paypalStatus: z.number().int().nullable(),
  paypalName: z.string().nullable(),
});

export const AgentSchema = z.looseObject({
  reply: z.string().min(1),
  toolsUsed: z.array(z.string()),
  stopped: z.enum(["tool_limit", "declined"]).nullable(),
  aiCalls: count,
});

// Any other 202 field (the plan route adds some) is passed through and ignored here.
const RunningSchema = z.looseObject({
  status: z.string(),
  runId: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
});

export type Session = z.infer<typeof SessionSchema>;
export type DemoSession = z.infer<typeof DemoSessionSchema>;
export type QuietRegulars = z.infer<typeof QuietRegularsSchema>;
export type QuietRegular = z.infer<typeof QuietRegularSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type Draft = z.infer<typeof DraftSchema>;
export type CampaignRow = z.infer<typeof CampaignRowSchema>;
export type CampaignView = z.infer<typeof CampaignViewSchema>;
export type Notes = z.infer<typeof NotesSchema>;
export type Approved = z.infer<typeof ApprovedSchema>;
export type Submitted = z.infer<typeof SubmitSchema>;
export type Simulated = z.infer<typeof SimulateSchema>;
export type Results = z.infer<typeof ResultsSchema>;
export type ResultRow = z.infer<typeof ResultRowSchema>;
export type Cancelled = z.infer<typeof CancelSchema>;
export type AgentAnswer = z.infer<typeof AgentSchema>;

type RequestOptions = { signal?: AbortSignal };

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function parseBody<T>(response: Response, schema: ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    // 502, not the real status: the server said yes but sent something we cannot read.
    throw new ApiError(502, "unexpected_answer", { message: "The answer was not JSON" });
  }
  const result = schema.safeParse(json);
  if (!result.success) throw new ApiError(502, "unexpected_answer", { message: "The answer had an unexpected shape" });
  return result.data;
}

type ConsoleApiOptions = {
  /** Called whenever the server answers 401, before the error reaches the caller: the session is gone. */
  onUnauthorized?: () => void;
};

export function createConsoleApi(
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  hooks: ConsoleApiOptions = {},
) {
  let csrf: string | null = null;
  // React runs effects twice in development; two session reads at once would each issue
  // an anonymous cookie and the token we keep could belong to the cookie the browser dropped.
  let sessionRead: Promise<Session> | null = null;

  async function send(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method === "POST") {
      if (csrf === null) await session();
      if (csrf !== null) headers[CSRF_HEADER] = csrf;
    }
    try {
      return await fetchFn(path, {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new ApiError(0, "network", { message: "The request did not reach the server" });
    }
  }

  async function pollRun<T>(runId: string, schema: ZodType<T>, signal: AbortSignal | undefined): Promise<T> {
    const startedAt = Date.now();
    for (;;) {
      if (Date.now() - startedAt >= POLL_UNTIL_MS) {
        throw new ApiError(504, "still_running", { message: "The run did not finish in time" });
      }
      await sleep(POLL_EVERY_MS, signal);
      const response = await send("GET", `/api/runs/${encodeURIComponent(runId)}`, undefined, signal);
      if (response.status === 202) continue;
      if (!response.ok) throw await readError(response);
      return parseBody(response, schema);
    }
  }

  async function request<T>(
    method: "GET" | "POST",
    path: string,
    schema: ZodType<T>,
    body?: unknown,
    requestOptions: RequestOptions = {},
  ): Promise<T> {
    try {
      const response = await send(method, path, body, requestOptions.signal);
      if (response.status === 202) {
        const running = await parseBody(response, RunningSchema);
        return await pollRun(running.runId, schema, requestOptions.signal);
      }
      if (!response.ok) throw await readError(response);
      return await parseBody(response, schema);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) hooks.onUnauthorized?.();
      throw error;
    }
  }

  function session(): Promise<Session> {
    if (sessionRead !== null) return sessionRead;
    sessionRead = (async () => {
      try {
        const answer = await request("GET", "/api/session", SessionSchema);
        csrf = answer.csrf;
        return answer;
      } finally {
        sessionRead = null;
      }
    })();
    return sessionRead;
  }

  async function startDemo(): Promise<DemoSession> {
    const answer = await request("POST", "/api/session/demo", DemoSessionSchema);
    csrf = answer.csrf;
    return answer;
  }

  async function logout(): Promise<void> {
    try {
      await request("POST", "/api/session/logout", LogoutSchema);
    } finally {
      // The token was bound to the session that just ended, so it is no good either way.
      csrf = null;
    }
  }

  function quietRegulars(limit: number, options: RequestOptions = {}): Promise<QuietRegulars> {
    return request("GET", `/api/shop/quiet-regulars?limit=${limit}`, QuietRegularsSchema, undefined, options);
  }

  // budgetMinor is the form's budget field; it goes along only when the person filled it in.
  function plan(goalText: string, options: RequestOptions & { budgetMinor?: number } = {}): Promise<Draft> {
    const { budgetMinor, signal } = options;
    const body = budgetMinor === undefined ? { goalText } : { goalText, budgetMinor };
    return request("POST", "/api/campaigns/plan", DraftSchema, body, { signal });
  }

  function view(campaignId: string, options: RequestOptions = {}): Promise<CampaignView> {
    return request("GET", `/api/campaigns/${encodeURIComponent(campaignId)}`, CampaignViewSchema, undefined, options);
  }

  // Claude writes one note per customer, so this one call can take up to two minutes.
  function writeNotes(campaignId: string, options: RequestOptions = {}): Promise<Notes> {
    return request("POST", `/api/campaigns/${encodeURIComponent(campaignId)}/notes`, NotesSchema, undefined, options);
  }

  function approve(campaignId: string, presentedHash: string, options: RequestOptions = {}): Promise<Approved> {
    return request(
      "POST",
      `/api/campaigns/${encodeURIComponent(campaignId)}/approve`,
      ApprovedSchema,
      { presentedHash },
      options,
    );
  }

  // The batch goes to PayPal in one call, so a slow PayPal can keep this one waiting.
  function submit(campaignId: string, requestOptions: RequestOptions = {}): Promise<Submitted> {
    return request("POST", `/api/campaigns/${encodeURIComponent(campaignId)}/submit`, SubmitSchema, undefined, requestOptions);
  }

  function results(campaignId: string, requestOptions: RequestOptions = {}): Promise<Results> {
    return request("GET", `/api/campaigns/${encodeURIComponent(campaignId)}/results`, ResultsSchema, undefined, requestOptions);
  }

  function simulate(campaignId: string, ref: string, requestOptions: RequestOptions = {}): Promise<Simulated> {
    return request(
      "POST",
      `/api/campaigns/${encodeURIComponent(campaignId)}/simulate`,
      SimulateSchema,
      { ref },
      requestOptions,
    );
  }

  function cancelUnclaimed(campaignId: string, requestOptions: RequestOptions = {}): Promise<Cancelled> {
    return request(
      "POST",
      `/api/campaigns/${encodeURIComponent(campaignId)}/cancel-unclaimed`,
      CancelSchema,
      undefined,
      requestOptions,
    );
  }

  // Claude answers in this one call, so it can take up to a minute. The history goes along only when there is some.
  function ask(message: string, history: readonly HistoryEntry[], requestOptions: RequestOptions = {}): Promise<AgentAnswer> {
    const body = history.length === 0 ? { message } : { message, history };
    return request("POST", "/api/agent", AgentSchema, body, requestOptions);
  }

  return {
    session,
    startDemo,
    logout,
    quietRegulars,
    plan,
    view,
    writeNotes,
    approve,
    submit,
    results,
    simulate,
    cancelUnclaimed,
    ask,
    request,
  };
}

export type ConsoleApi = ReturnType<typeof createConsoleApi>;
