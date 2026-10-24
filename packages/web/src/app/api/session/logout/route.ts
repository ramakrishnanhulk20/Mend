import { randomUUID } from "node:crypto";
import { endCurrentSession } from "@/server/auth";
import { stateChangeProblem } from "@/server/csrf";
import { writeLog } from "@/server/log";
import { authorize, failed, refuse, reply } from "@/server/permissions";

export const runtime = "nodejs";

const ROUTE = "POST /api/session/logout";

/** Sign out: deletes the session so its token is dead everywhere, and clears the cookie. Same origin and CSRF token required. */
export async function POST(request: Request): Promise<Response> {
  const ref = randomUUID();
  try {
    const problem = stateChangeProblem(request);
    if (problem !== null) return refuse(ROUTE, ref, 403, "csrf_refused", { reason: problem });
    const access = await authorize("session.end", request);
    if (!access.ok) return refuse(ROUTE, ref, access.status, "not_allowed");
    const cookie = await endCurrentSession(request);
    writeLog({ kind: "api", route: ROUTE, ref, status: 200, outcome: "session_ended", role: access.principal.role });
    return reply(200, { signedIn: false }, [cookie]);
  } catch (error) {
    return failed(ROUTE, ref, error);
  }
}
