import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readJsonBody, stateChangeProblem } from "@/server/csrf";
import { EngineUnavailable, runSettled, runTask, TOO_MANY_RUNNING, waitForRun } from "@/server/engine";
import { writeLog } from "@/server/log";
import { authorize, failed, refuse, signedIn } from "@/server/permissions";
import { clientAddress, GLOBAL, LIMITS, returnHit, takeHit, type Draw, type Limit } from "@/server/ratelimit";
import { pendingResponse, prefersAsync, waitedResponse } from "@/server/runs";

export const runtime = "nodejs";

const ROUTE = "POST /api/campaigns/[id]/simulate";
const TASK = "simulate_return";
const MAX_BODY_BYTES = 1024;
const WAIT_MS = 30_000;
const CAMPAIGN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BODY_STATUS = { not_json: 415, too_large: 413 } as const;
const BODY = z.strictObject({ ref: z.string().regex(/^R[1-9][0-9]{0,3}$/) });

// The engine found no campaign this session may see, or the call was never sent because
// two were already running: the shared pool's draw bought nothing, so it goes back (C20).
// Never throws; a draw that cannot be given back only errs towards refusing.
async function giveBackUnspent(runId: string, session: string): Promise<void> {
  try {
    const run = await runSettled(runId);
    const code = run.status === "succeeded" && run.result !== undefined && !run.result.ok ? run.result.error : null;
    if (code === "not_found" || code === TOO_MANY_RUNNING) await returnHit(LIMITS.simulates, GLOBAL, { session });
  } catch (error) {
    writeLog({ kind: "api", route: ROUTE, outcome: "hit_not_returned", exception: error instanceof Error ? error.name : "unknown" });
  }
}

/**
 * One sandbox return purchase by member {"ref"} of this session's sent campaign (C21):
 * the engine buys from this shop only, with PayPal's public sandbox test card, for a
 * fixed amount, at most 10 per campaign, and labels it simulated by the order id it
 * stored. Same origin and CSRF token required. The campaign id and the body are checked
 * first, so a request that cannot be a purchase is counted nowhere; then 10 per session
 * and 10 per client address per hour, and demo simulates 100 across every demo visitor
 * per hour, the last 20 kept for sessions that have not simulated this hour (C20), a
 * pool the owner's simulates never draw on. A demo simulate the engine answers not_found
 * for, or never runs, gives its draw on that pool back. Answers 201 with PayPal's order
 * id and status, or 202 with a run id this session alone can poll when PayPal is slow.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const ref = randomUUID();
  try {
    const problem = stateChangeProblem(request);
    if (problem !== null) return refuse(ROUTE, ref, 403, "csrf_refused", { reason: problem });
    const access = await authorize("campaign.simulate", request);
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
    const limits: readonly (readonly [Limit, string, Draw])[] = [
      [LIMITS.simulate, principal.sessionId, {}],
      [LIMITS.simulateAddress, clientAddress(request.headers), {}],
      ...(demo ? ([[LIMITS.simulates, GLOBAL, { session: principal.sessionId }]] as const) : []),
    ];
    for (const [limit, subject, draw] of limits) {
      const hit = await takeHit(limit, subject, draw);
      if (!hit.allowed) return refuse(ROUTE, ref, 429, "rate_limited", { bucket: limit.bucket }, { "retry-after": String(hit.retryAfterSeconds) });
    }

    const actor = { role: principal.role, session: principal.sessionId };
    const runId = await runTask(TASK, [id, body.data.ref, actor]);
    const givenBack = demo ? giveBackUnspent(runId, principal.sessionId) : Promise.resolve();
    if (prefersAsync(request)) return await pendingResponse(ROUTE, ref, TASK, runId, principal.sessionId);
    const waited = await waitForRun(runId, WAIT_MS);
    // A finished run's draw is settled before the answer, so a retry finds the pool as it is.
    if (waited.state === "finished") await givenBack;
    return await waitedResponse(ROUTE, ref, TASK, waited, principal.sessionId);
  } catch (error) {
    return failed(ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}
