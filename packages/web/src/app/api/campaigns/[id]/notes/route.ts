import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ClaudeSession, FAILURE_MESSAGES, hasClaudeKey } from "@/server/claude";
import { stateChangeProblem } from "@/server/csrf";
import { EngineUnavailable, statusForEngineError } from "@/server/engine";
import { writeLog } from "@/server/log";
import { writeNotes } from "@/server/notes";
import { authorize, failed, refuse, reply, signedIn } from "@/server/permissions";
import { LIMITS, takeHit } from "@/server/ratelimit";

export const runtime = "nodejs";

const ROUTE = "POST /api/campaigns/[id]/notes";
const CAMPAIGN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Long enough for 20 notes at four at a time; anything still unwritten keeps the template.
const DEADLINE_MS = 120_000;

const count = z.number().int().min(0);
const WRITTEN = z.strictObject({
  campaignId: z.uuid(),
  rewarded: count,
  written: count,
  template: count,
  skipped: count,
  ai: z.enum(["used", "no_key"]),
  stopped: z.enum(["limit_reached", "outbound_refused", "timed_out"]).nullable(),
  notice: z.string().max(300).nullable(),
  aiCalls: count,
});

/**
 * Write a personal thank-you note for every rewarded customer of this session's draft
 * campaign (C6, C11, C13, C15, C20): one Claude call per customer, from that customer's
 * own item names and recency only, each note checked against the note rules, the
 * template wherever a note fails or Claude cannot be used. Held-back customers never
 * get a note. Same origin and CSRF token required; counts against the session's 20
 * drafts an hour, and every Claude call against the daily caps. With no key, notes
 * stay the template and notice says why. Answers 200 with the counts, 422
 * not_editable once the campaign is not a draft, or a refusal.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const ref = randomUUID();
  try {
    const problem = stateChangeProblem(request);
    if (problem !== null) return refuse(ROUTE, ref, 403, "csrf_refused", { reason: problem });
    const access = await authorize("campaign.notes", request);
    const principal = access.ok ? signedIn(access.principal) : null;
    if (!access.ok || principal === null) return refuse(ROUTE, ref, access.ok ? 403 : access.status, "not_allowed");
    const hit = await takeHit(LIMITS.draft, principal.sessionId);
    if (!hit.allowed) {
      return refuse(ROUTE, ref, 429, "rate_limited", { bucket: LIMITS.draft.bucket }, { "retry-after": String(hit.retryAfterSeconds) });
    }
    const { id } = await context.params;
    if (!CAMPAIGN_ID.test(id)) return refuse(ROUTE, ref, 404, "not_found", { reason: "malformed_id" });

    const session = hasClaudeKey() ? new ClaudeSession(principal, ref, DEADLINE_MS) : null;
    try {
      const result = await writeNotes(principal, id, session);
      if (result.kind === "not_draft") return refuse(ROUTE, ref, 422, "not_editable");
      if (result.kind === "refused") return refuse(ROUTE, result.engineRef, statusForEngineError(result.code), result.code);
      if (result.kind === "failed") return refuse(ROUTE, ref, 500, "internal", { reason: result.reason });
      const notice = result.ai === "no_key" ? FAILURE_MESSAGES.no_key : result.stopped === null ? null : FAILURE_MESSAGES[result.stopped];
      const aiCalls = session?.calls ?? 0;
      writeLog({ kind: "api", route: ROUTE, ref, status: 200, outcome: "notes", written: result.written, template: result.template, skipped: result.skipped, ai_calls: aiCalls });
      return reply(
        200,
        WRITTEN.parse({
          campaignId: id,
          rewarded: result.rewarded,
          written: result.written,
          template: result.template,
          skipped: result.skipped,
          ai: result.ai,
          stopped: result.stopped,
          notice,
          aiCalls,
        }),
      );
    } finally {
      session?.close();
    }
  } catch (error) {
    return failed(ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}
