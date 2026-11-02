import { randomUUID } from "node:crypto";
import { stateChangeProblem } from "@/server/csrf";
import { EngineUnavailable, runSettled, runTask, waitForRun } from "@/server/engine";
import { writeLog } from "@/server/log";
import { authorize, failed, refuse, signedIn } from "@/server/permissions";
import { clientAddress, LIMITS, returnHit, takeHit } from "@/server/ratelimit";
import { pendingResponse, prefersAsync, successBody, waitedResponse } from "@/server/runs";

export const runtime = "nodejs";

const ROUTE = "POST /api/campaigns/[id]/submit";
const TASK = "submit_campaign";
const WAIT_MS = 30_000;
const CAMPAIGN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The engine answers sent false only when this call sent nothing to PayPal: the campaign
// was not approved, was already sent, or was voided before any send. Only an answer that
// passes the route's own schema counts, and every refusal or failed run keeps the draw.
// Never throws; a draw that cannot be given back only errs towards refusing.
async function giveBackUnsent(runId: string, address: string): Promise<void> {
  try {
    const run = await runSettled(runId);
    const body = run.status === "succeeded" && run.result !== undefined ? successBody(TASK, run.result) : null;
    // An attempt that moves no money or approves nothing costs the visitor no allowance; the per-session limit still applies.
    if (body?.sent === false) await returnHit(LIMITS.demoSubmitsAddress, address);
  } catch (error) {
    writeLog({ kind: "api", route: ROUTE, outcome: "hit_not_returned", exception: error instanceof Error ? error.name : "unknown" });
  }
}

/**
 * Send this session's approved campaign as its one Payouts batch (C1, C3). No body:
 * the batch is built from the snapshot frozen at approval, never from the request.
 * Calling again never sends a second batch; sent is true only for the call that sent
 * it. A demo session's batch must fit the demo pool every demo visitor shares (C20),
 * and demo submits are held to 4 a day per client address across its sessions, so one
 * address cannot spend the whole pool. An id of the wrong shape answers 404 before any
 * count is taken. A demo submit the engine answers with sent false, also after a 202,
 * gives its draw on the address's daily share back; the per-session count keeps it.
 * Same origin and CSRF token required; 10 submits per session per hour. A send slower
 * than 30 seconds answers 202 with a run id this session alone can poll.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const ref = randomUUID();
  try {
    const problem = stateChangeProblem(request);
    if (problem !== null) return refuse(ROUTE, ref, 403, "csrf_refused", { reason: problem });
    const access = await authorize("campaign.submit", request);
    const principal = access.ok ? signedIn(access.principal) : null;
    if (!access.ok || principal === null) return refuse(ROUTE, ref, access.ok ? 403 : access.status, "not_allowed");
    const { id } = await context.params;
    if (!CAMPAIGN_ID.test(id)) return refuse(ROUTE, ref, 404, "not_found", { reason: "malformed_id" });
    const demo = principal.role === "demo";
    const address = clientAddress(request.headers);
    for (const [limit, subject] of [
      [LIMITS.submit, principal.sessionId],
      ...(demo ? ([[LIMITS.demoSubmitsAddress, address]] as const) : []),
    ] as const) {
      const hit = await takeHit(limit, subject);
      if (!hit.allowed) return refuse(ROUTE, ref, 429, "rate_limited", { bucket: limit.bucket }, { "retry-after": String(hit.retryAfterSeconds) });
    }

    const actor = { role: principal.role, session: principal.sessionId };
    const runId = await runTask(TASK, [id, actor]);
    const givenBack = demo ? giveBackUnsent(runId, address) : Promise.resolve();
    if (prefersAsync(request)) return await pendingResponse(ROUTE, ref, TASK, runId, principal.sessionId);
    const waited = await waitForRun(runId, WAIT_MS);
    // A finished run's draw is settled before the answer, so a retry finds the count as it is.
    if (waited.state === "finished") await givenBack;
    return await waitedResponse(ROUTE, ref, TASK, waited, principal.sessionId);
  } catch (error) {
    return failed(ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}
