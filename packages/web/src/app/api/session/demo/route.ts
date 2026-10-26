import { randomUUID } from "node:crypto";
import { appendAudit, inTransaction } from "@/server/audit";
import { startSession } from "@/server/auth";
import { csrfTokenForSession, stateChangeProblem } from "@/server/csrf";
import { writeLog } from "@/server/log";
import { authorize, failed, refuse, reply } from "@/server/permissions";
import { addressTag, clientAddress, LIMITS, sessionTag, takeHit } from "@/server/ratelimit";

export const runtime = "nodejs";

const ROUTE = "POST /api/session/demo";

/**
 * Start a demo session: no password, and the engine holds it to demo caps and its own
 * campaigns. Same origin and CSRF token required; 4 per client address an hour and 10
 * a day (C20). Any session the browser had is ended first. Ending it, the new session
 * and its audit row commit together or not at all, so a failed audit write fails the
 * sign-in (C23). The answer carries the CSRF token bound to the new session.
 */
export async function POST(request: Request): Promise<Response> {
  const ref = randomUUID();
  try {
    const problem = stateChangeProblem(request);
    if (problem !== null) return refuse(ROUTE, ref, 403, "csrf_refused", { reason: problem });
    const access = await authorize("session.start", request);
    if (!access.ok) return refuse(ROUTE, ref, access.status, "not_allowed");
    const address = clientAddress(request.headers);
    for (const limit of [LIMITS.demoSession, LIMITS.demoSessionDay]) {
      const hit = await takeHit(limit, address);
      if (!hit.allowed) return refuse(ROUTE, ref, 429, "rate_limited", { bucket: limit.bucket }, { "retry-after": String(hit.retryAfterSeconds) });
    }
    const { session, cookie } = await inTransaction(async (client) => {
      const started = await startSession(request, "demo", client);
      const detail = { role: "demo", session_tag: sessionTag(started.session.sessionId), address_tag: addressTag(address), ref };
      await appendAudit("demo_session_started", detail, { client });
      return started;
    });
    const csrf = csrfTokenForSession(session.sessionId);
    writeLog({ kind: "api", route: ROUTE, ref, status: 200, outcome: "session_started", role: "demo" });
    return reply(200, { signedIn: true, role: "demo", expiresAt: session.expiresAt.toISOString(), csrf }, [cookie]);
  } catch (error) {
    return failed(ROUTE, ref, error);
  }
}
