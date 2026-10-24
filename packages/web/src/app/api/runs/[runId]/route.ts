import { randomUUID } from "node:crypto";
import { EngineUnavailable, isRunId, RunNotFound, waitForRun, type Waited } from "@/server/engine";
import { authorize, failed, refuse, signedIn } from "@/server/permissions";
import { LIMITS, takeHit } from "@/server/ratelimit";
import { finishedResponse, ownedRunTask, runningResponse } from "@/server/runs";

export const runtime = "nodejs";

const ROUTE = "GET /api/runs/[runId]";

/**
 * Poll an engine run a route answered 202 for. Only the session that started it gets
 * an answer: 202 while it runs, then exactly what the original route would have
 * answered. Every other session, and every id nobody started, gets the same 404, so
 * the answer says nothing about whose run an id is (C19). One poll every 2 seconds
 * for an hour per session.
 */
export async function GET(request: Request, context: { params: Promise<{ runId: string }> }): Promise<Response> {
  const ref = randomUUID();
  try {
    const access = await authorize("run.read", request);
    const principal = access.ok ? signedIn(access.principal) : null;
    if (!access.ok || principal === null) return refuse(ROUTE, ref, access.ok ? 403 : access.status, "not_allowed");
    const hit = await takeHit(LIMITS.runPoll, principal.sessionId);
    if (!hit.allowed) {
      return refuse(ROUTE, ref, 429, "rate_limited", { bucket: LIMITS.runPoll.bucket }, { "retry-after": String(hit.retryAfterSeconds) });
    }
    const { runId } = await context.params;
    const task = isRunId(runId) ? await ownedRunTask(runId, principal.sessionId) : null;
    if (task === null) return refuse(ROUTE, ref, 404, "not_found", { reason: "not_this_sessions_run" });
    let waited: Waited;
    try {
      waited = await waitForRun(runId, 0);
    } catch (error) {
      if (error instanceof RunNotFound) return refuse(ROUTE, ref, 404, "not_found", { reason: "run_gone" });
      throw error;
    }
    if (waited.state === "pending") return runningResponse(ROUTE, ref, task, runId);
    return finishedResponse(ROUTE, ref, task, runId, waited);
  } catch (error) {
    return failed(ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}
