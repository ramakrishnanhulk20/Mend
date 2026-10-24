import { randomUUID } from "node:crypto";
import { stateChangeProblem } from "@/server/csrf";
import { EngineUnavailable } from "@/server/engine";
import { authorize, failed, refuse, signedIn } from "@/server/permissions";
import { LIMITS, takeHit } from "@/server/ratelimit";
import { engineResponse } from "@/server/runs";

export const runtime = "nodejs";

const ROUTE = "POST /api/campaigns/[id]/submit";
const WAIT_MS = 30_000;
const CAMPAIGN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Send this session's approved campaign as its one Payouts batch (C1, C3). No body:
 * the batch is built from the snapshot frozen at approval, never from the request.
 * Calling again never sends a second batch; sent is true only for the call that sent
 * it. A demo session's batch must fit the demo pool every demo visitor shares (C20).
 * Same origin and CSRF token required; 10 submits per session per hour. A send slower
 * than 30 seconds answers 202 with a run id this session alone can poll.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const ref = randomUUID();
  try {
    const problem = stateChangeProblem(request);
    if (problem !== null) return refuse(ROUTE, ref, 403, "csrf_refused", { reason: problem });
    const access = await authorize("campaign.submit", request);
    const principal = access.ok ? signedIn(access.principal) : null;
    if (!access.ok || principal === null) return refuse(ROUTE, ref, access.ok ? 403 : access.status, "not_allowed");
    const hit = await takeHit(LIMITS.submit, principal.sessionId);
    if (!hit.allowed) {
      return refuse(ROUTE, ref, 429, "rate_limited", { bucket: LIMITS.submit.bucket }, { "retry-after": String(hit.retryAfterSeconds) });
    }
    const { id } = await context.params;
    if (!CAMPAIGN_ID.test(id)) return refuse(ROUTE, ref, 404, "not_found", { reason: "malformed_id" });

    const actor = { role: principal.role, session: principal.sessionId };
    return await engineResponse(request, ROUTE, ref, "submit_campaign", [id, actor], WAIT_MS, principal.sessionId);
  } catch (error) {
    return failed(ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}
