import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readJsonBody, stateChangeProblem } from "@/server/csrf";
import { EngineUnavailable, runSettled, runTask, TOO_MANY_RUNNING, waitForRun } from "@/server/engine";
import { writeLog } from "@/server/log";
import { authorize, failed, refuse, signedIn } from "@/server/permissions";
import { clientAddress, GLOBAL, LIMITS, returnHit, takeHit, type Draw, type Limit } from "@/server/ratelimit";
import { pendingResponse, prefersAsync, waitedResponse } from "@/server/runs";

export const runtime = "nodejs";

const ROUTE = "POST /api/campaigns/[id]/approve";
const TASK = "approve_campaign";
const MAX_BODY_BYTES = 1024;
const WAIT_MS = 20_000;
const CAMPAIGN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BODY_STATUS = { not_json: 415, too_large: 413 } as const;
const BODY = z.strictObject({ presentedHash: z.string().regex(/^[0-9a-f]{64}$/) });

// The engine found no campaign this session may see, or the call was never sent because
// two were already running: the shared pool's draw bought nothing, so it goes back (C20);
// the address's share stays spent, so one address cannot probe unknown ids without end.
// A presented hash that did not match gives back only the address's share: the shared
// draw stays spent, so refused approvals across every visitor, and their audit rows, stay
// bounded. Never throws; a draw that cannot be given back only errs towards refusing.
async function giveBackUnspent(runId: string, session: string, address: string): Promise<void> {
  try {
    const run = await runSettled(runId);
    const code = run.status === "succeeded" && run.result !== undefined && !run.result.ok ? run.result.error : null;
    if (code === "not_found" || code === TOO_MANY_RUNNING) await returnHit(LIMITS.demoApprovals, GLOBAL, { session });
    // An attempt that moves no money or approves nothing costs the visitor no allowance; the per-session limit still applies.
    if (code === "hash_mismatch") await returnHit(LIMITS.demoApprovalsAddress, address);
  } catch (error) {
    writeLog({ kind: "api", route: ROUTE, outcome: "hit_not_returned", exception: error instanceof Error ? error.name : "unknown" });
  }
}

/**
 * Approve this session's campaign exactly as it was shown, with {"presentedHash"}: the
 * reviewHash the campaign view gave (C2). The engine rebuilds the snapshot and
 * approves only if its hash matches, under the caller's caps (C4). Same origin and
 * CSRF token required. The campaign id and the body are checked first, so a request
 * that cannot be an approval is counted nowhere (404 for an id of the wrong shape, 400,
 * 413 or 415 for the body); then 20 approvals per session per hour, and demo approvals
 * are held to 10 an hour per client address and 100 an hour across every visitor, the
 * last 20 of them kept for sessions that have not approved this hour (C20). A demo
 * approval the engine answers not_found for, or never runs, gives its draw on the shared
 * pool back; one it answers hash_mismatch for gives back its draw on the address's share
 * and keeps its draws on the shared pool and the per-session count. Answers 409 with
 * hash_mismatch when the campaign changed since it was shown, and with
 * recipient_not_member or voided when a recipient left; 202 with a run id this session
 * alone can poll when the engine is slow.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const ref = randomUUID();
  try {
    const problem = stateChangeProblem(request);
    if (problem !== null) return refuse(ROUTE, ref, 403, "csrf_refused", { reason: problem });
    const access = await authorize("campaign.approve", request);
    const principal = access.ok ? signedIn(access.principal) : null;
    if (!access.ok || principal === null) return refuse(ROUTE, ref, access.ok ? 403 : access.status, "not_allowed");
    const { id } = await context.params;
    if (!CAMPAIGN_ID.test(id)) return refuse(ROUTE, ref, 404, "not_found", { reason: "malformed_id" });
    const reading = await readJsonBody(request, MAX_BODY_BYTES);
    if ("problem" in reading) {
      const status = reading.problem === "not_json" || reading.problem === "too_large" ? BODY_STATUS[reading.problem] : 400;
      return refuse(ROUTE, ref, status, "invalid_input", { reason: reading.problem });
    }
    const body = BODY.safeParse(reading.body);
    if (!body.success) return refuse(ROUTE, ref, 400, "invalid_input", { reason: "schema" });

    const demo = principal.role === "demo";
    const address = clientAddress(request.headers);
    const limits: readonly (readonly [Limit, string, Draw])[] = [
      [LIMITS.approve, principal.sessionId, {}],
      ...(demo
        ? ([
            [LIMITS.demoApprovalsAddress, address, {}],
            [LIMITS.demoApprovals, GLOBAL, { session: principal.sessionId }],
          ] as const)
        : []),
    ];
    for (const [limit, subject, draw] of limits) {
      const hit = await takeHit(limit, subject, draw);
      if (!hit.allowed) return refuse(ROUTE, ref, 429, "rate_limited", { bucket: limit.bucket }, { "retry-after": String(hit.retryAfterSeconds) });
    }

    const actor = { role: principal.role, session: principal.sessionId };
    const runId = await runTask(TASK, [id, actor, body.data.presentedHash]);
    const givenBack = demo ? giveBackUnspent(runId, principal.sessionId, address) : Promise.resolve();
    if (prefersAsync(request)) return await pendingResponse(ROUTE, ref, TASK, runId, principal.sessionId);
    const waited = await waitForRun(runId, WAIT_MS);
    // A finished run's draw is settled before the answer, so a retry finds the pool as it is.
    if (waited.state === "finished") await givenBack;
    return await waitedResponse(ROUTE, ref, TASK, waited, principal.sessionId);
  } catch (error) {
    return failed(ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}
