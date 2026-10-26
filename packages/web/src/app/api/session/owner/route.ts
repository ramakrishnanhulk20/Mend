import { randomUUID } from "node:crypto";
import { z } from "zod";
import { appendAudit, inTransaction } from "@/server/audit";
import { MAX_PASSWORD_CHARS, ownerPasswordMatches, startSession } from "@/server/auth";
import { csrfTokenForSession, readJsonBody, stateChangeProblem } from "@/server/csrf";
import { writeLog } from "@/server/log";
import { authorize, failed, refuse, reply } from "@/server/permissions";
import { addressTag, clientAddress, LIMITS, sessionTag, takeHit } from "@/server/ratelimit";

export const runtime = "nodejs";

const ROUTE = "POST /api/session/owner";
const MAX_BODY_BYTES = 4096;
const BODY = z.strictObject({ password: z.string().min(1).max(MAX_PASSWORD_CHARS) });
const BODY_STATUS = { not_json: 415, too_large: 413 } as const;

/**
 * Owner sign-in with {"password": ...}. Same origin and CSRF token required, and 10
 * attempts per client address in 15 minutes, counted before the password is looked
 * at. A wrong password gets 401, a log line and a best-effort audit row; the right one
 * ends any session the browser had and starts an owner session with a new token and
 * the CSRF token bound to it. Ending the old session, the new one and its audit row
 * commit together or not at all, so a failed audit write fails the sign-in (C23).
 */
export async function POST(request: Request): Promise<Response> {
  const ref = randomUUID();
  try {
    const problem = stateChangeProblem(request);
    if (problem !== null) return refuse(ROUTE, ref, 403, "csrf_refused", { reason: problem });
    const access = await authorize("session.start", request);
    if (!access.ok) return refuse(ROUTE, ref, access.status, "not_allowed");
    const address = clientAddress(request.headers);
    const hit = await takeHit(LIMITS.signIn, address);
    if (!hit.allowed) {
      return refuse(ROUTE, ref, 429, "rate_limited", { bucket: LIMITS.signIn.bucket }, { "retry-after": String(hit.retryAfterSeconds) });
    }
    const reading = await readJsonBody(request, MAX_BODY_BYTES);
    if ("problem" in reading) {
      const status = reading.problem === "not_json" || reading.problem === "too_large" ? BODY_STATUS[reading.problem] : 400;
      return refuse(ROUTE, ref, status, "invalid_input", { reason: reading.problem });
    }
    const body = BODY.safeParse(reading.body);
    if (!body.success) return refuse(ROUTE, ref, 400, "invalid_input", { reason: "schema" });
    if (!ownerPasswordMatches(body.data.password)) {
      await appendAudit("owner_sign_in", { role: "owner", outcome: "refused", reason: "wrong_password", address_tag: addressTag(address), ref });
      return refuse(ROUTE, ref, 401, "sign_in_refused", { reason: "wrong_password" });
    }
    const { session, cookie } = await inTransaction(async (client) => {
      const started = await startSession(request, "owner", client);
      const detail = { role: "owner", outcome: "signed_in", session_tag: sessionTag(started.session.sessionId), address_tag: addressTag(address), ref };
      await appendAudit("owner_sign_in", detail, { client });
      return started;
    });
    const csrf = csrfTokenForSession(session.sessionId);
    writeLog({ kind: "api", route: ROUTE, ref, status: 200, outcome: "session_started", role: "owner" });
    return reply(200, { signedIn: true, role: "owner", expiresAt: session.expiresAt.toISOString(), csrf }, [cookie]);
  } catch (error) {
    return failed(ROUTE, ref, error);
  }
}
