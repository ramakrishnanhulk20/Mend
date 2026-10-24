// Covers the same-origin check, the session-bound and anonymous CSRF tokens, the
// secret that signs them, and the bounded JSON body reader. Does NOT cover: which
// routes call them (npm run prove:m7a and prove:m7b send foreign-origin, tokenless and
// cross-session requests to the running app), or script on our own origin (C14).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "./config";
import {
  csrfBinding,
  csrfSecret,
  csrfTokenFor,
  csrfTokenForRequest,
  csrfTokenForSession,
  originProblem,
  readJsonBody,
  stateChangeProblem,
  tokenProblem,
} from "./csrf";
import { sessionIdFor } from "./sessions";

const BASE = "https://mend.example";
const SECRET = "csrf-secret-for-tests-0123456789abcdef";
const SESSION_A = `s1.${"A".repeat(43)}`;
const SESSION_B = `s1.${"B".repeat(43)}`;
const ANONYMOUS = `a1.${"C".repeat(43)}`;

function request(headers: Record<string, string>, init: RequestInit = {}): Request {
  return new Request(`${BASE}/api/campaigns`, { method: "POST", headers, ...init });
}

function signedIn(session: string, token: string, extra: Record<string, string> = {}): Request {
  return request({ origin: BASE, cookie: `__Host-mend_session=${session}`, "x-mend-csrf": token, ...extra });
}

function tokenA(): string {
  return csrfTokenForSession(sessionIdFor(SESSION_A));
}

function guarded(extra: Record<string, string> = {}): Request {
  return signedIn(SESSION_A, tokenA(), extra);
}

beforeEach(() => {
  vi.stubEnv("MEND_DEV", "0");
  vi.stubEnv("MEND_BASE_URL", BASE);
  vi.stubEnv("MEND_CSRF_SECRET", SECRET);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("originProblem", () => {
  it("passes our own origin", () => {
    expect(originProblem(guarded())).toBeNull();
  });

  it.each([
    [{}, "missing_origin"],
    [{ origin: "https://evil.example" }, "foreign_origin"],
    [{ origin: "https://mend.example.evil.example" }, "foreign_origin"],
    [{ origin: "http://mend.example" }, "foreign_origin"],
    [{ origin: "https://mend.example:8443" }, "foreign_origin"],
    [{ origin: "null" }, "bad_origin"],
    [{ origin: "https://mend.example/" }, "bad_origin"],
    [{ origin: "https://mend.example/api" }, "bad_origin"],
    [{ origin: "https://user@mend.example" }, "bad_origin"],
  ])("refuses %j as %s", (headers, problem) => {
    expect(originProblem(request(headers))).toBe(problem);
  });

  it("ignores Host and X-Forwarded-* headers, so a forged host cannot become our origin (C24)", () => {
    const forged = { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" };
    expect(originProblem(request({ ...forged, origin: "https://evil.example" }))).toBe("foreign_origin");
    expect(originProblem(request({ ...forged, origin: BASE }))).toBeNull();
  });

  it("refuses everything when MEND_BASE_URL is missing", () => {
    vi.stubEnv("MEND_BASE_URL", "");
    expect(() => originProblem(guarded())).toThrow();
  });
});

describe("tokenProblem", () => {
  it("passes a session's own token, bound to its session id hash", () => {
    expect(tokenProblem(guarded())).toBeNull();
    expect(stateChangeProblem(guarded())).toBeNull();
  });

  it("refuses a token from session A in session B", () => {
    expect(tokenProblem(signedIn(SESSION_B, tokenA()))).toBe("token_mismatch");
    expect(tokenProblem(signedIn(SESSION_B, csrfTokenForSession(sessionIdFor(SESSION_B))))).toBeNull();
  });

  it("passes an anonymous browser's token only with the anonymous id it was issued for", () => {
    const issued = csrfTokenForRequest(request({}));
    const cookie = issued.cookies[0].split(";")[0];
    expect(tokenProblem(request({ origin: BASE, cookie, "x-mend-csrf": issued.token }))).toBeNull();
    expect(tokenProblem(request({ origin: BASE, cookie: `__Host-mend_csrf=${ANONYMOUS}`, "x-mend-csrf": issued.token }))).toBe("token_mismatch");
  });

  it("never lets an anonymous token pass for a session, or the reverse, even for the same id", () => {
    const id = sessionIdFor(SESSION_A);
    expect(csrfTokenFor({ kind: "anonymous", id })).not.toBe(csrfTokenFor({ kind: "session", id }));
    const anonymousToken = csrfTokenForRequest(request({ cookie: `__Host-mend_csrf=${ANONYMOUS}` })).token;
    const both = `__Host-mend_session=${SESSION_A}; __Host-mend_csrf=${ANONYMOUS}`;
    expect(tokenProblem(signedIn(SESSION_A, anonymousToken, { cookie: both }))).toBe("token_mismatch");
    expect(tokenProblem(request({ origin: BASE, cookie: `__Host-mend_csrf=${ANONYMOUS}`, "x-mend-csrf": tokenA() }))).toBe("token_mismatch");
  });

  it("refuses a token signed with any other secret", () => {
    const token = tokenA();
    vi.stubEnv("MEND_CSRF_SECRET", `${SECRET}-rotated`);
    expect(tokenProblem(signedIn(SESSION_A, token))).toBe("token_mismatch");
  });

  it.each([
    [{ origin: BASE, cookie: `__Host-mend_session=${SESSION_A}` }, "missing_token"],
    [{ origin: BASE, "x-mend-csrf": `c2.${"D".repeat(43)}` }, "missing_token"],
    [{ origin: BASE, cookie: `__Host-mend_session=${SESSION_A}`, "x-mend-csrf": "c2.short" }, "missing_token"],
    [{ origin: BASE, cookie: `__Host-mend_session=${SESSION_A}`, "x-mend-csrf": `c1.${"D".repeat(43)}` }, "missing_token"],
    [{ origin: BASE, cookie: `__Host-mend_session=${SESSION_A}`, "x-mend-csrf": `c2.${"D".repeat(43)}` }, "token_mismatch"],
    [{ origin: BASE, cookie: "__Host-mend_csrf=a1.short", "x-mend-csrf": `c2.${"D".repeat(43)}` }, "missing_token"],
  ])("refuses %j as %s", (headers, problem) => {
    expect(tokenProblem(request(headers))).toBe(problem);
  });

  it("over https ignores a plain mend_session cookie, which a sibling host could have planted", () => {
    const planted = request({ origin: BASE, cookie: `mend_session=${SESSION_A}`, "x-mend-csrf": tokenA() });
    expect(csrfBinding(planted)).toBeNull();
    expect(tokenProblem(planted)).toBe("missing_token");
  });

  it("treats a session cookie sent twice as no session, so its token does not pass", () => {
    const doubled = `__Host-mend_session=${SESSION_A}; __Host-mend_session=${SESSION_B}`;
    expect(tokenProblem(signedIn(SESSION_A, tokenA(), { cookie: doubled }))).toBe("missing_token");
  });

  it("checks the origin before the token", () => {
    expect(stateChangeProblem(guarded({ origin: "https://evil.example" }))).toBe("foreign_origin");
  });
});

describe("tokens, cookies and the secret", () => {
  it("are c2. plus a 32-byte HMAC, the same every time for one session", () => {
    expect(tokenA()).toMatch(/^c2\.[A-Za-z0-9_-]{43}$/);
    expect(tokenA()).toBe(tokenA());
    expect(() => csrfTokenForSession("not-a-session-id")).toThrow();
  });

  it("give a signed-in browser its session's token and no new cookie", () => {
    expect(csrfTokenForRequest(request({ cookie: `__Host-mend_session=${SESSION_A}` }))).toEqual({ token: tokenA(), cookies: [] });
  });

  it("give a browser with nothing to bind to a new anonymous id in a __Host- cookie over https", () => {
    const first = csrfTokenForRequest(request({}));
    const second = csrfTokenForRequest(request({}));
    expect(first.cookies).toHaveLength(1);
    expect(first.cookies[0]).toMatch(/^__Host-mend_csrf=a1\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=86400; HttpOnly; SameSite=Lax; Secure$/);
    expect(first.token).not.toBe(second.token);
  });

  it("use the plain mend_csrf name only over http to this machine in development", () => {
    vi.stubEnv("MEND_DEV", "1");
    vi.stubEnv("MEND_BASE_URL", "http://127.0.0.1:3000");
    expect(csrfTokenForRequest(request({})).cookies[0]).toMatch(/^mend_csrf=a1\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=86400; HttpOnly; SameSite=Lax$/);
  });

  it.each([undefined, "", "x".repeat(31), "€".repeat(10)])("refuse a secret of %j (under 32 bytes), so nothing is signed", (secret) => {
    vi.stubEnv("MEND_CSRF_SECRET", secret);
    expect(() => csrfSecret()).toThrow(ConfigError);
    expect(() => tokenA()).toThrow(ConfigError);
    expect(() => tokenProblem(request({ origin: BASE, cookie: `__Host-mend_session=${SESSION_A}`, "x-mend-csrf": `c2.${"D".repeat(43)}` }))).toThrow(ConfigError);
  });

  it("accept a secret of 32 bytes or more", () => {
    vi.stubEnv("MEND_CSRF_SECRET", "x".repeat(32));
    expect(csrfSecret().byteLength).toBe(32);
    vi.stubEnv("MEND_CSRF_SECRET", "€".repeat(11));
    expect(csrfSecret().byteLength).toBe(33);
  });
});

describe("readJsonBody", () => {
  const json = { "content-type": "application/json" };

  it("parses a small JSON body", async () => {
    expect(await readJsonBody(request(json, { body: '{"a":1}' }), 100)).toEqual({ body: { a: 1 } });
  });

  it.each([
    [{ "content-type": "text/plain" }, '{"a":1}', "not_json"],
    [json, '{"a":1,"a":2}', "duplicate_key"],
    [json, "[".repeat(80), "too_deep"],
    [json, "{", "syntax"],
  ])("refuses %j %j as %s", async (headers, body, problem) => {
    expect(await readJsonBody(request(headers, { body }), 1000)).toEqual({ problem });
  });

  it("refuses a body over the cap, declared or not, without reading past it", async () => {
    expect(await readJsonBody(request({ ...json, "content-length": "5000" }, { body: "{}" }), 100)).toEqual({ problem: "too_large" });
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode(" ".repeat(64)));
      },
    });
    const streamed = request(json, { body: endless, duplex: "half" } as RequestInit);
    expect(await readJsonBody(streamed, 1000)).toEqual({ problem: "too_large" });
    expect(pulled).toBeLessThan(40);
  });

  it("refuses bytes that are not UTF-8", async () => {
    const bad = request(json, { body: new Uint8Array([0x7b, 0xff, 0x7d]) });
    expect(await readJsonBody(bad, 100)).toEqual({ problem: "syntax" });
  });

  it("keeps a __proto__ key as plain data, so no prototype changes", async () => {
    const reading = await readJsonBody(request(json, { body: '{"__proto__":{"polluted":true}}' }), 100);
    expect(Object.hasOwn((reading as { body: object }).body, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
