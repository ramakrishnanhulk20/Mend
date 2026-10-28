// Covers paypal-read.ts, the direct reader the agent's four PayPal reads fall back to when
// PayPal's MCP server breaks: the path per tool with every id encoded, the strict input
// checked again, the sandbox API host only, only the Accept and Authorization headers,
// redirects refused, PayPal's statuses, the 401 token drop, the 1 MB cap, bad JSON, the
// time limit and the caller's signal, and a 200 rebuilt by the same viewOf the MCP path
// uses. Does NOT cover: PayPal's real answers (npm run prove:read-keys reads the live
// sandbox), when callPayPalTool falls back (paypal-mcp.test.ts), TLS or DNS.
import { describe, expect, it, vi } from "vitest";
import { DIRECT_PATHS, readDirect } from "./paypal-read";
import { MAX_STREAM_BYTES, McpFailed, McpRefused, viewOf, type TokenSource } from "./paypal-mcp";
import type { FetchFn } from "./paypal";

const TOKEN = "A21AAfake-access-token-for-direct-reads-0123456789";
const ORDER_ID = "9BP88160VF536100T";
const encoder = new TextEncoder();

const ORDER = {
  id: ORDER_ID,
  status: "CREATED",
  create_time: "2026-10-28T07:00:00Z",
  payer: { email_address: "buyer.one@example.com", name: { given_name: "Ada", surname: "Lovelace" } },
  purchase_units: [{ amount: { currency_code: "USD", value: "1.00" }, payee: { email_address: "merchant@example.com" }, items: [{ name: "Mug for buyer.one@example.com", quantity: "1" }] }],
};
const DISPUTE = { dispute_id: "PP-D-27803", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "OPEN", disputed_transactions: [{ buyer: { email: "buyer.one@example.com" } }] };

type Sent = { readonly url: URL; readonly init: RequestInit };

function recorder(answer: (url: URL, init: RequestInit) => Response | Promise<Response>): { fetch: FetchFn; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (url, init) => {
      sent.push({ url, init });
      return answer(url, init);
    },
  };
}

function tokens(get: () => Promise<string> = async () => TOKEN): TokenSource & { readonly gets: () => number } {
  let count = 0;
  return {
    get() {
      count += 1;
      return get();
    },
    drop: vi.fn(),
    gets: () => count,
  };
}

async function failure(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => {
      throw new Error("expected the read to fail");
    },
    (error: unknown) => error,
  );
}

function stalledBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(encoder.encode('{"id":')) });
}

describe("DIRECT_PATHS", () => {
  it.each([
    ["get_order", { id: ORDER_ID }, `/v2/checkout/orders/${ORDER_ID}`],
    ["list_disputes", {}, "/v1/customer/disputes?page_size=20"],
    ["list_disputes", { dispute_state: "REQUIRED_ACTION" }, "/v1/customer/disputes?page_size=20&dispute_state=REQUIRED_ACTION"],
    ["get_dispute", { dispute_id: "PP-R-XGB-10190971" }, "/v1/customer/disputes/PP-R-XGB-10190971"],
    ["show_product_details", { product_id: "PROD-5FD60555F23244316" }, "/v1/catalogs/products/PROD-5FD60555F23244316"],
  ] as const)("maps %s %j to PayPal's REST path", (tool, input, path) => {
    expect((DIRECT_PATHS[tool] as (input: unknown) => string)(input)).toBe(path);
  });

  it("encodes every id, so even an id that slipped past the schema stays one path segment", () => {
    const hostile = "../../v1/payments/payouts?x=1#y";
    const encoded = "..%2F..%2Fv1%2Fpayments%2Fpayouts%3Fx%3D1%23y";
    expect(DIRECT_PATHS.get_order({ id: hostile })).toBe(`/v2/checkout/orders/${encoded}`);
    expect(DIRECT_PATHS.get_dispute({ dispute_id: hostile })).toBe(`/v1/customer/disputes/${encoded}`);
    expect(DIRECT_PATHS.show_product_details({ product_id: hostile })).toBe(`/v1/catalogs/products/${encoded}`);
    expect(DIRECT_PATHS.list_disputes({ dispute_state: "RESOLVED&page_size=500" as "RESOLVED" })).toBe("/v1/customer/disputes?page_size=20&dispute_state=RESOLVED%26page_size%3D500");
  });
});

describe("readDirect", () => {
  it.each([
    ["create_refund", { capture_id: "3C679366HH908993F" }, "not_allowed"],
    ["get_order", { id: "9bp88160vf536100t" }, "invalid_input"],
    ["get_order", { id: ORDER_ID, fields: "payer" }, "invalid_input"],
    ["list_disputes", { buyer_email: "buyer.one@example.com" }, "invalid_input"],
  ])("refuses %s %j before fetching a token or sending anything", async (tool, input, reason) => {
    const server = recorder(() => Response.json(ORDER));
    const source = tokens();
    const error = await failure(readDirect(tool as "get_order", input, { tokens: source, fetch: server.fetch, timeoutMs: 5_000 }));
    expect(error).toBeInstanceOf(McpRefused);
    expect(error).toMatchObject({ reason });
    expect(source.gets()).toBe(0);
    expect(server.sent).toEqual([]);
  });

  it("sends one GET to the sandbox API host with only Accept and Authorization, refusing redirects", async () => {
    const server = recorder(() => Response.json(ORDER));
    await readDirect("get_order", { id: ORDER_ID }, { tokens: tokens(), fetch: server.fetch, timeoutMs: 5_000 });
    expect(server.sent).toHaveLength(1);
    const [{ url, init }] = server.sent;
    expect(url.href).toBe(`https://api-m.sandbox.paypal.com/v2/checkout/orders/${ORDER_ID}`);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    expect([...headers.keys()].sort()).toEqual(["accept", "authorization"]);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(url.href).not.toContain(TOKEN);
  });

  it("rebuilds a 200 answer through the same viewOf the MCP path uses, so no email or identity survives", async () => {
    const order = await readDirect("get_order", { id: ORDER_ID }, { tokens: tokens(), fetch: recorder(() => Response.json(ORDER)).fetch, timeoutMs: 5_000 });
    expect(order).toEqual({ ...viewOf("get_order", ORDER), via: "paypal_rest" });
    expect(order).toMatchObject({ id: ORDER_ID, status: "CREATED", purchase_units: [{ items: [{ name: "Mug for [email removed]", quantity: "1" }] }] });
    const disputes = await readDirect("list_disputes", {}, { tokens: tokens(), fetch: recorder(() => Response.json({ items: [DISPUTE], links: [] })).fetch, timeoutMs: 5_000 });
    expect(disputes).toEqual({ ...viewOf("list_disputes", { items: [DISPUTE] }), via: "paypal_rest" });
    for (const view of [order, disputes]) {
      const text = JSON.stringify(view);
      expect(text).not.toContain("@");
      expect(text).not.toMatch(/Ada|Lovelace|payer|payee|buyer/);
      expect(text).not.toContain(TOKEN);
    }
  });

  it.each([301, 302, 303, 307, 308])("refuses a %i redirect without following it", async (status) => {
    const server = recorder(() => new Response(null, { status, headers: { location: "https://evil.example/v2/checkout/orders/x" } }));
    await expect(readDirect("get_order", { id: ORDER_ID }, { tokens: tokens(), fetch: server.fetch, timeoutMs: 5_000 })).rejects.toMatchObject({ reason: "paypal_error", status });
    expect(server.sent.map((entry) => entry.url.hostname)).toEqual(["api-m.sandbox.paypal.com"]);
  });

  it("reports PayPal's 404 as not_found", async () => {
    const server = recorder(() => Response.json({ name: "RESOURCE_NOT_FOUND", message: `order ${ORDER_ID} for buyer.one@example.com` }, { status: 404 }));
    const error = await failure(readDirect("get_order", { id: ORDER_ID }, { tokens: tokens(), fetch: server.fetch, timeoutMs: 5_000 }));
    expect(error).toBeInstanceOf(McpFailed);
    expect(error).toMatchObject({ reason: "not_found", status: 404 });
    expect((error as Error).message).not.toMatch(/buyer|example|RESOURCE/);
  });

  it("forgets the token when PayPal answers 401", async () => {
    const source = tokens();
    await expect(readDirect("get_order", { id: ORDER_ID }, { tokens: source, fetch: recorder(() => new Response("{}", { status: 401 })).fetch, timeoutMs: 5_000 })).rejects.toMatchObject({ reason: "paypal_error", status: 401 });
    expect(source.drop).toHaveBeenCalledWith(TOKEN);
  });

  it.each([400, 403, 422, 429, 500, 503])("reports status %i as paypal_error with the status only, keeping the token", async (status) => {
    const source = tokens();
    const error = await failure(readDirect("get_order", { id: ORDER_ID }, { tokens: source, fetch: recorder(() => Response.json({ name: "NOT_AUTHORIZED", message: "nope" }, { status })).fetch, timeoutMs: 5_000 }));
    expect(error).toMatchObject({ reason: "paypal_error", status });
    expect((error as Error).message).not.toMatch(/nope|NOT_AUTHORIZED|A21AA/);
    expect(source.drop).not.toHaveBeenCalled();
  });

  it("stops reading a body past 1 MB", async () => {
    let pulls = 0;
    const chunk = encoder.encode(`"${"x".repeat(256 * 1024)}",`);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
    });
    const server = recorder(() => new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    await expect(readDirect("get_order", { id: ORDER_ID }, { tokens: tokens(), fetch: server.fetch, timeoutMs: 5_000 })).rejects.toMatchObject({ reason: "too_large" });
    expect(pulls * chunk.byteLength).toBeLessThan(MAX_STREAM_BYTES + 2 * chunk.byteLength);
  });

  it.each([
    ["text that is not JSON", "<html>busy</html>"],
    ["an empty body", ""],
  ])("reports %s as protocol", async (_label, text) => {
    const server = recorder(() => new Response(text, { status: 200 }));
    await expect(readDirect("get_order", { id: ORDER_ID }, { tokens: tokens(), fetch: server.fetch, timeoutMs: 5_000 })).rejects.toMatchObject({ reason: "protocol" });
  });

  it("reports a connection failure as unreachable", async () => {
    const fetch: FetchFn = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(readDirect("get_order", { id: ORDER_ID }, { tokens: tokens(), fetch, timeoutMs: 5_000 })).rejects.toMatchObject({ reason: "unreachable" });
  });

  it("gives up after its time limit, whether the token, the headers or the body never come", async () => {
    const never = () => new Promise<Response>(() => undefined);
    const cases = [
      { tokens: tokens(() => new Promise<string>(() => undefined)), fetch: recorder(() => Response.json(ORDER)).fetch },
      { tokens: tokens(), fetch: recorder(never).fetch },
      { tokens: tokens(), fetch: recorder(() => new Response(stalledBody(), { status: 200 })).fetch },
    ];
    for (const options of cases) {
      const started = Date.now();
      await expect(readDirect("get_order", { id: ORDER_ID }, { ...options, timeoutMs: 50 })).rejects.toMatchObject({ reason: "timeout" });
      expect(Date.now() - started).toBeLessThan(2_000);
    }
  });

  it("gives up when the caller's signal aborts", async () => {
    const caller = new AbortController();
    const pending = readDirect("get_order", { id: ORDER_ID }, { tokens: tokens(), fetch: recorder(() => new Response(stalledBody(), { status: 200 })).fetch, timeoutMs: 5_000, signal: caller.signal });
    setTimeout(() => caller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ reason: "timeout" });
  });
});
