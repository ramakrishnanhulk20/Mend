import { randomUUID } from "node:crypto";
import { EngineUnavailable } from "@/server/engine";
import { authorize, failed, refuse, signedIn } from "@/server/permissions";
import { LIMITS, takeHit } from "@/server/ratelimit";
import { engineResponse } from "@/server/runs";

export const runtime = "nodejs";

const ROUTE = "GET /api/campaigns/[id]";
const WAIT_MS = 10_000;
const CAMPAIGN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * One campaign as the engine lets this session see it: the owner sees any, a demo
 * session only the ones it drafted (C19). A campaign this session may not see gets
 * the same 404 as one that does not exist. Rows carry refs, roles, ranks, amounts and
 * notes only, never an email or member id (C12). reviewHash is what approval needs back.
 * A view that takes longer than 10 seconds answers 202 with a run id for this session.
 * 429 rate_limited past 60 views a session an hour (C20), and 429 too_many_running while
 * two of this session's engine calls are still running.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const ref = randomUUID();
  try {
    const access = await authorize("campaign.view", request);
    const principal = access.ok ? signedIn(access.principal) : null;
    if (!access.ok || principal === null) return refuse(ROUTE, ref, access.ok ? 403 : access.status, "not_allowed");
    const { id } = await context.params;
    if (!CAMPAIGN_ID.test(id)) return refuse(ROUTE, ref, 404, "not_found", { reason: "malformed_id" });
    const hit = await takeHit(LIMITS.viewCampaign, principal.sessionId);
    if (!hit.allowed) {
      return refuse(ROUTE, ref, 429, "rate_limited", { bucket: LIMITS.viewCampaign.bucket }, { "retry-after": String(hit.retryAfterSeconds) });
    }

    const actor = { role: principal.role, session: principal.sessionId };
    return await engineResponse(request, ROUTE, ref, "view_campaign", [id, actor], WAIT_MS, principal.sessionId);
  } catch (error) {
    return failed(ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}
