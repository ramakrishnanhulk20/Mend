import { randomUUID } from "node:crypto";
import { csrfTokenForRequest } from "@/server/csrf";
import { authorize, failed, reply, signedIn } from "@/server/permissions";

export const runtime = "nodejs";

const ROUTE = "GET /api/session";

/**
 * Who this browser is signed in as, and the CSRF token its pages send back on every
 * state change. Signed out is an ordinary answer here, not an error. The token is
 * bound to the browser's session, or to an anonymous id cookie issued here when it
 * has neither; reading the session records its use.
 */
export async function GET(request: Request): Promise<Response> {
  const ref = randomUUID();
  try {
    const access = await authorize("session.read", request);
    const { token: csrf, cookies } = csrfTokenForRequest(request);
    const principal = access.ok ? signedIn(access.principal) : null;
    if (principal === null) return reply(200, { signedIn: false, csrf }, cookies);
    return reply(200, { signedIn: true, role: principal.role, expiresAt: principal.expiresAt.toISOString(), csrf }, cookies);
  } catch (error) {
    return failed(ROUTE, ref, error);
  }
}
