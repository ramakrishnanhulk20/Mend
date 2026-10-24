import { randomUUID } from "node:crypto";
import { EngineUnavailable, runTask, waitForRun, type Waited } from "@/server/engine";
import { authorize, failed, refuse, reply } from "@/server/permissions";
import { finishedResponse, successBody } from "@/server/runs";

export const runtime = "nodejs";

const ROUTE = "GET /api/shop/summary";
const CACHE_MS = 60_000;
const WAIT_MS = 15_000;
const RETRY_AFTER_SECONDS = "5";

type Cached = { readonly body: Readonly<Record<string, unknown>>; readonly until: number };

// One answer is shared by every visitor for 60 seconds, and at most one engine run is
// in flight: concurrent requests wait on the same run, and a run that outlasts the wait
// is picked up by the next request instead of starting another. That bounds what the
// public landing page can cost the engine, so the route needs no rate limit of its own.
let cached: Cached | null = null;
let refreshing: Promise<Waited> | null = null;
let unfinishedRunId: string | null = null;

async function refresh(): Promise<Waited> {
  const runId = unfinishedRunId ?? (await runTask("shop_summary", []));
  const waited = await waitForRun(runId, WAIT_MS);
  unfinishedRunId = waited.state === "pending" ? runId : null;
  if (waited.state === "finished" && waited.status === "succeeded" && waited.result !== undefined) {
    const body = successBody("shop_summary", waited.result);
    if (body !== null) cached = { body, until: Date.now() + CACHE_MS };
  }
  return waited;
}

/**
 * The landing page's live numbers: shop customers, members, quiet regulars right now
 * and what they paid in the last 12 months, plus the model's stored proof facts (null
 * when they were never stored, never made up). Public: no session needed. Counts only,
 * never a name, email, member id or customer ref. Answers 503 with Retry-After when the
 * engine has not answered within 15 seconds.
 */
export async function GET(request: Request): Promise<Response> {
  const ref = randomUUID();
  try {
    const access = await authorize("shop.summary", request);
    if (!access.ok) return refuse(ROUTE, ref, access.status, "not_allowed");
    if (cached !== null && cached.until > Date.now()) return reply(200, cached.body);
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    const waited = await refreshing;
    if (waited.state === "pending") {
      return refuse(ROUTE, ref, 503, "engine_unavailable", { reason: "summary_still_running" }, { "retry-after": RETRY_AFTER_SECONDS });
    }
    return finishedResponse(ROUTE, ref, "shop_summary", waited.runId, waited);
  } catch (error) {
    return failed(ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}
