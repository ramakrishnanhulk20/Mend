import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ClaudeSession, FAILURE_MESSAGES, hasClaudeKey } from "@/server/claude";
import { readJsonBody, stateChangeProblem } from "@/server/csrf";
import { EngineUnavailable, statusForEngineError } from "@/server/engine";
import { cleanGoal, planCampaign, type PlanSummary } from "@/server/goal";
import { writeLog } from "@/server/log";
import { authorize, failed, refuse, reply, signedIn } from "@/server/permissions";
import { clientAddress, LIMITS, takeHit } from "@/server/ratelimit";
import { recordRun } from "@/server/runs";

export const runtime = "nodejs";

const ROUTE = "POST /api/campaigns/plan";
const MAX_BODY_BYTES = 8192;
const DEADLINE_MS = 60_000;
const BODY_STATUS = { not_json: 415, too_large: 413 } as const;

const BODY = z.strictObject({
  goalText: z.string().min(1).max(500),
  budgetMinor: z.number().int().min(1).max(100_000_000).optional(),
  perRecipientMinor: z.number().int().min(1).max(100_000_000).optional(),
  holdoutShare: z.string().regex(/^0\.\d{1,2}$/).optional(),
  maxCandidates: z.number().int().min(1).max(10_000).optional(),
});

const count = z.number().int().min(0);
const GOAL_STATUS = z.enum(["read", "unclear", "no_key", "limit_reached", "claude_token_cap", "outbound_refused", "timed_out", "declined", "busy", "unavailable", "unreadable"]);
const PLAN = z.strictObject({
  settings: z
    .strictObject({
      goalText: z.string().min(1).max(500),
      asOf: z.iso.date(),
      budgetMinor: z.number().int().min(1),
      perRecipientMinor: z.number().int().min(1),
      holdoutShare: z.string().regex(/^0\.\d{2}$/),
      maxCandidates: z.number().int().min(2).max(250),
    })
    .nullable(),
  changes: z.array(z.string().min(1).max(300)).max(10),
  goal: GOAL_STATUS,
  notice: z.string().max(300).nullable(),
});
const DRAFTED = z.strictObject({
  campaignId: z.uuid(),
  candidates: count,
  rewarded: count,
  heldBack: count,
  totalMinor: count,
  plan: PLAN,
  aiCalls: count,
});
const RUNNING = z.strictObject({ status: z.literal("running"), runId: z.string().regex(/^(?:brn|trn)-[A-Za-z0-9-]{1,80}$/), plan: PLAN, aiCalls: count });

function shown(plan: PlanSummary): z.input<typeof PLAN> {
  const notice = plan.goal === "read" || plan.goal === "unclear" ? null : FAILURE_MESSAGES[plan.goal];
  return { settings: plan.settings, changes: [...plan.changes], goal: plan.goal, notice };
}

/**
 * Plan and draft a campaign from the owner's words (C4, C11, C15, C20). Body: goalText,
 * plus any of budgetMinor, perRecipientMinor, holdoutShare and maxCandidates from the
 * form, which win over what is read from the text. Same origin and CSRF token
 * required; counts against the session's 20 drafts an hour. With a key, Claude reads
 * the numbers in the goal (one call, on the daily caps); with none, or when Claude is
 * unavailable or the daily limit is used up, the form decides and the answer says so
 * in plan.notice. Every value is clamped to the caller's caps with each change listed
 * in plan.changes, then the engine drafts. Answers 201 with the draft's counts and the
 * plan, 202 with a run id this session alone can poll while the engine works, 422
 * needs_budget when neither the goal nor the form gives a budget, or a refusal.
 */
export async function POST(request: Request): Promise<Response> {
  const ref = randomUUID();
  try {
    const problem = stateChangeProblem(request);
    if (problem !== null) return refuse(ROUTE, ref, 403, "csrf_refused", { reason: problem });
    const access = await authorize("campaign.plan", request);
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
    const goalText = body.success ? cleanGoal(body.data.goalText) : "";
    if (!body.success || goalText === "") return refuse(ROUTE, ref, 400, "invalid_input", { reason: "schema" });
    const form = {
      budgetMinor: body.data.budgetMinor,
      perRecipientMinor: body.data.perRecipientMinor,
      holdoutShare: body.data.holdoutShare,
      maxCandidates: body.data.maxCandidates,
    };

    const session = hasClaudeKey() ? new ClaudeSession(principal, ref, DEADLINE_MS, clientAddress(request.headers)) : null;
    try {
      const planned = await planCampaign(principal, goalText, form, session);
      const aiCalls = session?.calls ?? 0;
      if (planned.kind === "drafted") {
        writeLog({ kind: "api", route: ROUTE, ref, status: 201, outcome: "planned", goal: planned.plan.goal, changes: planned.plan.changes.length, ai_calls: aiCalls });
        return reply(201, DRAFTED.parse({ ...planned.draft, plan: shown(planned.plan), aiCalls }));
      }
      if (planned.kind === "pending") {
        await recordRun(planned.runId, principal.sessionId, "draft_campaign");
        writeLog({ kind: "api", route: ROUTE, ref, status: 202, outcome: "running", task: "draft_campaign", run_id: planned.runId });
        return reply(202, RUNNING.parse({ status: "running", runId: planned.runId, plan: shown(planned.plan), aiCalls }));
      }
      if (planned.kind === "needs_budget") {
        const notice = shown(planned.plan).notice;
        writeLog({ kind: "api", route: ROUTE, ref, status: 422, outcome: "refused", error: "needs_budget", goal: planned.plan.goal });
        return reply(422, { error: "needs_budget", message: `${notice === null ? "" : `${notice} `}Give a budget, in the goal or in the form.`, ref });
      }
      if (planned.kind === "no_shop_data") return refuse(ROUTE, ref, 422, "no_shop_data");
      if (planned.kind === "refused") return refuse(ROUTE, planned.engineRef, statusForEngineError(planned.code), planned.code);
      return refuse(ROUTE, ref, 500, "internal", { reason: planned.reason });
    } finally {
      session?.close();
    }
  } catch (error) {
    return failed(ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}
