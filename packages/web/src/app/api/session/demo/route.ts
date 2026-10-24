import { randomUUID } from "node:crypto";
import { startSession } from "@/server/auth";
import { csrfTokenForSession, stateChangeProblem } from "@/server/csrf";
import { writeLog } from "@/server/log";
import { authorize, failed, refuse, reply } from "@/server/permissions";
import { clientAddress, LIMITS, takeHit } from "@/server/ratelimit";

export const runtime = "nodejs";

const ROUTE = "POST /api/session/demo";

/**
 * Start a demo session: no password, and the engine holds it to demo caps and its own
 * campaigns. Same origin and CSRF token required; 20 per client address per hour. Any
 * session the browser had is ended first, and the answer carries the CSRF token bound
 * to the new session.
 */
export async function POST(request: Request): Promise<Response> {
  const ref = randomUUID();
  try {
    const problem = stateChangeProblem(request);
    if (problem !== null) return refuse(ROUTE, ref, 403, "csrf_refused", { reason: problem });
    const access = await authorize("session.start", request);
    if (!access.ok) return refuse(ROUTE, ref, access.status, "not_allowed");
    const hit = await takeHit(LIMITS.demoSession, clientAddress(request.headers));
    if (!hit.allowed) {
      return refuse(ROUTE, ref, 429, "rate_limited", { bucket: LIMITS.demoSession.bucket }, { "retry-after": String(hit.retryAfterSeconds) });
    }
    const { session, cookie } = await startSession(request, "demo");
    const csrf = csrfTokenForSession(session.sessionId);
    writeLog({ kind: "api", route: ROUTE, ref, status: 200, outcome: "session_started", role: "demo" });
    return reply(200, { signedIn: true, role: "demo", expiresAt: session.expiresAt.toISOString(), csrf }, [cookie]);
  } catch (error) {
    return failed(ROUTE, ref, error);
  }
}
