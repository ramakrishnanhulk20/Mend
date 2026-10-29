import { TOO_MANY_RUNNING } from "@/server/engine";

/** True when the caller asks for JSON and not HTML: a script or a test, never a browser navigation. */
export function wantsJson(request: Request): boolean {
  const types = (request.headers.get("accept") ?? "").split(",").map((range) => range.split(";")[0].trim().toLowerCase());
  return types.includes("application/json") && !types.includes("text/html");
}

const RESULT_CODE = /^[a-z][a-z_]{0,63}$/;

/**
 * A person's answer: 303 to /join/done carrying only a result code, never cached, with
 * any Set-Cookie values given and an empty body. too_many_running reads as rate_limited,
 * and a code of any other shape as internal, so nothing but one short lowercase word
 * reaches the address. The path is fixed, never built from the request (C24).
 */
export function toResultPage(code: string, cookies: readonly string[] = []): Response {
  const result = code === TOO_MANY_RUNNING ? "rate_limited" : RESULT_CODE.test(code) ? code : "internal";
  const headers = new Headers({ location: `/join/done?result=${result}`, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}
