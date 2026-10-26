import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readJsonBody, stateChangeProblem } from "@/server/csrf";
import { EngineUnavailable } from "@/server/engine";
import { authorize, failed, refuse, signedIn } from "@/server/permissions";
import { clientAddress, GLOBAL, LIMITS, takeHit } from "@/server/ratelimit";
import { engineResponse } from "@/server/runs";

export const runtime = "nodejs";

const ROUTE = "POST /api/campaigns/[id]/approve";
const MAX_BODY_BYTES = 1024;
const WAIT_MS = 20_000;
const CAMPAIGN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BODY_STATUS = { not_json: 415, too_large: 413 } as const;
const BODY = z.strictObject({ presentedHash: z.string().regex(/^[0-9a-f]{64}$/) });

/**
 * Approve this session's campaign exactly as it was shown, with {"presentedHash"}: the
 * reviewHash the campaign view gave (C2). The engine rebuilds the snapshot and
 * approves only if its hash matches, under the caller's caps (C4). Same origin and
 * CSRF token required; 20 approvals per session per hour, and demo approvals are held
 * to 10 an hour per client address and 100 an hour across every visitor (C20), so one
 * address opening many sessions cannot use up the rest. Answers 409 with hash_mismatch
 * when the campaign changed since it was shown, and with recipient_not_member or voided
 * when a recipient left; 202 with a run id this session alone can poll when the engine
 * is slow.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const ref = randomUUID();
  try {
    const problem = stateChangeProblem(request);
    if (problem !== null) return refuse(ROUTE, ref, 403, "csrf_refused", { reason: problem });
    const access = await authorize("campaign.approve", request);
    const principal = access.ok ? signedIn(access.principal) : null;
    if (!access.ok || principal === null) return refuse(ROUTE, ref, access.ok ? 403 : access.status, "not_allowed");
    for (const [limit, subject] of [
      [LIMITS.approve, principal.sessionId],
      ...(principal.role === "demo"
        ? ([
            [LIMITS.demoApprovalsAddress, clientAddress(request.headers)],
            [LIMITS.demoApprovals, GLOBAL],
          ] as const)
        : []),
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
    return await engineResponse(request, ROUTE, ref, "approve_campaign", [id, actor, body.data.presentedHash], WAIT_MS, principal.sessionId);
  } catch (error) {
    return failed(ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}
