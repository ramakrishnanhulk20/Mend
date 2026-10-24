import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { readJsonBody, stateChangeProblem } from "@/server/csrf";
import { EngineUnavailable } from "@/server/engine";
import { authorize, failed, refuse, signedIn } from "@/server/permissions";
import { LIMITS, takeHit } from "@/server/ratelimit";
import { engineResponse } from "@/server/runs";

export const runtime = "nodejs";

const ROUTE = "POST /api/campaigns";
const MAX_BODY_BYTES = 8192;
const WAIT_MS = 20_000;
const CLIENT_KEY = /^[A-Za-z0-9_-]{8,64}$/;
const BODY_STATUS = { not_json: 415, too_large: 413 } as const;

const BODY = z.strictObject({
  goalText: z.string().min(1).max(500),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  budgetMinor: z.number().int().min(1).max(100_000_000),
  perRecipientMinor: z.number().int().min(1).max(100_000_000),
  holdoutShare: z.string().regex(/^0\.\d{1,2}$/),
  maxCandidates: z.number().int().min(2).max(250),
});

/**
 * Draft a campaign through the engine for the signed-in session. Same origin and CSRF
 * token required; 20 drafts per session per hour. Caps, eligibility, holdout and
 * amounts are all the engine's (C4, C20). An optional Idempotency-Key header makes a
 * retry return the first draft; it is scoped to this session, so one visitor's key
 * can never return another visitor's run. Answers 201 with the draft's counts, or 202
 * with a run id this session alone can poll at /api/runs/[runId] when the engine takes
 * longer than 20 seconds or the request says Prefer: respond-async, or a generic refusal.
 */
export async function POST(request: Request): Promise<Response> {
  const ref = randomUUID();
  try {
    const problem = stateChangeProblem(request);
    if (problem !== null) return refuse(ROUTE, ref, 403, "csrf_refused", { reason: problem });
    const access = await authorize("campaign.draft", request);
    const principal = access.ok ? signedIn(access.principal) : null;
    if (!access.ok || principal === null) return refuse(ROUTE, ref, access.ok ? 403 : access.status, "not_allowed");
    const hit = await takeHit(LIMITS.draft, principal.sessionId);
    if (!hit.allowed) {
      return refuse(ROUTE, ref, 429, "rate_limited", { bucket: LIMITS.draft.bucket }, { "retry-after": String(hit.retryAfterSeconds) });
    }
    const reading = await readJsonBody(request, MAX_BODY_BYTES);
    if ("problem" in reading) {
      const status = reading.problem === "not_json" || reading.problem === "too_large" ? BODY_STATUS[reading.problem] : 400;
      return refuse(ROUTE, ref, status, "invalid_input", { reason: reading.problem });
    }
    const body = BODY.safeParse(reading.body);
    const clientKey = request.headers.get("idempotency-key");
    if (!body.success || (clientKey !== null && !CLIENT_KEY.test(clientKey))) {
      return refuse(ROUTE, ref, 400, "invalid_input", { reason: "schema" });
    }

    const settings = {
      goal_text: body.data.goalText,
      as_of: body.data.asOf,
      budget_minor: body.data.budgetMinor,
      per_recipient_minor: body.data.perRecipientMinor,
      holdout_share: body.data.holdoutShare,
      max_candidates: body.data.maxCandidates,
    };
    const actor = { role: principal.role, session: principal.sessionId };
    const idempotencyKey =
      clientKey === null ? undefined : `draft-${createHash("sha256").update(`${principal.sessionId}:${clientKey}`).digest("hex").slice(0, 40)}`;
    return await engineResponse(request, ROUTE, ref, "draft_campaign", [settings, actor], WAIT_MS, principal.sessionId, { idempotencyKey });
  } catch (error) {
    return failed(ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}
