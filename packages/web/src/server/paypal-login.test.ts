// Covers the Log in with PayPal pieces with fetch replaced: the sign-in address, the
// token swap request, the userinfo read and its fallback, what is kept from userinfo,
// and the signed join cookie. Does NOT cover: PayPal's real sandbox (its field names
// are recorded by the callback's log on the first live sign-in), the routes that use
// these (join-routes.test.ts), or a browser's own cookie handling.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  callbackUrl,
  connectUrl,
  exchangeCode,
  issueTicket,
  JOIN_TICKET_SECONDS,
  LoginError,
  readIdentity,
  readTicket,
  stateMatches,
} from "./paypal-login";

const CLIENT_ID = "test-client-id";
const TEST_APP_SECRET = "test-client-secret-value";
const BASE = "https://mend-web.onrender.com";
const STATE = "A".repeat(21) + "-_" + "z".repeat(20);
const USER_TOKEN = "fake-user-token-for-tests.0123456789";
const HASH = "c".repeat(64);
const USERINFO = {
  user_id: "https://www.paypal.com/webapps/auth/identity/user/abc123",
  sub: "https://www.paypal.com/webapps/auth/identity/user/abc123",
  name: "Priya Shah",
  email: "priya.buyer@personal.example.com",
  email_verified: true,
  payer_id: "QWERTY1234567",
  address: { street_address: "1 Main St", locality: "San Jose", country: "US" },
  phone_number: "+1 555 0100",
  verified_account: true,
};

type Call = { readonly url: string; readonly init: RequestInit };
let calls: Call[] = [];
let answers: Array<{ status: number; body: string }> = [];

function json(status: number, body: unknown): { status: number; body: string } {
  return { status, body: JSON.stringify(body) };
}

async function failure(promise: Promise<unknown>): Promise<LoginError> {
  const error = await promise.then(() => null, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(LoginError);
  return error as LoginError;
}

beforeAll(() => {
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  vi.stubEnv("PAYPAL_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("PAYPAL_CLIENT_SECRET", TEST_APP_SECRET);
  vi.stubEnv("PAYPAL_WEBHOOK_ID", "TESTWEBHOOK1");
  vi.stubEnv("DATABASE_URL", "postgresql://localhost/unused");
  vi.stubEnv("MEND_BASE_URL", BASE);
  vi.stubEnv("MEND_CSRF_SECRET", "csrf-secret-for-login-tests-0123456789");
});

beforeEach(() => {
  calls = [];
  answers = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({ url: url.href, init });
      const next = answers.shift();
      if (next === undefined) throw new TypeError("fetch failed");
      return new Response(next.body, { status: next.status, headers: { "content-type": "application/json" } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connectUrl", () => {
  it("sends the browser to exactly PayPal's sandbox sign-in, with every parameter in order", () => {
    expect(connectUrl(STATE).href).toBe(
      "https://www.sandbox.paypal.com/connect?flowEntry=static&client_id=test-client-id&response_type=code" +
        "&scope=openid%20email%20https%3A%2F%2Furi.paypal.com%2Fservices%2Fpaypalattributes" +
        "&redirect_uri=https%3A%2F%2Fmend-web.onrender.com%2Fapi%2Fjoin%2Fpaypal%2Fcallback" +
        `&state=${STATE}&fullPage=true`,
    );
    expect(callbackUrl()).toBe(`${BASE}/api/join/paypal/callback`);
  });

  it.each(["", "short", `${STATE}&client_id=evil`, `${STATE.slice(1)}=`])("refuses the state %j", (state) => {
    expect(() => connectUrl(state)).toThrow();
  });
});

describe("exchangeCode", () => {
  it("posts the code with the app's Basic credentials and the same redirect_uri, and returns the token", async () => {
    answers = [json(200, { access_token: USER_TOKEN, token_type: "Bearer", expires_in: 28800, refresh_token: "R23never" })];
    await expect(exchangeCode("C21AA.code-1")).resolves.toBe(USER_TOKEN);
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${TEST_APP_SECRET}`).toString("base64")}`);
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(init.body).toBe(
      "grant_type=authorization_code&code=C21AA.code-1&redirect_uri=https%3A%2F%2Fmend-web.onrender.com%2Fapi%2Fjoin%2Fpaypal%2Fcallback",
    );
  });

  it.each(["", "has space", "line\nbreak", "x".repeat(2049)])("refuses the code %j before anything is sent", async (code) => {
    expect((await failure(exchangeCode(code))).reason).toBe("bad_code");
    expect(calls).toEqual([]);
  });

  it("reports a refusal by reason and PayPal's error name, never PayPal's words", async () => {
    answers = [json(400, { error: "invalid_grant", error_description: "Authorization code priya.buyer@personal.example.com expired" })];
    const error = await failure(exchangeCode("C21AA.code-1"));
    expect([error.reason, error.status, error.paypalError]).toEqual(["token_refused", 400, "invalid_grant"]);
    expect(error.message).not.toMatch(/expired|priya/);
  });

  it("refuses a 200 without a usable access token, and a connection failure", async () => {
    answers = [json(200, { token_type: "Bearer" })];
    expect((await failure(exchangeCode("C21AA.code-1"))).reason).toBe("token_unusable");
    answers = [];
    expect((await failure(exchangeCode("C21AA.code-1"))).reason).toBe("paypal_unreachable");
  });
});

describe("readIdentity", () => {
  it("keeps exactly email, email_verified and payer_id, and reports the field names PayPal sent", async () => {
    answers = [json(200, USERINFO)];
    const reading = await readIdentity(USER_TOKEN);
    expect(reading.identity).toStrictEqual({ email: USERINFO.email, email_verified: true, payer_id: "QWERTY1234567" });
    expect(reading.fields).toEqual(["address", "email", "email_verified", "name", "payer_id", "phone_number", "sub", "user_id", "verified_account"]);
    expect(reading.source).toBe("paypalv1.1");
    expect(calls.map((call) => call.url)).toEqual(["https://api-m.sandbox.paypal.com/v1/identity/oauth2/userinfo?schema=paypalv1.1"]);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${USER_TOKEN}`);
    expect(calls[0].init.redirect).toBe("error");
  });

  it.each([["ABCDEFGHIJKL"], ["ABCDEFGHIJKLMN"], ["qwerty1234567"], ["QWERTY12345 7"], [1234567890123], [null]])(
    "drops the payer id %j, which is not 13 capital letters or digits",
    async (payerId) => {
      answers = [json(200, { ...USERINFO, payer_id: payerId })];
      expect((await readIdentity(USER_TOKEN)).identity.payer_id).toBeNull();
    },
  );

  it("falls back to the openidconnect address only when the first answers 404", async () => {
    answers = [json(404, { name: "NOT_FOUND" }), json(200, { email: "b@personal.example.com", email_verified: false })];
    const reading = await readIdentity(USER_TOKEN);
    expect(reading).toEqual({ identity: { email: "b@personal.example.com", email_verified: false, payer_id: null }, fields: ["email", "email_verified"], source: "openid" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api-m.sandbox.paypal.com/v1/identity/oauth2/userinfo?schema=paypalv1.1",
      "https://api-m.sandbox.paypal.com/v1/identity/openidconnect/userinfo?schema=openid",
    ]);

    calls = [];
    answers = [json(401, { error: "invalid_token" })];
    const refused = await failure(readIdentity(USER_TOKEN));
    expect([refused.reason, refused.status, refused.paypalError]).toEqual(["userinfo_refused", 401, "invalid_token"]);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["no email_verified", { email: USERINFO.email, name: "Priya Shah" }],
    ["email_verified as text", { email: USERINFO.email, email_verified: "true" }],
    ["no email", { email_verified: true }],
    ["an email with a space", { email: "priya buyer@personal.example.com", email_verified: true }],
  ])("refuses an answer with %s, keeping only the field names", async (_label, body) => {
    answers = [json(200, body)];
    const error = await failure(readIdentity(USER_TOKEN));
    expect(error.reason).toBe("userinfo_unusable");
    expect(error.fields).toEqual(Object.keys(body).sort());
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain("priya");
  });

  it("refuses an answer that repeats a key, so no second reading of it is possible", async () => {
    answers = [{ status: 200, body: '{"email":"a@personal.example.com","email_verified":true,"email":"b@personal.example.com"}' }];
    expect((await failure(readIdentity(USER_TOKEN))).reason).toBe("userinfo_refused");
  });
});

describe("the join cookie", () => {
  function requestWith(cookie: string): Request {
    return new Request(`${BASE}/api/join/paypal/callback`, { headers: { cookie } });
  }

  function valueOf(setCookie: string): string {
    return setCookie.split(";")[0].slice("__Host-mend_join=".length);
  }

  it("reads back what it issued, for a join and for a leave", () => {
    const join = issueTicket("join", HASH, 1_000_000_000_000);
    const back = readTicket(requestWith(`__Host-mend_join=${valueOf(join.cookie)}`), 1_000_000_000_000);
    expect(back).toEqual({ ticket: { ...join.ticket, expiresAt: 1_000_000_000 + JOIN_TICKET_SECONDS } });
    const leave = issueTicket("leave", null);
    expect(readTicket(requestWith(`__Host-mend_join=${valueOf(leave.cookie)}`))).toEqual({ ticket: leave.ticket });
    expect(stateMatches(join.ticket, join.ticket.state)).toBe(true);
    expect(stateMatches(join.ticket, leave.ticket.state)).toBe(false);
    expect(stateMatches(join.ticket, null)).toBe(false);
  });

  it("refuses an edited intent, a cookie signed with another key, a late one, two copies and a mangled one", () => {
    const value = valueOf(issueTicket("join", HASH).cookie);
    const [version, state, , consent, expiry, mac] = value.split(".");
    expect(readTicket(requestWith(`__Host-mend_join=${[version, state, "leave", "", expiry, mac].join(".")}`))).toEqual({ problem: "bad_mac" });
    expect(readTicket(requestWith(`__Host-mend_join=${[version, state, "join", "d".repeat(64), expiry, mac].join(".")}`))).toEqual({ problem: "bad_mac" });
    vi.stubEnv("MEND_CSRF_SECRET", "another-secret-for-login-tests-01234567");
    const foreign = valueOf(issueTicket("join", HASH).cookie);
    vi.stubEnv("MEND_CSRF_SECRET", "csrf-secret-for-login-tests-0123456789");
    expect(readTicket(requestWith(`__Host-mend_join=${foreign}`))).toEqual({ problem: "bad_mac" });
    expect(readTicket(requestWith(`__Host-mend_join=${value}`), (Number(expiry) - 1) * 1000)).toHaveProperty("ticket");
    expect(readTicket(requestWith(`__Host-mend_join=${value}`), Number(expiry) * 1000)).toEqual({ problem: "expired" });
    expect(readTicket(requestWith(`__Host-mend_join=${value}; __Host-mend_join=${value}`))).toEqual({ problem: "missing" });
    expect(readTicket(requestWith(`__Host-mend_join=${value}.extra`))).toEqual({ problem: "malformed" });
    expect(readTicket(requestWith(`__Host-mend_join=${[version, state, "join", consent.toUpperCase(), expiry, mac].join(".")}`))).toEqual({ problem: "malformed" });
    expect(() => issueTicket("join", null)).toThrow();
    expect(() => issueTicket("leave", HASH)).toThrow();
  });
});
