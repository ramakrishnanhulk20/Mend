import { randomUUID } from "node:crypto";
import { EngineUnavailable } from "@/server/engine";
import { authorize, failed, refuse, signedIn } from "@/server/permissions";
import { LIMITS, takeHit } from "@/server/ratelimit";
import { engineResponse } from "@/server/runs";

export const runtime = "nodejs";

const ROUTE = "GET /api/campaigns/[id]/results";
const WAIT_MS = 15_000;
const CAMPAIGN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * This session's campaign results: rewarded against held back, with real and simulated
 * returns counted apart and only real ones in the rates and the verdict (C6, C8). A
 * campaign this session may not see gets the same 404 as one that does not exist
 * (C19). 240 reads per session per hour; a slow read answers 202 with a run id this
 * session alone can poll.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const ref = randomUUID();
  try {
    const access = await authorize("campaign.results", request);
    const principal = access.ok ? signedIn(access.principal) : null;
    if (!access.ok || principal === null) return refuse(ROUTE, ref, access.ok ? 403 : access.status, "not_allowed");
    const hit = await takeHit(LIMITS.results, principal.sessionId);
    if (!hit.allowed) {
      return refuse(ROUTE, ref, 429, "rate_limited", { bucket: LIMITS.results.bucket }, { "retry-after": String(hit.retryAfterSeconds) });
    }
    const { id } = await context.params;
    if (!CAMPAIGN_ID.test(id)) return refuse(ROUTE, ref, 404, "not_found", { reason: "malformed_id" });

    const actor = { role: principal.role, session: principal.sessionId };
    return await engineResponse(request, ROUTE, ref, "results", [id, actor], WAIT_MS, principal.sessionId);
  } catch (error) {
    return failed(ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}
