// Covers the sandbox host guard, token caching, timeouts and error hygiene in paypal.ts
// with a fake fetch. Does NOT cover: PayPal's real answers (the live proof does), TLS
// certificate checks (Node's job), or DNS.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostRefused,
  PAYPAL_TIMEOUT_MS,
  PayPalClient,
  PayPalError,
  PayPalUnreachable,
  paypalFetch,
  sandboxUrl,
  TOKEN_REFRESH_MARGIN_MS,
  type FetchFn,
} from "./paypal";

const SECRET = "client-secret-for-tests";
const credentials = Object.freeze({ clientId: "client-id-for-tests", clientSecret: SECRET });

type Call = { url: URL; init: RequestInit };

function fakePayPal(options: { tokenLifetimeSeconds?: number; apiStatus?: number } = {}) {
  const calls: Call[] = [];
  let tokensIssued = 0;
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init });
    if (url.pathname === "/v1/oauth2/token") {
      tokensIssued += 1;
      return Response.json({ access_token: `A21AAtoken${tokensIssued}`, expires_in: options.tokenLifetimeSeconds ?? 32_400 });
    }
    return Response.json({ ok: true }, { status: options.apiStatus ?? 200, headers: { "paypal-debug-id": "f1e2d3c4b5a69" } });
  };
  return { fetch, calls, tokenCalls: () => calls.filter((call) => call.url.pathname === "/v1/oauth2/token").length };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sandboxUrl", () => {
  it.each([
    ["/v1/notifications/webhooks", "https://api-m.sandbox.paypal.com/v1/notifications/webhooks"],
    ["https://api-m.sandbox.paypal.com/v1/payments/payouts/X1", "https://api-m.sandbox.paypal.com/v1/payments/payouts/X1"],
    ["https://API-M.SANDBOX.PAYPAL.COM/v1/x", "https://api-m.sandbox.paypal.com/v1/x"],
    ["https://api-m.sandbox.paypal.com:443/v1/x", "https://api-m.sandbox.paypal.com/v1/x"],
    ["/@evil.example/v1", "https://api-m.sandbox.paypal.com/@evil.example/v1"],
  ])("accepts %s", (input, href) => {
    expect(sandboxUrl(input).href).toBe(href);
  });

  it.each([
    ["the live host", "https://api-m.paypal.com/v1/oauth2/token"],
    ["the legacy sandbox host PayPal puts in links", "https://api.sandbox.paypal.com/v1/payments/payouts/X1"],
    ["a lookalike suffix host", "https://api-m.sandbox.paypal.com.evil.example/v1/x"],
    ["a lookalike prefix host", "https://evil-api-m.sandbox.paypal.com/v1/x"],
    ["a trailing-dot host", "https://api-m.sandbox.paypal.com./v1/x"],
    ["plain http", "http://api-m.sandbox.paypal.com/v1/x"],
    ["a userinfo trick", "https://api-m.sandbox.paypal.com@evil.example/v1/x"],
    ["userinfo on the right host", "https://user:pass@api-m.sandbox.paypal.com/v1/x"],
    ["the host hidden in the query", "https://evil.example/?h=api-m.sandbox.paypal.com"],
    ["the host hidden in the fragment", "https://evil.example/#api-m.sandbox.paypal.com"],
    ["a scheme-relative URL", "//api-m.sandbox.paypal.com/v1/x"],
    ["another port", "https://api-m.sandbox.paypal.com:8443/v1/x"],
    ["a tab inside the host", "https://api-m.sandbox.paypal.com\t.evil.example/v1"],
    ["a leading space", " https://api-m.sandbox.paypal.com/v1/x"],
    ["a non-ASCII lookalike", "https://api-m.sandbox.paypaIа.com/v1/x"],
    ["a relative path without a slash", "v1/x"],
    ["an empty string", ""],
    ["another scheme", "ftp://api-m.sandbox.paypal.com/v1/x"],
  ])("refuses %s", (_label, input) => {
    expect(() => sandboxUrl(input)).toThrow(HostRefused);
  });
});

describe("paypalFetch", () => {
  it("refuses a call built for api-m.paypal.com before reading config or sending", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(paypalFetch("https://api-m.paypal.com/v1/oauth2/token", { method: "POST" })).rejects.toThrow(HostRefused);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the global fetch at call time with the app's own credentials", async () => {
    vi.stubEnv("PAYPAL_ENV", "sandbox");
    vi.stubEnv("PAYPAL_CLIENT_ID", credentials.clientId);
    vi.stubEnv("PAYPAL_CLIENT_SECRET", SECRET);
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "WEBHOOKID1");
    vi.stubEnv("DATABASE_URL", "postgresql://u@127.0.0.1:5432/db");
    const fake = fakePayPal();
    vi.stubGlobal("fetch", fake.fetch);
    const reply = await paypalFetch("/v1/notifications/webhooks");
    expect(reply.status).toBe(200);
    expect(fake.calls.map((call) => call.url.host)).toEqual(["api-m.sandbox.paypal.com", "api-m.sandbox.paypal.com"]);
  });
});

describe("PayPalClient", () => {
  it("sends the checked URL object, refuses redirects and sets a timeout signal", async () => {
    const fake = fakePayPal();
    const client = new PayPalClient(credentials, { fetch: fake.fetch });
    await client.request("/v1/notifications/webhooks", { method: "GET" });
    for (const call of fake.calls) {
      expect(call.url).toBeInstanceOf(URL);
      expect(call.url.hostname).toBe("api-m.sandbox.paypal.com");
      expect(call.init.redirect).toBe("error");
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
    const apiCall = fake.calls[1];
    expect(new Headers(apiCall.init.headers).get("authorization")).toBe("Bearer A21AAtoken1");
  });

  it("uses a 15 second timeout by default", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const client = new PayPalClient(credentials, { fetch: fakePayPal().fetch });
    await client.request("/v1/x");
    expect(PAYPAL_TIMEOUT_MS).toBe(15_000);
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
  });

  it("caches the token until 60 seconds before it expires", async () => {
    let now = 1_000_000;
    const fake = fakePayPal({ tokenLifetimeSeconds: 3_600 });
    const client = new PayPalClient(credentials, { fetch: fake.fetch, now: () => now });
    await client.request("/v1/a");
    await client.request("/v1/b");
    expect(fake.tokenCalls()).toBe(1);

    now += 3_600_000 - TOKEN_REFRESH_MARGIN_MS - 1;
    await client.request("/v1/c");
    expect(fake.tokenCalls()).toBe(1);

    now += 1;
    await client.request("/v1/d");
    expect(fake.tokenCalls()).toBe(2);
    expect(new Headers(fake.calls.at(-1)?.init.headers).get("authorization")).toBe("Bearer A21AAtoken2");
  });

  it("shares one token request between concurrent callers", async () => {
    const fake = fakePayPal();
    const client = new PayPalClient(credentials, { fetch: fake.fetch });
    await Promise.all([client.request("/v1/a"), client.request("/v1/b"), client.request("/v1/c")]);
    expect(fake.tokenCalls()).toBe(1);
    expect(client.requestsSent).toBe(4);
  });

  it("drops a token PayPal rejects with 401", async () => {
    const fake = fakePayPal({ apiStatus: 401 });
    const client = new PayPalClient(credentials, { fetch: fake.fetch });
    await client.request("/v1/a");
    await client.request("/v1/b");
    expect(fake.tokenCalls()).toBe(2);
  });

  it("refuses caller-set Authorization or Host headers before sending", async () => {
    const fake = fakePayPal();
    const client = new PayPalClient(credentials, { fetch: fake.fetch });
    await expect(client.request("/v1/a", { headers: { authorization: "Bearer x" } })).rejects.toThrow(TypeError);
    await expect(client.request("/v1/a", { headers: { Host: "evil.example" } })).rejects.toThrow(TypeError);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a link to another host before fetching a token", async () => {
    const fake = fakePayPal();
    const client = new PayPalClient(credentials, { fetch: fake.fetch });
    await expect(client.request("https://api.sandbox.paypal.com/v1/payments/payouts/X")).rejects.toThrow(HostRefused);
    expect(client.requestsSent).toBe(0);
  });

  it("reports a token refusal by name and debug id only", async () => {
    const fetch: FetchFn = async () =>
      Response.json({ error: "invalid_client", error_description: "Client Authentication failed" }, {
        status: 401,
        headers: { "paypal-debug-id": "abc123def456" },
      });
    const client = new PayPalClient(credentials, { fetch });
    const error = await client.request("/v1/a").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PayPalError);
    expect(error).toMatchObject({ status: 401, errorName: "invalid_client", debugId: "abc123def456" });
    expect(String((error as Error).message)).not.toContain(SECRET);
  });

  it("refuses a token reply with no usable lifetime", async () => {
    const fetch: FetchFn = async () => Response.json({ access_token: "A21AAx", expires_in: "3600" });
    const client = new PayPalClient(credentials, { fetch });
    await expect(client.request("/v1/a")).rejects.toMatchObject({ errorName: "TOKEN_WITHOUT_EXPIRY" });
  });

  it("turns a hung request into PayPalUnreachable TIMEOUT", async () => {
    const fetch: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const client = new PayPalClient(credentials, { fetch, timeoutMs: 30 });
    await expect(client.request("/v1/a")).rejects.toMatchObject({ name: "PayPalUnreachable", errorName: "TIMEOUT" });
  });

  it("turns a connection failure into PayPalUnreachable with no secret in it", async () => {
    const fetch: FetchFn = async () => {
      throw new TypeError(`fetch failed for ${SECRET}`);
    };
    const client = new PayPalClient(credentials, { fetch });
    const error = await client.request("/v1/a").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PayPalUnreachable);
    expect((error as PayPalUnreachable).errorName).toBe("CONNECTION_ERROR");
    expect(JSON.stringify(error) + String((error as Error).message)).not.toContain(SECRET);
  });

  it("keeps only well-formed debug ids and error names", async () => {
    const fetch: FetchFn = async (url) =>
      url.pathname === "/v1/oauth2/token"
        ? Response.json({ access_token: "A21AAt", expires_in: 3600 })
        : Response.json({ name: "<script>", debug_id: "bad id\n" }, { status: 400 });
    const client = new PayPalClient(credentials, { fetch });
    const reply = await client.request("/v1/a");
    expect(reply.status).toBe(400);
    expect(reply.debugId).toBeNull();
  });
});
