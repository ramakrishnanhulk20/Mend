// Covers the three Join with PayPal routes as handlers, with fetch replaced by a fake
// PayPal, the engine replaced by a stub and the database's rate limiter by a recorder
// that must stay empty: the confirmation page and its escaping and headers, the origin
// and CSRF checks on the click, the exact redirect and cookie, the consent check, every
// way a return is refused before PayPal is called, cancel, join, leave, the engine's
// refusals (too many calls running for one address among them), PayPal failures, the
// per-address counts kept in process memory, what reaches the logs, and the cookie being
// cleared on every answer. Does NOT cover: PayPal's real sandbox (the first live sign-in
// records its userinfo field names), how a real browser applies the page's CSP and
// SameSite rules, the engine's join and leave tasks (packages/engine tests), the
// in-memory counting itself (address-limits.test.ts), or Next.js routing.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { joinLimits } from "../../../server/address-limits";

const fake = vi.hoisted(() => ({
  run: "brn-1c9e8f00-1111-4222-8333-944445555666",
  answers: {} as Record<string, unknown>,
  engineCalls: [] as Array<{ task: string; args: readonly unknown[] }>,
  engineOptions: [] as unknown[],
  pending: false,
  hits: [] as Array<{ bucket: string; subject: string }>,
}));

// Route modules import through the "@/" alias, which this vitest config does not map.
vi.mock("@/server/csrf", async () => await import("../../../server/csrf"));
vi.mock("@/server/log", async () => await import("../../../server/log"));
vi.mock("@/server/paypal-login", async () => await import("../../../server/paypal-login"));
vi.mock("@/server/permissions", async () => await import("../../../server/permissions"));
vi.mock("@/server/runs", async () => await import("../../../server/runs"));
vi.mock("@/server/engine", async () => {
  const real = await import("../../../server/engine");
  return {
    ...real,
    runAndWait: vi.fn(async (task: string, args: readonly unknown[], _waitMs: number, options: unknown) => {
      fake.engineCalls.push({ task, args });
      fake.engineOptions.push(options);
      if (fake.pending) return { state: "pending", httpStatus: 202, runId: fake.run };
      return { state: "finished", runId: fake.run, status: "succeeded", result: fake.answers[task] };
    }),
  };
});
vi.mock("@/server/address-limits", async () => await import("../../../server/address-limits"));
// The join routes count in memory; any use of the database's limiter shows up here.
vi.mock("@/server/ratelimit", async () => {
  const real = await import("../../../server/ratelimit");
  return {
    ...real,
    recordMemoryRefusal: vi.fn(async () => undefined),
    takeHit: vi.fn(async (limit: { bucket: string }, subject: string) => {
      fake.hits.push({ bucket: limit.bucket, subject });
      return { allowed: true };
    }),
  };
});

const ADDRESS = "198.51.100.7";

/** Use up the in-memory count for route at the test client's address. */
function fillCount(route: keyof typeof joinLimits): void {
  for (let n = 0; n < 100 && joinLimits[route].take(ADDRESS).allowed; n += 1);
}

import { csrfTokenForSession } from "../../../server/csrf";
import { issueTicket } from "../../../server/paypal-login";
import { sessionIdFor } from "../../../server/sessions";

const BASE = "https://mend-web.onrender.com";
const CLIENT_ID = "test-client-id";
const HASH = "c".repeat(64);
const OTHER_HASH = "d".repeat(64);
const ENGINE_REF = "6f1c1d3e-2b9a-4f0e-9a51-3c1d2e4f5a6b";
const MEMBER = "0b6c2f8e-6a4e-4c1b-9d2a-7e5f1a3b9c4d";
const CODE = "C21AAcode-for-route-tests.0123456789";
const USER_TOKEN = "fake-user-token-for-route-tests.0123456789";
const REFRESH_TOKEN = "R23AArefresh-token-never-kept";
const ID_TOKEN = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.never";
const EMAIL = "priya.buyer@personal.example.com";
const USERINFO = {
  user_id: "https://www.paypal.com/webapps/auth/identity/user/abc123",
  name: "Priya Shah",
  email: EMAIL,
  email_verified: true,
  payer_id: "QWERTY1234567",
  address: { street_address: "1 Main St", locality: "San Jose", postal_code: "95131", country: "US" },
  phone_number: "+1 555 0100",
};
const IDENTITY = { email: EMAIL, email_verified: true, payer_id: "QWERTY1234567" };
const ANSWERS = {
  consent_text: { ok: true, shop_name: "Wolf and Wren Gifts", text: "Wolf and Wren Gifts may look at your past orders.", hash: HASH },
  join: { ok: true, member_id: MEMBER, created: true, linked: true },
  leave: { ok: true, left: true, voided: 1 },
};

type Planned = { status: number; body: unknown };
const paypal = {
  token: { status: 200, body: {} } as Planned,
  userinfo: { status: 200, body: {} } as Planned,
  fallback: { status: 200, body: {} } as Planned,
  calls: [] as string[],
};
let logLines: string[] = [];

function fakePayPal(url: URL): Response {
  paypal.calls.push(url.href);
  const plan = url.pathname === "/v1/oauth2/token" ? paypal.token : url.pathname === "/v1/identity/oauth2/userinfo" ? paypal.userinfo : paypal.fallback;
  return new Response(JSON.stringify(plan.body), { status: plan.status, headers: { "content-type": "application/json" } });
}

const routes = async () => ({
  consent: await import("./consent/route"),
  start: await import("./paypal/start/route"),
  callback: await import("./paypal/callback/route"),
});

function get(path: string, cookie?: string): Request {
  const headers: Record<string, string> = { "x-forwarded-for": "203.0.113.9, 198.51.100.7" };
  if (cookie !== undefined) headers.cookie = cookie;
  return new Request(`${BASE}${path}`, { headers });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** A callback answer: the join cookie cleared, and nothing that would pass the code on or keep the page. */
function expectCleared(response: Response): void {
  expect(response.headers.get("set-cookie")).toBe("__Host-mend_join=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cache-control")).toBe("no-store");
}

type PostOptions = { origin?: string | null; cookie?: string; contentType?: string; rawBody?: string };

function post(fields: Array<[string, string]>, options: PostOptions = {}): Request {
  const headers: Record<string, string> = {
    "x-forwarded-for": "203.0.113.9, 198.51.100.7",
    "content-type": options.contentType ?? "application/x-www-form-urlencoded",
  };
  const origin = options.origin === undefined ? BASE : options.origin;
  if (origin !== null) headers.origin = origin;
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  return new Request(`${BASE}/api/join/paypal/start`, { method: "POST", headers, body: options.rawBody ?? new URLSearchParams(fields).toString() });
}

/** The confirmation page as a browser with no cookies gets it, with the csrf field it carries and the CSRF cookie it set. */
async function page(intent: "join" | "leave"): Promise<{ response: Response; html: string; csrf: string; csrfCookie: string }> {
  const { start } = await routes();
  const response = await start.GET(get(`/api/join/paypal/start?intent=${intent}`));
  const html = await response.text();
  const csrf = /name="csrf" value="([^"]*)"/.exec(html)?.[1] ?? "";
  return { response, html, csrf, csrfCookie: (response.headers.get("set-cookie") ?? "").split(";")[0] };
}

/** Start a sign-in the way a browser does, page then click, and return the join cookie and the state PayPal would echo. */
async function begin(intent: "join" | "leave"): Promise<{ cookie: string; state: string }> {
  const { start } = await routes();
  const shown = await page(intent);
  const fields: Array<[string, string]> = intent === "join" ? [["intent", "join"], ["consent", HASH], ["csrf", shown.csrf]] : [["intent", "leave"], ["csrf", shown.csrf]];
  const response = await start.POST(post(fields, { cookie: shown.csrfCookie }));
  expect(response.status).toBe(303);
  const state = new URL(response.headers.get("location") ?? "").searchParams.get("state") ?? "";
  return { cookie: (response.headers.get("set-cookie") ?? "").split(";")[0], state };
}

function ticketCookie(intent: "join" | "leave", now = Date.now()): { cookie: string; state: string } {
  const { ticket, cookie } = issueTicket(intent, intent === "join" ? HASH : null, now);
  return { cookie: cookie.split(";")[0], state: ticket.state };
}

beforeAll(() => {
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  vi.stubEnv("PAYPAL_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-client-secret-value");
  vi.stubEnv("PAYPAL_WEBHOOK_ID", "TESTWEBHOOK1");
  vi.stubEnv("DATABASE_URL", "postgresql://localhost/unused");
  vi.stubEnv("MEND_BASE_URL", BASE);
  vi.stubEnv("MEND_CSRF_SECRET", "csrf-secret-for-join-route-tests-012345");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  fake.answers = { ...ANSWERS };
  fake.engineCalls = [];
  fake.engineOptions = [];
  fake.pending = false;
  fake.hits = [];
  for (const limiter of Object.values(joinLimits)) limiter.clear();
  paypal.token = { status: 200, body: { access_token: USER_TOKEN, token_type: "Bearer", expires_in: "28800", refresh_token: REFRESH_TOKEN, id_token: ID_TOKEN } };
  paypal.userinfo = { status: 200, body: USERINFO };
  paypal.fallback = { status: 500, body: {} };
  paypal.calls = [];
  logLines = [];
  vi.stubGlobal("fetch", vi.fn(async (url: URL) => fakePayPal(url)));
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    logLines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  return () => {
    // Nothing on these routes may count in the database's rate_limit_hits.
    expect(fake.hits).toEqual([]);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  };
});

describe("GET /api/join/consent", () => {
  it("answers the shop name, the words and their hash from the engine, counted against the client address", async () => {
    const { consent } = await routes();
    const response = await consent.GET(get("/api/join/consent"));
    expect(response.status).toBe(200);
    expect(await body(response)).toStrictEqual({ shopName: "Wolf and Wren Gifts", text: ANSWERS.consent_text.text, hash: HASH });
    expect(fake.engineCalls).toEqual([{ task: "consent_text", args: [] }]);
    expect(fake.engineOptions).toEqual([{ address: ADDRESS }]);
  });

  it("refuses past the joinConsent limit before asking the engine", async () => {
    fillCount("consent");
    const { consent } = await routes();
    const response = await consent.GET(get("/api/join/consent"));
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(fake.engineCalls).toEqual([]);
  });

  it("answers 429 when the engine refuses a third call running for this address", async () => {
    fake.answers.consent_text = { ok: false, error: "too_many_running", ref: ENGINE_REF };
    const { consent } = await routes();
    const response = await consent.GET(get("/api/join/consent"));
    expect(response.status).toBe(429);
    expect(await body(response)).toEqual({ error: "too_many_running", message: "Too many requests. Try again later.", ref: ENGINE_REF });
  });
});

describe("the join routes' counts", () => {
  it("are kept in process memory, never in rate_limit_hits: 60 consent reads, 20 starts and 20 returns a minute per address", async () => {
    const { consent, start, callback } = await routes();
    for (let n = 0; n < 60; n += 1) expect((await consent.GET(get("/api/join/consent"))).status).toBe(200);
    expect((await consent.GET(get("/api/join/consent"))).status).toBe(429);
    for (let n = 0; n < 20; n += 1) expect((await start.GET(get("/api/join/paypal/start?intent=leave"))).status).toBe(200);
    const refused = await start.GET(get("/api/join/paypal/start?intent=leave"));
    expect(refused.status).toBe(429);
    expect((await body(refused)).error).toBe("rate_limited");
    for (let n = 0; n < 20; n += 1) expect((await callback.GET(get("/api/join/paypal/callback?state=x"))).status).toBe(400);
    expect((await callback.GET(get("/api/join/paypal/callback?state=x"))).status).toBe(429);
    const elsewhere = new Request(`${BASE}/api/join/consent`, { headers: { "x-forwarded-for": "198.51.100.8" } });
    expect((await consent.GET(elsewhere)).status).toBe(200);
  });
});

describe("GET /api/join/paypal/start", () => {
  it("shows the exact consent words with the hash and csrf fields, the four headers and the CSRF cookie", async () => {
    const { response, html, csrf, csrfCookie } = await page("join");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; form-action 'self' https://www.sandbox.paypal.com; frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toMatch(/^__Host-mend_csrf=a1\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=86400; HttpOnly; SameSite=Lax; Secure$/);
    expect(csrfCookie).toMatch(/^__Host-mend_csrf=a1\./);
    expect(csrf).toMatch(/^c2\.[A-Za-z0-9_-]{43}$/);
    expect(html).toContain("<h1>Wolf and Wren Gifts</h1>\n<p>Wolf and Wren Gifts may look at your past orders.</p>");
    expect(html).toContain('<form method="post" action="/api/join/paypal/start">');
    expect(html).toContain('<input type="hidden" name="intent" value="join">');
    expect(html).toContain(`<input type="hidden" name="consent" value="${HASH}">`);
    expect(html).toContain(`<input type="hidden" name="csrf" value="${csrf}">`);
    expect(html).toContain('<button type="submit">Join with PayPal</button>');
    expect(html).not.toMatch(/<script|<style|style=/i);
    expect(fake.engineCalls).toEqual([{ task: "consent_text", args: [] }]);
    expect(fake.engineOptions).toEqual([{ address: ADDRESS }]);
    expect(paypal.calls).toEqual([]);
  });

  it("escapes a shop name and words carrying markup and quotes", async () => {
    fake.answers.consent_text = { ok: true, shop_name: `<script>alert("x")</script> & 'Co'`, text: `Say "yes" <b>now</b> & 'go'`, hash: HASH };
    const { html } = await page("join");
    expect(html).toContain("<h1>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Co&#39;</h1>");
    expect(html).toContain("<p>Say &quot;yes&quot; &lt;b&gt;now&lt;/b&gt; &amp; &#39;go&#39;</p>");
    expect(html).not.toMatch(/<script|<b>/);
    const { html: leaving } = await page("leave");
    expect(leaving).toContain("<p>Leave the thank-you list of &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Co&#39;.");
    expect(leaving).not.toMatch(/<script/);
  });

  it("shows the leave sentence with no consent field", async () => {
    const { response, html, csrf } = await page("leave");
    expect(response.status).toBe(200);
    expect(html).toContain("<p>Leave the thank-you list of Wolf and Wren Gifts. Any reward not yet sent to you is cancelled.</p>");
    expect(html).toContain('<input type="hidden" name="intent" value="leave">');
    expect(html).toContain('<button type="submit">Leave with PayPal</button>');
    expect(html).not.toContain('name="consent"');
    expect(html).not.toContain("<h1>");
    expect(csrf).toMatch(/^c2\./);
  });

  it.each([
    "/api/join/paypal/start",
    "/api/join/paypal/start?intent=signup",
    "/api/join/paypal/start?intent=",
    `/api/join/paypal/start?intent=join&consent=${HASH}`,
    "/api/join/paypal/start?intent=join&intent=join",
    "/api/join/paypal/start?intent=leave&utm_source=mail",
    "/api/join/paypal/start?shop=1",
  ])("answers 400 bad_request with no page for %s", async (path) => {
    const { start } = await routes();
    const response = await start.GET(get(path));
    expect(response.status).toBe(400);
    expect((await body(response)).error).toBe("bad_request");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(fake.engineCalls).toEqual([]);
  });

  it("refuses past the joinStart limit, which GET and POST share, before asking the engine", async () => {
    const { start } = await routes();
    for (let n = 0; n < 19; n += 1) joinLimits.start.take(ADDRESS);
    expect((await start.POST(post([["intent", "leave"], ["csrf", "c2.x"]]))).status).toBe(403);
    const shown = await start.GET(get("/api/join/paypal/start?intent=join"));
    const clicked = await start.POST(post([["intent", "leave"], ["csrf", "c2.x"]]));
    expect([shown.status, clicked.status]).toEqual([429, 429]);
    expect(fake.engineCalls).toEqual([]);
  });

  it("answers 429 with no page when the engine refuses a third call running for this address", async () => {
    fake.answers.consent_text = { ok: false, error: "too_many_running", ref: ENGINE_REF };
    const { start } = await routes();
    const response = await start.GET(get("/api/join/paypal/start?intent=join"));
    expect(response.status).toBe(429);
    expect(await body(response)).toEqual({ error: "too_many_running", message: "Too many requests. Try again later.", ref: ENGINE_REF });
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

type Refused = { readonly fields: ReadonlyArray<readonly [string, string]>; readonly options: PostOptions };

describe("POST /api/join/paypal/start", () => {
  it("sends a join with the right token to exactly PayPal's sandbox sign-in and sets the signed join cookie", async () => {
    const { csrf, csrfCookie } = await page("join");
    fake.engineCalls = [];
    const { start } = await routes();
    const response = await start.POST(post([["intent", "join"], ["consent", HASH], ["csrf", csrf]], { cookie: csrfCookie }));
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    const state = new URL(location).searchParams.get("state") ?? "";
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location).toBe(
      "https://www.sandbox.paypal.com/connect?flowEntry=static&client_id=test-client-id&response_type=code" +
        "&scope=openid%20email%20https%3A%2F%2Furi.paypal.com%2Fservices%2Fpaypalattributes" +
        "&redirect_uri=https%3A%2F%2Fmend-web.onrender.com%2Fapi%2Fjoin%2Fpaypal%2Fcallback" +
        `&state=${state}&fullPage=true`,
    );
    expect(response.headers.get("set-cookie")).toMatch(
      new RegExp(`^__Host-mend_join=j1\\.${state}\\.join\\.${HASH}\\.\\d+\\.[A-Za-z0-9_-]{43}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure$`),
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fake.engineCalls).toEqual([{ task: "consent_text", args: [] }]);
    expect(paypal.calls).toEqual([]);
  });

  it("sends a leave with no consent field and no engine run", async () => {
    const { csrf, csrfCookie } = await page("leave");
    fake.engineCalls = [];
    const { start } = await routes();
    const response = await start.POST(post([["intent", "leave"], ["csrf", csrf]], { cookie: csrfCookie }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\/connect\?/);
    expect(response.headers.get("set-cookie")).toMatch(/^__Host-mend_join=j1\.[A-Za-z0-9_-]{43}\.leave\.\.\d+\./);
    expect(fake.engineCalls).toEqual([]);
  });

  it("accepts the session-bound token of a signed-in browser, and only that one", async () => {
    const session = `s1.${"S".repeat(43)}`;
    const { start } = await routes();
    const response = await start.POST(post([["intent", "leave"], ["csrf", csrfTokenForSession(sessionIdFor(session))]], { cookie: `__Host-mend_session=${session}` }));
    expect(response.status).toBe(303);
    const anonymous = await page("leave");
    const mixed = await start.POST(post([["intent", "leave"], ["csrf", anonymous.csrf]], { cookie: `__Host-mend_session=${session}; ${anonymous.csrfCookie}` }));
    expect(mixed.status).toBe(403);
  });

  it("refuses a join whose consent hash is no longer the shown words with 409 and no redirect", async () => {
    const { csrf, csrfCookie } = await page("join");
    const { start } = await routes();
    const response = await start.POST(post([["intent", "join"], ["consent", OTHER_HASH], ["csrf", csrf]], { cookie: csrfCookie }));
    expect(response.status).toBe(409);
    expect((await body(response)).error).toBe("consent_changed");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it.each<[string, number, (csrf: string) => Refused]>([
    ["a foreign Origin", 403, (csrf) => ({ fields: [["intent", "leave"], ["csrf", csrf]], options: { origin: "https://evil.example" } })],
    ["no Origin", 403, (csrf) => ({ fields: [["intent", "leave"], ["csrf", csrf]], options: { origin: null } })],
    ["a missing csrf field", 400, () => ({ fields: [["intent", "leave"]], options: {} })],
    ["a wrong csrf field", 403, (csrf) => ({ fields: [["intent", "leave"], ["csrf", `${csrf.slice(0, -1)}${csrf.endsWith("A") ? "B" : "A"}`]], options: {} })],
    ["an unknown field", 400, (csrf) => ({ fields: [["intent", "leave"], ["csrf", csrf], ["shop", "1"]], options: {} })],
    ["a consent field on a leave", 400, (csrf) => ({ fields: [["intent", "leave"], ["csrf", csrf], ["consent", HASH]], options: {} })],
    ["a repeated field", 400, (csrf) => ({ fields: [["intent", "join"], ["intent", "join"], ["consent", HASH], ["csrf", csrf]], options: {} })],
    ["an over-size body", 400, (csrf) => ({ fields: [], options: { rawBody: `intent=leave&csrf=${csrf}&pad=${"x".repeat(4096)}` } })],
    ["a JSON body", 400, (csrf) => ({ fields: [], options: { contentType: "application/json", rawBody: JSON.stringify({ intent: "leave", csrf }) } })],
  ])("refuses %s with %i, no engine run and no redirect", async (_label, status, make) => {
    const { csrf, csrfCookie } = await page("join");
    fake.engineCalls = [];
    const { fields, options } = make(csrf);
    const { start } = await routes();
    const response = await start.POST(post(fields.map(([name, value]): [string, string] => [name, value]), { cookie: csrfCookie, ...options }));
    expect(response.status).toBe(status);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(fake.engineCalls).toEqual([]);
    expect(paypal.calls).toEqual([]);
  });

  it("names the cookies mend_csrf and mend_join without Secure over plain http in development", async () => {
    vi.stubEnv("MEND_DEV", "1");
    vi.stubEnv("MEND_BASE_URL", "http://127.0.0.1:3000");
    try {
      const { csrf, csrfCookie } = await page("leave");
      expect(csrfCookie).toMatch(/^mend_csrf=a1\./);
      const { start } = await routes();
      const response = await start.POST(post([["intent", "leave"], ["csrf", csrf]], { cookie: csrfCookie, origin: "http://127.0.0.1:3000" }));
      expect(response.status).toBe(303);
      expect(response.headers.get("set-cookie")).toMatch(/^mend_join=j1\.[A-Za-z0-9_-]{43}\.leave\.\.\d+\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax$/);
      expect(new URL(response.headers.get("location") ?? "").searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3000/api/join/paypal/callback");
    } finally {
      vi.stubEnv("MEND_DEV", "");
      vi.stubEnv("MEND_BASE_URL", BASE);
    }
  });
});

describe("GET /api/join/paypal/callback", () => {
  it.each([
    ["no cookie", () => ({ cookie: undefined, state: ticketCookie("join").state })],
    ["a cookie with a bad signature", () => {
      const { cookie, state } = ticketCookie("join");
      return { cookie: `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`, state };
    }],
    ["an expired cookie", () => ticketCookie("join", Date.now() - 601_000)],
    ["a different state", () => ({ cookie: ticketCookie("join").cookie, state: ticketCookie("join").state })],
  ])("refuses bad_state for %s without calling PayPal", async (_label, make) => {
    const { cookie, state } = make();
    const { callback } = await routes();
    const response = await callback.GET(get(`/api/join/paypal/callback?code=${CODE}&state=${state}`, cookie));
    expect(response.status).toBe(400);
    expect((await body(response)).error).toBe("bad_state");
    expectCleared(response);
    expect(paypal.calls).toEqual([]);
    expect(fake.engineCalls).toEqual([]);
  });

  it("answers cancelled when PayPal returns an error, without calling PayPal or the engine", async () => {
    const { cookie, state } = await begin("join");
    fake.engineCalls = [];
    const { callback } = await routes();
    const response = await callback.GET(get(`/api/join/paypal/callback?error=access_denied&error_description=Consent+denied&state=${state}`, cookie));
    expect(response.status).toBe(200);
    expect(await body(response)).toStrictEqual({ outcome: "cancelled" });
    expectCleared(response);
    expect(paypal.calls).toEqual([]);
    expect(fake.engineCalls).toEqual([]);
  });

  it("joins, handing the engine exactly the three identity fields and the consent hash", async () => {
    const { cookie, state } = await begin("join");
    fake.engineCalls = [];
    const { callback } = await routes();
    const response = await callback.GET(get(`/api/join/paypal/callback?code=${CODE}&scope=openid&state=${state}`, cookie));
    expect(response.status).toBe(200);
    expect(await body(response)).toStrictEqual({ outcome: "joined", linked: true });
    expectCleared(response);
    expect(fake.engineCalls).toHaveLength(1);
    expect(fake.engineCalls[0].task).toBe("join");
    expect(fake.engineCalls[0].args).toStrictEqual([IDENTITY, HASH]);
    expect(paypal.calls).toEqual([
      "https://api-m.sandbox.paypal.com/v1/oauth2/token",
      "https://api-m.sandbox.paypal.com/v1/identity/oauth2/userinfo?schema=paypalv1.1",
    ]);
    expect(fake.engineOptions.at(-1)).toEqual({ address: ADDRESS });
  });

  it("answers 429 when the engine refuses a third call running for this address, clearing the cookie", async () => {
    fake.answers.join = { ok: false, error: "too_many_running", ref: ENGINE_REF };
    const { cookie, state } = ticketCookie("join");
    const { callback } = await routes();
    const response = await callback.GET(get(`/api/join/paypal/callback?code=${CODE}&state=${state}`, cookie));
    expect(response.status).toBe(429);
    expect(await body(response)).toEqual({ error: "too_many_running", message: "Too many requests. Try again later.", ref: ENGINE_REF });
    expectCleared(response);
  });

  it("leaves, handing the engine exactly the three identity fields", async () => {
    const { cookie, state } = await begin("leave");
    fake.engineCalls = [];
    const { callback } = await routes();
    const response = await callback.GET(get(`/api/join/paypal/callback?code=${CODE}&state=${state}`, cookie));
    expect(response.status).toBe(200);
    expect(await body(response)).toStrictEqual({ outcome: "left" });
    expectCleared(response);
    expect(fake.engineCalls).toStrictEqual([{ task: "leave", args: [IDENTITY] }]);
  });

  it("reads userinfo from the openidconnect address when the first answers 404", async () => {
    paypal.userinfo = { status: 404, body: { name: "NOT_FOUND" } };
    paypal.fallback = { status: 200, body: { email: EMAIL, email_verified: true, user_id: "x" } };
    const { cookie, state } = ticketCookie("join");
    const { callback } = await routes();
    const response = await callback.GET(get(`/api/join/paypal/callback?code=${CODE}&state=${state}`, cookie));
    expect(response.status).toBe(200);
    expect(paypal.calls.at(-1)).toBe("https://api-m.sandbox.paypal.com/v1/identity/openidconnect/userinfo?schema=openid");
    expect(fake.engineCalls[0].args).toStrictEqual([{ email: EMAIL, email_verified: true, payer_id: null }, HASH]);
  });

  it.each([
    ["the token swap", () => (paypal.token = { status: 500, body: { name: "INTERNAL_SERVER_ERROR" } })],
    ["userinfo", () => (paypal.userinfo = { status: 500, body: { name: "INTERNAL_SERVER_ERROR" } })],
  ])("answers 502 paypal_unavailable when %s fails, asking the engine nothing", async (_label, fail) => {
    fail();
    const { cookie, state } = ticketCookie("join");
    const { callback } = await routes();
    const response = await callback.GET(get(`/api/join/paypal/callback?code=${CODE}&state=${state}`, cookie));
    expect(response.status).toBe(502);
    expect((await body(response)).error).toBe("paypal_unavailable");
    expectCleared(response);
    expect(fake.engineCalls).toEqual([]);
  });

  it.each([
    ["join", "bad_identity"],
    ["join", "consent_changed"],
    ["join", "not_payable"],
    ["join", "identity_conflict"],
    ["leave", "email_unverified"],
  ] as const)("answers the engine's %s refusal %s as 409 with its code", async (intent, code) => {
    fake.answers[intent] = { ok: false, error: code, ref: ENGINE_REF };
    const { cookie, state } = ticketCookie(intent);
    const { callback } = await routes();
    const response = await callback.GET(get(`/api/join/paypal/callback?code=${CODE}&state=${state}`, cookie));
    expect(response.status).toBe(409);
    expect(await body(response)).toEqual({ error: code, message: expect.any(String), ref: ENGINE_REF });
    expectCleared(response);
  });

  it("answers 500 for the engine's generic failure and 503 while the engine is still running", async () => {
    const { callback } = await routes();
    fake.answers.join = { ok: false, error: "internal", ref: ENGINE_REF };
    let { cookie, state } = ticketCookie("join");
    let response = await callback.GET(get(`/api/join/paypal/callback?code=${CODE}&state=${state}`, cookie));
    expect([response.status, (await body(response)).error]).toEqual([500, "internal"]);
    expectCleared(response);
    fake.pending = true;
    ({ cookie, state } = ticketCookie("join"));
    response = await callback.GET(get(`/api/join/paypal/callback?code=${CODE}&state=${state}`, cookie));
    expect([response.status, (await body(response)).error]).toEqual([503, "engine_unavailable"]);
    expectCleared(response);
  });

  it("clears the cookie on a rate-limited answer and on a return with no code", async () => {
    const { callback } = await routes();
    const { cookie, state } = ticketCookie("join");
    let response = await callback.GET(get(`/api/join/paypal/callback?state=${state}`, cookie));
    expect([response.status, (await body(response)).error]).toEqual([400, "bad_request"]);
    expectCleared(response);
    fillCount("callback");
    response = await callback.GET(get(`/api/join/paypal/callback?code=${CODE}&state=${state}`, cookie));
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expectCleared(response);
    expect(paypal.calls).toEqual([]);
  });

  it("logs one join line per return with field names only: no email, code, state or token anywhere", async () => {
    const { callback } = await routes();
    const joined = await begin("join");
    await callback.GET(get(`/api/join/paypal/callback?code=${CODE}&state=${joined.state}`, joined.cookie));
    paypal.userinfo = { status: 500, body: { name: "INTERNAL_SERVER_ERROR", message: `no such user ${EMAIL}` } };
    const failed = ticketCookie("join");
    await callback.GET(get(`/api/join/paypal/callback?code=${CODE}&state=${failed.state}`, failed.cookie));
    const stale = ticketCookie("join", Date.now() - 601_000);
    await callback.GET(get(`/api/join/paypal/callback?code=${CODE}&state=${stale.state}`, stale.cookie));

    const everything = logLines.join("");
    for (const secret of [EMAIL, "priya", CODE, USER_TOKEN, REFRESH_TOKEN, ID_TOKEN, joined.state, failed.state, stale.state, "QWERTY1234567", "555 0100", "Main St"]) {
      expect(everything, secret).not.toContain(secret);
    }
    const lines = logLines
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.route === "GET /api/join/paypal/callback");
    expect(lines.map((line) => [line.kind, line.outcome])).toEqual([
      ["join", "joined"],
      ["join", "paypal_unavailable"],
      ["join", "bad_state"],
    ]);
    expect(lines[0].userinfo_fields).toEqual(["address", "email", "email_verified", "name", "payer_id", "phone_number", "user_id"]);
    expect(lines.every((line) => typeof line.ref === "string")).toBe(true);
  });
});
