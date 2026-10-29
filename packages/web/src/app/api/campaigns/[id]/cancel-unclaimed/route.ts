import { randomUUID } from "node:crypto";
import { stateChangeProblem } from "@/server/csrf";
import { EngineUnavailable } from "@/server/engine";
import { authorize, failed, refuse, signedIn } from "@/server/permissions";
import { LIMITS, takeHit } from "@/server/ratelimit";
import { engineResponse } from "@/server/runs";

export const runtime = "nodejs";

const ROUTE = "POST /api/campaigns/[id]/cancel-unclaimed";
const WAIT_MS = 30_000;
const CAMPAIGN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Pull back the rewards of this session's sent campaign that nobody has claimed yet,
 * through PayPal's cancel call, so the money returns to the shop. No body: only the
 * campaign id and the caller reach the engine. Answers the engine's counts: rewards
 * cancelled, money returned, rewards still unclaimed and rewards PayPal would not
 * cancel. When PayPal fails on some rewards it still answers 200 with those counts,
 * incomplete true, and PayPal's HTTP status and error code; a reward PayPal gave no
 * clear answer for counts as still unclaimed. A campaign never sent answers 409
 * not_submitted; the engine out of reach answers 503. Same origin and CSRF token
 * required; 10 per session per hour. A cancel slower than 30 seconds answers 202 with
 * a run id this session alone can poll.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const ref = randomUUID();
  try {
    const problem = stateChangeProblem(request);
    if (problem !== null) return refuse(ROUTE, ref, 403, "csrf_refused", { reason: problem });
    const access = await authorize("campaign.cancel_unclaimed", request);
    const principal = access.ok ? signedIn(access.principal) : null;
    if (!access.ok || principal === null) return refuse(ROUTE, ref, access.ok ? 403 : access.status, "not_allowed");
    const hit = await takeHit(LIMITS.cancelUnclaimed, principal.sessionId);
    if (!hit.allowed) {
      return refuse(ROUTE, ref, 429, "rate_limited", { bucket: LIMITS.cancelUnclaimed.bucket }, { "retry-after": String(hit.retryAfterSeconds) });
    }
    const { id } = await context.params;
    if (!CAMPAIGN_ID.test(id)) return refuse(ROUTE, ref, 404, "not_found", { reason: "malformed_id" });

    const actor = { role: principal.role, session: principal.sessionId };
    return await engineResponse(request, ROUTE, ref, "cancel_unclaimed", [id, actor], WAIT_MS, principal.sessionId);
  } catch (error) {
    return failed(ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}
