// Covers Mend's client for PayPal's MCP server against a fake server that speaks the
// same SSE protocol the live probe recorded: the exact-host guard on the SSE URL and on
// the endpoint the server names, the four-tool allowlist, strict inputs, the rebuilt
// answers with identity dropped at every depth, PayPal's errors, the time limit, the
// stream cap and the token request. Does NOT cover: PayPal's real answers (npm run
// prove:m6 calls the live sandbox server), the agent's wiring (agent.test.ts), TLS or DNS.
import { describe, expect, it, vi } from "vitest";
import {
  callPayPalTool,
  MAX_STREAM_BYTES,
  MCP_HOST,
  McpFailed,
  McpRefused,
  mcpUrl,
  READ_TOOLS,
  sandboxTokens,
  type McpOptions,
  type TokenSource,
} from "./paypal-mcp";
import { HostRefused, type FetchFn } from "./paypal";

const TOKEN = "A21AAfake-access-token-for-mcp-tests-0123456789";
const ORDER_ID = "9BP88160VF536100T";
const encoder = new TextEncoder();

type Sent = { readonly url: URL; readonly init: RequestInit; readonly message: Record<string, unknown> | null };
type Server = { readonly fetch: FetchFn; readonly sent: Sent[] };

function textResult(answer: unknown) {
  return { content: [{ type: "text", text: typeof answer === "string" ? answer : JSON.stringify(answer) }] };
}

/** A stand-in for PayPal's MCP server: an SSE stream on GET, 202 on POST, each answer pushed onto the stream. */
function fakeServer(options: { endpoint?: string | null; tool?: (params: Record<string, unknown>) => unknown; silent?: boolean; before?: string } = {}): Server {
  const sent: Sent[] = [];
  let push: (text: string) => void = () => undefined;
  const fetch: FetchFn = async (url, init) => {
    const message = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    sent.push({ url, init, message });
    if ((init.method ?? "GET") === "GET") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (text) => {
            try {
              controller.enqueue(encoder.encode(text));
            } catch {
              // The client has already closed the stream.
            }
          };
          if (options.before !== undefined) push(options.before);
          if (options.endpoint !== null) push(`event: endpoint\ndata: ${options.endpoint ?? "/sse/message?sessionId=fake-session-1"}\n\n`);
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (message !== null && message.id !== undefined && options.silent !== true) {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const reply =
        message.method === "initialize"
          ? { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "PayPal MCP Agent", version: "1.0.0" } } }
          : { jsonrpc: "2.0", id: message.id, ...(options.tool?.(params) as object) };
      // A notification first, as a real server may send, which the client must step over.
      setTimeout(() => push(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\r\n\r\nevent: message\ndata: ${JSON.stringify(reply)}\r\n\r\n`), 0);
    }
    return new Response("Accepted", { status: 202, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, sent };
}

function tokens(): TokenSource & { readonly gets: () => number } {
  let count = 0;
  return {
    async get() {
      count += 1;
      return TOKEN;
    },
    drop: vi.fn(),
    gets: () => count,
  };
}

function call(server: Server, name: string, args: unknown, extra: Partial<McpOptions> = {}) {
  return callPayPalTool(name, args, { fetch: server.fetch, tokens: tokens(), ...extra });
}

async function failure(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error,
  );
}

// Identity planted at several depths, each of which must be gone from what the caller gets.
const PERSONAL = [
  "buyer.one@example.com",
  "Ada",
  "Lovelace",
  "Ada Lovelace",
  "7 Analytical Lane",
  "Flat 2",
  "Marylebone",
  "NW1 6XE",
  "4085551234",
  "PAYERID123456",
  "merchant.payee@example.com",
  "MERCHANTID9876",
  "Ship Tothis Person",
  "1 Shipping Road",
  "Card Holder Name",
  "secret.buyer@example.org",
  "Grace Hopper",
  "seller.reply@example.net",
];

const ORDER = {
  id: ORDER_ID,
  intent: "CAPTURE",
  status: "COMPLETED",
  create_time: "2026-10-24T08:13:20Z",
  update_time: "2026-10-24T08:14:02Z",
  payer: {
    name: { given_name: "Ada", surname: "Lovelace" },
    email_address: "buyer.one@example.com",
    payer_id: "PAYERID123456",
    phone: { phone_number: { national_number: "4085551234" } },
    address: { address_line_1: "7 Analytical Lane", address_line_2: "Flat 2", admin_area_2: "Marylebone", postal_code: "NW1 6XE", country_code: "GB" },
  },
  payment_source: {
    paypal: { email_address: "buyer.one@example.com", account_id: "PAYERID123456", name: { given_name: "Ada", surname: "Lovelace" } },
    card: { name: "Card Holder Name", last_digits: "7704" },
  },
  purchase_units: [
    {
      reference_id: "default",
      amount: { currency_code: "USD", value: "12.50", breakdown: { item_total: { currency_code: "USD", value: "12.50" } } },
      payee: { email_address: "merchant.payee@example.com", merchant_id: "MERCHANTID9876" },
      custom_id: "mend:R3",
      description: "Ada Lovelace's order",
      items: [
        { name: "Red teapot", quantity: "1", unit_amount: { currency_code: "USD", value: "10.00" }, buyer: { email_address: "secret.buyer@example.org" } },
        { name: "Mug for secret.buyer@example.org", quantity: "2", sku: "MUG-1" },
      ],
      shipping: { name: { full_name: "Ship Tothis Person" }, address: { address_line_1: "1 Shipping Road", postal_code: "NW1 6XE" } },
      payments: {
        captures: [
          {
            id: "3C679366HH908993F",
            status: "COMPLETED",
            amount: { currency_code: "USD", value: "12.50" },
            seller_receivable_breakdown: { paypal_fee: { currency_code: "USD", value: "0.79" } },
            payer: { name: { full_name: "Grace Hopper" } },
            links: [{ href: "https://api-m.sandbox.paypal.com/v2/payments/captures/3C679366HH908993F", rel: "self" }],
          },
        ],
      },
    },
  ],
  links: [{ href: "https://www.sandbox.paypal.com/checkoutnow?token=x", rel: "approve" }],
};

const DISPUTE = {
  dispute_id: "PP-D-27803",
  create_time: "2026-10-20T09:00:00.000Z",
  update_time: "2026-10-21T09:00:00.000Z",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_state: "REQUIRED_ACTION",
  dispute_amount: { currency_code: "USD", value: "12.50" },
  dispute_life_cycle_stage: "INQUIRY",
  dispute_channel: "INTERNAL",
  seller_response_due_date: "2026-10-30T09:00:00.000Z",
  disputed_transactions: [
    {
      buyer: { name: "Ada Lovelace", email: "buyer.one@example.com", payer_id: "PAYERID123456" },
      seller: { email: "merchant.payee@example.com", merchant_id: "MERCHANTID9876", name: "Grace Hopper" },
      items: [{ item_description: "Red teapot", notes: "ship to 7 Analytical Lane" }],
    },
  ],
  messages: [{ posted_by: "BUYER", content: "Please reply to seller.reply@example.net, Ada Lovelace, 4085551234" }],
  offer: { buyer_requested_amount: { currency_code: "USD", value: "12.50" } },
  links: [{ href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-27803", rel: "self" }],
};

const PRODUCT = {
  id: "PROD-5FD60555F23244316",
  name: "Red teapot",
  description: "Hand thrown. Questions to buyer.one@example.com",
  type: "PHYSICAL",
  category: "HOUSEWARES",
  image_url: "https://example.com/teapot.png",
  home_url: "https://example.com",
  create_time: "2026-10-01T00:00:00Z",
  links: [{ href: "https://api-m.sandbox.paypal.com/v1/catalogs/products/PROD-5FD60555F23244316", rel: "self" }],
};

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
}

function expectNoPersonalData(value: unknown): void {
  const text = JSON.stringify(value);
  for (const personal of PERSONAL) expect(text, personal).not.toContain(personal);
  expect(text).not.toContain("@");
  const identity = /^(payer|payer_id|payee|shipping|address|phone|email|email_address|payment_source|given_name|surname|full_name|merchant_id|buyer|seller|messages|disputed_transactions|links|href)$/;
  expect(keysOf(value).filter((key) => identity.test(key))).toEqual([]);
}

describe("mcpUrl", () => {
  it.each([
    ["https://mcp.sandbox.paypal.com/sse", "https://mcp.sandbox.paypal.com/sse"],
    ["https://MCP.SANDBOX.PAYPAL.COM/sse", "https://mcp.sandbox.paypal.com/sse"],
    ["https://mcp.sandbox.paypal.com:443/sse", "https://mcp.sandbox.paypal.com/sse"],
    ["/sse/message?sessionId=abc-123", "https://mcp.sandbox.paypal.com/sse/message?sessionId=abc-123"],
    ["message?sessionId=abc", "https://mcp.sandbox.paypal.com/message?sessionId=abc"],
  ])("accepts %s", (input, href) => {
    expect(mcpUrl(input).href).toBe(href);
  });

  it.each([
    ["a lookalike suffix", "https://mcp.sandbox.paypal.com.evil.example/sse"],
    ["a lookalike prefix", "https://evilmcp.sandbox.paypal.com/sse"],
    ["a sibling subdomain", "https://x.mcp.sandbox.paypal.com/sse"],
    ["a dash instead of a dot", "https://mcp-sandbox.paypal.com/sse"],
    ["the live MCP host", "https://mcp.paypal.com/sse"],
    ["the sandbox REST host", "https://api-m.sandbox.paypal.com/sse"],
    ["a capital I for an l", "https://mcp.sandbox.paypaI.com/sse"],
    ["a trailing dot", "https://mcp.sandbox.paypal.com./sse"],
    ["plain http", "http://mcp.sandbox.paypal.com/sse"],
    ["another port", "https://mcp.sandbox.paypal.com:8443/sse"],
    ["userinfo before another host", "https://mcp.sandbox.paypal.com@evil.example/sse"],
    ["userinfo on the right host", "https://user:pw@mcp.sandbox.paypal.com/sse"],
    ["the host only in the query", "https://evil.example/sse?host=mcp.sandbox.paypal.com"],
    ["the host only in the fragment", "https://evil.example/sse#mcp.sandbox.paypal.com"],
    ["a protocol-relative URL", "//evil.example/sse"],
    ["a backslash protocol-relative URL", "/\\evil.example/sse"],
    ["a tab inside the host", "https://mcp.sandbox.pay\tpal.com/sse"],
    ["a non-ASCII host", "https://mcp.sandbox.pаypal.com/sse"],
    ["an empty string", ""],
  ])("refuses %s", (_label, input) => {
    expect(() => mcpUrl(input)).toThrow(HostRefused);
  });
});

describe("callPayPalTool", () => {
  it("refuses every name but the four read tools before fetching a token or sending anything", async () => {
    const server = fakeServer();
    const source = tokens();
    for (const name of ["create_invoice", "send_invoice", "create_order", "capture_order", "create_refund", "accept_dispute_claim", "list_transactions", "GET_ORDER", "get_order ", "__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const error = await failure(callPayPalTool(name, { id: ORDER_ID }, { fetch: server.fetch, tokens: source }));
      expect(error, name).toBeInstanceOf(McpRefused);
      expect((error as McpRefused).reason).toBe("not_allowed");
    }
    expect(READ_TOOLS).toEqual(["get_order", "list_disputes", "get_dispute", "show_product_details"]);
    expect(source.gets()).toBe(0);
    expect(server.sent).toEqual([]);
  });

  it.each([
    ["get_order", { id: "9bp88160vf536100t" }],
    ["get_order", { id: "9BP88160VF536100T/../../v1/payments" }],
    ["get_order", { id: "SHORT123" }],
    ["get_order", { id: ORDER_ID, fields: "payer" }],
    ["get_order", {}],
    ["get_order", "9BP88160VF536100T"],
    ["list_disputes", { buyer_email: "buyer.one@example.com" }],
    ["list_disputes", { disputed_transaction_id: "3C679366HH908993F" }],
    ["list_disputes", { dispute_state: "EVERYTHING" }],
    ["get_dispute", { dispute_id: "PP-D-1;drop" }],
    ["get_dispute", { dispute_id: ORDER_ID }],
    ["show_product_details", { product_id: "short" }],
  ])("refuses %s with %j before sending anything", async (name, args) => {
    const server = fakeServer();
    const error = await failure(call(server, name, args));
    expect(error).toBeInstanceOf(McpRefused);
    expect((error as McpRefused).reason).toBe("invalid_input");
    expect(server.sent).toEqual([]);
  });

  it("speaks MCP over SSE to the sandbox MCP host only, with the token only in the Authorization header", async () => {
    const server = fakeServer({ tool: () => ({ result: textResult(ORDER) }) });
    const view = await call(server, "get_order", { id: ORDER_ID });

    expect(server.sent.map((entry) => [entry.init.method, entry.url.href, entry.message?.method ?? null])).toEqual([
      ["GET", "https://mcp.sandbox.paypal.com/sse", null],
      ["POST", "https://mcp.sandbox.paypal.com/sse/message?sessionId=fake-session-1", "initialize"],
      ["POST", "https://mcp.sandbox.paypal.com/sse/message?sessionId=fake-session-1", "notifications/initialized"],
      ["POST", "https://mcp.sandbox.paypal.com/sse/message?sessionId=fake-session-1", "tools/call"],
    ]);
    expect(server.sent[1].message?.params).toMatchObject({ protocolVersion: "2025-06-18" });
    expect(server.sent[3].message?.params).toEqual({ name: "get_order", arguments: { id: ORDER_ID } });
    for (const entry of server.sent) {
      expect(entry.url.hostname).toBe(MCP_HOST);
      expect(entry.init.redirect).toBe("error");
      expect(entry.init.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(entry.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(String(entry.init.body ?? "")).not.toContain(TOKEN);
    }
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });

  it.each([
    ["another host", "https://evil.example/sse/message?sessionId=1"],
    ["a protocol-relative path", "//evil.example/sse/message?sessionId=1"],
    ["a lookalike suffix", "https://mcp.sandbox.paypal.com.evil.example/sse/message"],
    ["userinfo before another host", "https://mcp.sandbox.paypal.com@evil.example/sse/message"],
    ["plain http", "http://mcp.sandbox.paypal.com/sse/message"],
    ["another port", "https://mcp.sandbox.paypal.com:8443/sse/message"],
  ])("refuses an endpoint on %s and sends nothing to it", async (_label, endpoint) => {
    const server = fakeServer({ endpoint, tool: () => ({ result: textResult(ORDER) }) });
    await expect(call(server, "get_order", { id: ORDER_ID })).rejects.toThrow(HostRefused);
    expect(server.sent.map((entry) => entry.init.method)).toEqual(["GET"]);
  });

  it("keeps only the listed order fields, dropping payer, payee, shipping and payment source at every depth", async () => {
    const server = fakeServer({ tool: () => ({ result: textResult(ORDER) }) });
    const view = await call(server, "get_order", { id: ORDER_ID });
    expect(view).toEqual({
      id: ORDER_ID,
      status: "COMPLETED",
      create_time: "2026-10-24T08:13:20Z",
      update_time: "2026-10-24T08:14:02Z",
      purchase_units: [
        {
          amount: { currency_code: "USD", value: "12.50" },
          items: [
            { name: "Red teapot", quantity: "1" },
            { name: "Mug for [email removed]", quantity: "2" },
          ],
          captures: [{ id: "3C679366HH908993F", status: "COMPLETED" }],
        },
      ],
    });
    expectNoPersonalData(view);
  });

  it("keeps only the listed dispute fields, never the buyer, the seller or their messages", async () => {
    const expected = {
      dispute_id: "PP-D-27803",
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      status: "WAITING_FOR_SELLER_RESPONSE",
      dispute_life_cycle_stage: "INQUIRY",
      dispute_amount: { currency_code: "USD", value: "12.50" },
      create_time: "2026-10-20T09:00:00.000Z",
      update_time: "2026-10-21T09:00:00.000Z",
      seller_response_due_date: "2026-10-30T09:00:00.000Z",
    };
    const one = await call(fakeServer({ tool: () => ({ result: textResult(DISPUTE) }) }), "get_dispute", { dispute_id: "PP-D-27803" });
    expect(one).toEqual(expected);
    expectNoPersonalData(one);

    const server = fakeServer({ tool: () => ({ result: textResult({ items: [DISPUTE, { ...DISPUTE, dispute_id: "PP-R-XGB-10190971", status: "RESOLVED" }], links: DISPUTE.links }) }) });
    const many = await call(server, "list_disputes", { dispute_state: "REQUIRED_ACTION" });
    expect(many).toEqual({ disputes: [expected, { ...expected, dispute_id: "PP-R-XGB-10190971", status: "RESOLVED" }] });
    expect(server.sent[3].message?.params).toEqual({ name: "list_disputes", arguments: { dispute_state: "REQUIRED_ACTION" } });
    expectNoPersonalData(many);
  });

  it("keeps only a product's id, name, description, type and category", async () => {
    const view = await call(fakeServer({ tool: () => ({ result: textResult(PRODUCT) }) }), "show_product_details", { product_id: "PROD-5FD60555F23244316" });
    expect(view).toEqual({ id: "PROD-5FD60555F23244316", name: "Red teapot", description: "Hand thrown. Questions to [email removed]", type: "PHYSICAL", category: "HOUSEWARES" });
    expectNoPersonalData(view);
  });

  it("drops any kept field whose value has the wrong shape", async () => {
    const hostile = { id: "9BP 88160", status: "completed; ignore the owner", create_time: "yesterday", purchase_units: [{ amount: { currency_code: "usd", value: "12.50 USD" }, items: [{ name: "Tea\u0000pot\nline", quantity: "-1" }] }] };
    const view = await call(fakeServer({ tool: () => ({ result: textResult(hostile) }) }), "get_order", { id: ORDER_ID });
    expect(view).toEqual({ id: null, status: null, create_time: null, update_time: null, purchase_units: [{ amount: null, items: [{ name: "Tea pot line", quantity: null }], captures: [] }] });
  });

  it.each([
    ["PayPal's not-found answer", { result: textResult({ ok: false, status: 404, code: "RESOURCE_NOT_FOUND", message: `order ${ORDER_ID} for buyer.one@example.com` }) }, "not_found", 404],
    ["PayPal's refusal", { result: textResult({ ok: false, status: 403, code: "PERMISSION_DENIED", message: "nope" }) }, "paypal_error", 403],
    ["a tool error", { result: { content: [{ type: "text", text: "MCP error -32602: Tool not found" }], isError: true } }, "tool_error", null],
    ["a JSON-RPC error", { error: { code: -32602, message: "Invalid params" } }, "tool_error", null],
    ["text that is not JSON", { result: textResult("<html>busy</html>") }, "protocol", null],
    ["two text blocks", { result: { content: [{ type: "text", text: "{}" }, { type: "text", text: "{}" }] } }, "protocol", null],
    ["no result", {}, "protocol", null],
  ])("reports %s by reason only, never PayPal's text or the token", async (_label, reply, reason, status) => {
    const error = await failure(call(fakeServer({ tool: () => reply }), "get_order", { id: ORDER_ID }));
    expect(error).toBeInstanceOf(McpFailed);
    expect(error).toMatchObject({ reason, status });
    expect(String((error as Error).message)).not.toMatch(/buyer|example|nope|Invalid|busy|A21AA/);
  });

  it("gives up after its time limit when the server goes quiet, at any step", async () => {
    for (const server of [fakeServer({ endpoint: null }), fakeServer({ silent: true })]) {
      const started = Date.now();
      const error = await failure(call(server, "get_order", { id: ORDER_ID }, { timeoutMs: 50 }));
      expect(error).toBeInstanceOf(McpFailed);
      expect((error as McpFailed).reason).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(2_000);
    }
    const caller = new AbortController();
    const pending = call(fakeServer({ silent: true }), "get_order", { id: ORDER_ID }, { signal: caller.signal });
    setTimeout(() => caller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ reason: "timeout" });
  });

  it("stops reading a stream past 1 MB", async () => {
    const server = fakeServer({ endpoint: null, before: `: ${"x".repeat(MAX_STREAM_BYTES)}\n\n` });
    await expect(call(server, "get_order", { id: ORDER_ID })).rejects.toMatchObject({ reason: "too_large" });
  });

  it("forgets the token when PayPal's MCP server answers 401", async () => {
    const source = tokens();
    const fetch: FetchFn = async () => new Response("unauthorized", { status: 401 });
    await expect(callPayPalTool("list_disputes", {}, { fetch, tokens: source })).rejects.toMatchObject({ reason: "paypal_error", status: 401 });
    expect(source.drop).toHaveBeenCalledWith(TOKEN);
  });
});

describe("sandboxTokens", () => {
  const credentials = Object.freeze({ clientId: "client-id-for-tests", clientSecret: "client-secret-for-mcp-tests" });

  it("asks the sandbox API host for a client-credentials token once while it is fresh, and again after a drop", async () => {
    const sent: { url: URL; init: RequestInit }[] = [];
    const fetch: FetchFn = async (url, init) => {
      sent.push({ url, init });
      return Response.json({ access_token: `${TOKEN}${sent.length}`, expires_in: 32_400 });
    };
    const source = sandboxTokens(credentials, { fetch });
    const [first, second] = await Promise.all([source.get(), source.get()]);
    expect(first).toBe(`${TOKEN}1`);
    expect(second).toBe(first);
    source.drop(first);
    expect(await source.get()).toBe(`${TOKEN}2`);
    expect(sent.map((entry) => [entry.init.method, entry.url.href, entry.init.redirect])).toEqual([
      ["POST", "https://api-m.sandbox.paypal.com/v1/oauth2/token", "error"],
      ["POST", "https://api-m.sandbox.paypal.com/v1/oauth2/token", "error"],
    ]);
    expect(new Headers(sent[0].init.headers).get("authorization")).toBe(`Basic ${Buffer.from("client-id-for-tests:client-secret-for-mcp-tests").toString("base64")}`);
  });

  it("refuses an answer without a usable token, without the secret in the error", async () => {
    const fetch: FetchFn = async () => Response.json({ access_token: TOKEN, expires_in: "3600" });
    const error = await failure(sandboxTokens(credentials, { fetch }).get());
    expect(error).toMatchObject({ reason: "paypal_error", status: 200 });
    expect(String((error as Error).message)).not.toContain("client-secret-for-mcp-tests");
  });
});
