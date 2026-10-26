import { randomUUID } from "node:crypto";
import { appendAudit, inTransaction } from "@/server/audit";
import { endCurrentSession } from "@/server/auth";
import { stateChangeProblem } from "@/server/csrf";
import { writeLog } from "@/server/log";
import { authorize, failed, refuse, reply, signedIn } from "@/server/permissions";
import { addressTag, clientAddress, sessionTag } from "@/server/ratelimit";

export const runtime = "nodejs";

const ROUTE = "POST /api/session/logout";

/**
 * Sign out: deletes the session so its token is dead everywhere, and clears the cookie.
 * Same origin and CSRF token required. The delete and its audit row commit together or
 * not at all, so a failed audit write leaves the session signed in (C23).
 */
export async function POST(request: Request): Promise<Response> {
  const ref = randomUUID();
  try {
    const problem = stateChangeProblem(request);
    if (problem !== null) return refuse(ROUTE, ref, 403, "csrf_refused", { reason: problem });
    const access = await authorize("session.end", request);
    const principal = access.ok ? signedIn(access.principal) : null;
    if (!access.ok || principal === null) return refuse(ROUTE, ref, access.ok ? 403 : access.status, "not_allowed");
    const cookie = await inTransaction(async (client) => {
      const cleared = await endCurrentSession(request, client);
      const detail = { role: principal.role, session_tag: sessionTag(principal.sessionId), address_tag: addressTag(clientAddress(request.headers)), ref };
      await appendAudit("sign_out", detail, { client });
      return cleared;
    });
    writeLog({ kind: "api", route: ROUTE, ref, status: 200, outcome: "session_ended", role: principal.role });
    return reply(200, { signedIn: false }, [cookie]);
  } catch (error) {
    return failed(ROUTE, ref, error);
  }
}
