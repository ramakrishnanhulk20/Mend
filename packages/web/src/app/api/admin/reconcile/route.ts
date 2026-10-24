import { randomUUID } from "node:crypto";
import { stateChangeProblem } from "@/server/csrf";
import { EngineUnavailable } from "@/server/engine";
import { authorize, failed, refuse, signedIn } from "@/server/permissions";
import { LIMITS, takeHit } from "@/server/ratelimit";
import { engineResponse } from "@/server/runs";

export const runtime = "nodejs";

const ROUTE = "POST /api/admin/reconcile";
const WAIT_MS = 30_000;

/**
 * Owner only: settle campaigns whose batch outcome is unknown, never sending a second
 * batch (C3), the job the scheduler runs. Same origin and CSRF token required; 30 admin
 * jobs per session per hour. Answers what it looked at, or 202 with a run id this
 * session alone can poll.
 */
export async function POST(request: Request): Promise<Response> {
  const ref = randomUUID();
  try {
    const problem = stateChangeProblem(request);
    if (problem !== null) return refuse(ROUTE, ref, 403, "csrf_refused", { reason: problem });
    const access = await authorize("admin.reconcile", request);
    const principal = access.ok ? signedIn(access.principal) : null;
    if (!access.ok || principal === null) return refuse(ROUTE, ref, access.ok ? 403 : access.status, "not_allowed");
    const hit = await takeHit(LIMITS.admin, principal.sessionId);
    if (!hit.allowed) {
      return refuse(ROUTE, ref, 429, "rate_limited", { bucket: LIMITS.admin.bucket }, { "retry-after": String(hit.retryAfterSeconds) });
    }
    return await engineResponse(request, ROUTE, ref, "reconcile", [], WAIT_MS, principal.sessionId);
  } catch (error) {
    return failed(ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}
