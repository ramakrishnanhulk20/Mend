import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readJsonBody, stateChangeProblem } from "@/server/csrf";
import { EngineUnavailable } from "@/server/engine";
import { authorize, failed, refuse, signedIn } from "@/server/permissions";
import { GLOBAL, LIMITS, takeHit } from "@/server/ratelimit";
import { engineResponse } from "@/server/runs";

export const runtime = "nodejs";

const ROUTE = "POST /api/campaigns/[id]/simulate";
const MAX_BODY_BYTES = 1024;
const WAIT_MS = 30_000;
const CAMPAIGN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BODY_STATUS = { not_json: 415, too_large: 413 } as const;
const BODY = z.strictObject({ ref: z.string().regex(/^R[1-9][0-9]{0,3}$/) });

/**
 * One sandbox return purchase by member {"ref"} of this session's sent campaign (C21):
 * the engine buys from this shop only, with PayPal's public sandbox test card, for a
 * fixed amount, at most 10 per campaign, and labels it simulated by the order id it
 * stored. Same origin and CSRF token required; 10 per session and 100 across every
 * visitor per hour (C20). Answers 201 with PayPal's order id and status, or 202 with a
 * run id this session alone can poll when PayPal is slow.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const ref = randomUUID();
  try {
    const problem = stateChangeProblem(request);
    if (problem !== null) return refuse(ROUTE, ref, 403, "csrf_refused", { reason: problem });
    const access = await authorize("campaign.simulate", request);
    const principal = access.ok ? signedIn(access.principal) : null;
    if (!access.ok || principal === null) return refuse(ROUTE, ref, access.ok ? 403 : access.status, "not_allowed");
    for (const [limit, subject] of [
      [LIMITS.simulate, principal.sessionId],
      [LIMITS.simulates, GLOBAL],
    ] as const) {
      const hit = await takeHit(limit, subject);
      if (!hit.allowed) return refuse(ROUTE, ref, 429, "rate_limited", { bucket: limit.bucket }, { "retry-after": String(hit.retryAfterSeconds) });
    }
    const { id } = await context.params;
    if (!CAMPAIGN_ID.test(id)) return refuse(ROUTE, ref, 404, "not_found", { reason: "malformed_id" });
    const reading = await readJsonBody(request, MAX_BODY_BYTES);
    if ("problem" in reading) {
      const status = reading.problem === "not_json" || reading.problem === "too_large" ? BODY_STATUS[reading.problem] : 400;
      return refuse(ROUTE, ref, status, "invalid_input", { reason: reading.problem });
    }
    const body = BODY.safeParse(reading.body);
    if (!body.success) return refuse(ROUTE, ref, 400, "invalid_input", { reason: "schema" });

    const actor = { role: principal.role, session: principal.sessionId };
    return await engineResponse(request, ROUTE, ref, "simulate_return", [id, body.data.ref, actor], WAIT_MS, principal.sessionId);
  } catch (error) {
    return failed(ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}
