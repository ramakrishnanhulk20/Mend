import { randomUUID } from "node:crypto";
import { EngineUnavailable } from "@/server/engine";
import { authorize, failed, refuse, signedIn } from "@/server/permissions";
import { LIMITS, takeHit } from "@/server/ratelimit";
import { engineResponse } from "@/server/runs";

export const runtime = "nodejs";

const ROUTE = "GET /api/shop/quiet-regulars";
const WAIT_MS = 15_000;
const MAX_LIMIT = 50;
const LIMIT = /^[1-9][0-9]?$/;

/**
 * The shop's quiet regulars right now, most at risk first: ?limit= from 1 to 50,
 * default 50. Each row is a position, a synthetic display name, purchase days, days
 * silent, the model's score, what they paid net of refunds and whether they joined;
 * never an email, member id or customer ref (C12, C15). A demo or owner session is
 * required; 60 lists per session per hour. A run that takes longer than 15 seconds
 * answers 202 with a run id this session alone can poll.
 */
export async function GET(request: Request): Promise<Response> {
  const ref = randomUUID();
  try {
    const access = await authorize("shop.quiet_regulars", request);
    const principal = access.ok ? signedIn(access.principal) : null;
    if (!access.ok || principal === null) return refuse(ROUTE, ref, access.ok ? 403 : access.status, "not_allowed");
    const hit = await takeHit(LIMITS.quietRegulars, principal.sessionId);
    if (!hit.allowed) {
      return refuse(ROUTE, ref, 429, "rate_limited", { bucket: LIMITS.quietRegulars.bucket }, { "retry-after": String(hit.retryAfterSeconds) });
    }
    const given = new URL(request.url).searchParams.getAll("limit");
    if (given.length > 1 || (given.length === 1 && !LIMIT.test(given[0]))) return refuse(ROUTE, ref, 400, "invalid_input", { reason: "limit" });
    const limit = given.length === 0 ? MAX_LIMIT : Number(given[0]);
    if (limit > MAX_LIMIT) return refuse(ROUTE, ref, 400, "invalid_input", { reason: "limit" });

    const actor = { role: principal.role, session: principal.sessionId };
    return await engineResponse(request, ROUTE, ref, "quiet_regulars", [actor, limit], WAIT_MS, principal.sessionId);
  } catch (error) {
    return failed(ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}
