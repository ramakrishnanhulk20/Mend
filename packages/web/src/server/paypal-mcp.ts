/**
 * Mend's own client for PayPal's hosted MCP server: four read-only tools, called from
 * Mend's server, with identity stripped before anything is handed on (C1, C12, C15,
 * C16, C17).
 *
 * The model never connects to PayPal and never sees the PayPal token. Mend's server
 * opens the MCP session itself, sends the token only in the Authorization header to
 * PayPal's MCP host, and hands the agent a rebuilt copy of the answer. Only get_order,
 * list_disputes, get_dispute and show_product_details can be called: any other name is
 * refused before a token is fetched or a byte is sent, and each tool's arguments pass a
 * strict schema first. The SSE URL and the message endpoint the server names go through
 * the same WHATWG parser and are refused unless the hostname equals
 * mcp.sandbox.paypal.com exactly, over https on the default port with no userinfo.
 * Redirects are refused, so a reply cannot move a request elsewhere. One session per
 * call, 15 seconds for the whole exchange, at most 1 MB and 200 events of stream.
 *
 * The token comes from the read-only sandbox app when its keys are set (config.ts
 * readOnlyCredentials): PayPal refuses that app's token on the Payouts API. When PayPal's
 * MCP server fails in its own setup, cannot be reached or breaks the protocol, and at least
 * 5 seconds of the call are left, the same read goes straight to PayPal's sandbox REST API
 * under the same rules (paypal-read.ts). Every answer says which way it came: via
 * "paypal_mcp" or via "paypal_rest".
 *
 * Answers are rebuilt from a fixed list of fields per tool, each checked for shape;
 * nothing else is copied. So no payer, payee, shipping, payment source, address, email,
 * phone or person's name reaches the caller from any depth, and PayPal's data is not
 * kept around for any other use. Free text that is kept (item and product names, a
 * product description) is cut to length with control characters and email addresses
 * removed.
 *
 * Does not cover: wording inside merchant-set text such as a product description (the
 * agent treats every tool result as data, C11), a phone number written into such text,
 * or DNS and TLS attacks on the real host (Node's certificate check covers those).
 */
import { z } from "zod";
import { withoutEmails } from "./claude";
import { loadConfig, type PayPalCredentials } from "./config";
import { writeLog } from "./log";
import { HostRefused, sandboxUrl, TOKEN_REFRESH_MARGIN_MS, type FetchFn } from "./paypal";

export const MCP_HOST = "mcp.sandbox.paypal.com";
export const MCP_SSE_URL = `https://${MCP_HOST}/sse`;
export const MCP_CALL_TIMEOUT_MS = 15_000;
export const MAX_STREAM_BYTES = 1024 * 1024;
export const MAX_STREAM_EVENTS = 200;
/** The least time left in a call for which a failed MCP read is retried on PayPal's REST API. */
export const MIN_FALLBACK_MS = 5_000;
// What PayPal's MCP server answers when its own setup is broken (AI-Toolkit issue 34); it says nothing about the thing asked for.
const SETUP_ERROR_CODE = "PAYPAL_API_SETUP_ERROR";
// The version the probe of 24 Oct saw PayPal agree to. A server that cannot speak it
// answers with another, and the call is refused rather than guessed at.
const PROTOCOL_VERSION = "2025-06-18";
const MAX_TOKEN_REPLY_CHARS = 64 * 1024;
const PRINTABLE_NO_SPACE = /^[\x21-\x7e]+$/;
const TOKEN_SHAPE = /^[\x21-\x7e]{20,4096}$/;

const ORDER_ID = /^[A-Z0-9]{17,32}$/;
// Dispute ids as PayPal issues them, for example PP-D-27803 and PP-R-XGB-10190971.
const DISPUTE_ID = /^PP-[A-Z]-[A-Z0-9-]{1,40}$/;
const PRODUCT_ID = /^[A-Za-z0-9_-]{12,50}$/;
const DISPUTE_STATES = ["REQUIRED_ACTION", "REQUIRED_OTHER_PARTY_ACTION", "UNDER_PAYPAL_REVIEW", "RESOLVED", "OPEN_INQUIRIES", "APPEALABLE"] as const;

const PAYPAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CURRENCY = /^[A-Z]{3}$/;
const DECIMAL = /^-?\d{1,15}(?:\.\d{1,3})?$/;
const QUANTITY = /^\d{1,10}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * The strict inputs of the four tools, matching the argument names PayPal's MCP server
 * takes. Patterns are the server's own where it states one, so a value that passes here
 * is never rejected there. list_disputes takes a state filter only, never a customer.
 */
export const READ_TOOL_INPUTS = {
  get_order: z.strictObject({
    id: z.string().regex(ORDER_ID).describe("The PayPal order id: 17 to 32 capital letters and digits, for example 5O190127TN364715T"),
  }),
  list_disputes: z.strictObject({
    dispute_state: z.enum(DISPUTE_STATES).optional().describe("Only disputes in this state; leave it out to see every dispute"),
  }),
  get_dispute: z.strictObject({
    dispute_id: z.string().regex(DISPUTE_ID).describe("The PayPal dispute id, for example PP-D-27803"),
  }),
  show_product_details: z.strictObject({
    product_id: z.string().regex(PRODUCT_ID).describe("The PayPal catalog product id, for example PROD-5FD60555F23244316"),
  }),
} as const;

export type ReadTool = keyof typeof READ_TOOL_INPUTS;
export const READ_TOOLS: readonly ReadTool[] = Object.freeze(["get_order", "list_disputes", "get_dispute", "show_product_details"]);

export type RefusedReason = "not_allowed" | "invalid_input";
export type FailedReason = "timeout" | "unreachable" | "too_large" | "protocol" | "not_found" | "paypal_error" | "tool_error" | "server_setup";

// Failures that say PayPal's MCP server is broken, not that the read itself was refused or
// too slow, so the same read is worth trying on PayPal's REST API.
const FALLBACK_REASONS: ReadonlySet<FailedReason> = new Set(["server_setup", "unreachable", "protocol"]);

/** The call was refused before a token was fetched or anything was sent. */
export class McpRefused extends Error {
  readonly reason: RefusedReason;

  constructor(reason: RefusedReason) {
    super(`refused before sending: ${reason}`);
    this.name = "McpRefused";
    this.reason = reason;
  }
}

/** The call was sent and did not produce a usable answer. Carries no token and no PayPal text. */
export class McpFailed extends Error {
  readonly reason: FailedReason;
  readonly status: number | null;

  constructor(reason: FailedReason, status: unknown = null) {
    const code = typeof status === "number" && Number.isInteger(status) ? status : null;
    super(`PayPal MCP call failed: ${reason}${code === null ? "" : ` (status ${code})`}`);
    this.name = "McpFailed";
    this.reason = reason;
    this.status = code;
  }
}

/**
 * Resolve a URL or path against PayPal's MCP SSE URL and return the parsed URL that may
 * be fetched. Both the configured SSE URL and the endpoint the server names come
 * through here, so they are compared after the same parser.
 *
 * Refused with HostRefused unless the result is https, its hostname equals
 * mcp.sandbox.paypal.com exactly (no suffix or pattern match), it has no userinfo and
 * no port but 443. Covers lookalike and suffix hosts, the live host, protocol-relative
 * and backslash tricks, userinfo, plain http, other ports, hosts hidden in the query or
 * fragment, and whitespace or non-ASCII the parser would quietly drop.
 */
export function mcpUrl(pathOrUrl: string): URL {
  if (typeof pathOrUrl !== "string" || pathOrUrl === "") throw new HostRefused("empty URL");
  if (!PRINTABLE_NO_SPACE.test(pathOrUrl)) throw new HostRefused("URL contains spaces, control or non-ASCII characters");
  let url: URL;
  try {
    url = new URL(pathOrUrl, MCP_SSE_URL);
  } catch {
    throw new HostRefused("URL could not be parsed");
  }
  if (url.protocol !== "https:") throw new HostRefused("only https is allowed");
  if (url.hostname !== MCP_HOST) throw new HostRefused("host is not PayPal's sandbox MCP server");
  if (url.username !== "" || url.password !== "") throw new HostRefused("URL carries userinfo");
  if (url.port !== "") throw new HostRefused("unexpected port");
  return url;
}

/** Where the PayPal access token comes from, and how a token PayPal stopped accepting is forgotten. */
export type TokenSource = {
  get(): Promise<string>;
  drop(token: string): void;
};

export type SandboxTokenOptions = {
  /** Test seam; production leaves it unset and uses the global fetch at call time. */
  readonly fetch?: FetchFn;
  readonly now?: () => number;
  readonly timeoutMs?: number;
};

function timedOut(error: unknown): boolean {
  const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Client-credentials access tokens for the PayPal sandbox, cached until a minute before
 * PayPal says they expire. The token request is checked by paypal.ts's sandboxUrl, so it
 * can only go to api-m.sandbox.paypal.com. Throws McpFailed on a timeout, a connection
 * failure or an answer without a usable token; the message never holds the secret.
 */
export function sandboxTokens(credentials: PayPalCredentials, options: SandboxTokenOptions = {}): TokenSource {
  const now = options.now ?? Date.now;
  let cached: { readonly value: string; readonly usableUntil: number } | null = null;
  let pending: Promise<string> | null = null;

  const mint = async (): Promise<string> => {
    const startedAt = now();
    const fetchFn: FetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
    let status: number;
    let text: string;
    try {
      const response = await fetchFn(sandboxUrl("/v1/oauth2/token"), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
        body: "grant_type=client_credentials",
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? MCP_CALL_TIMEOUT_MS),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      if (error instanceof HostRefused) throw error;
      throw new McpFailed(timedOut(error) ? "timeout" : "unreachable");
    }
    let body: unknown = null;
    try {
      body = text.length <= MAX_TOKEN_REPLY_CHARS ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const token = field(body, "access_token");
    const expiresIn = field(body, "expires_in");
    if (status !== 200 || typeof token !== "string" || !TOKEN_SHAPE.test(token) || typeof expiresIn !== "number" || !Number.isInteger(expiresIn) || expiresIn <= 0) {
      throw new McpFailed("paypal_error", status);
    }
    // Measured from before the request, so the cached token never outlives PayPal's clock.
    cached = { value: token, usableUntil: startedAt + expiresIn * 1000 - TOKEN_REFRESH_MARGIN_MS };
    return token;
  };

  return {
    async get() {
      if (cached !== null && now() < cached.usableUntil) return cached.value;
      cached = null;
      // Concurrent calls share one token request instead of each minting their own.
      pending ??= mint().finally(() => {
        pending = null;
      });
      return pending;
    },
    drop(token) {
      if (cached?.value === token) cached = null;
    },
  };
}

let appTokens: TokenSource | undefined;

function defaultTokens(): TokenSource {
  appTokens ??= sandboxTokens(loadConfig().paypalRead);
  return appTokens;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function list(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function shaped(value: unknown, shape: RegExp): string | null {
  return typeof value === "string" && shape.test(value) ? value : null;
}

function prose(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  // Emails go before the cut, so cutting can never leave a whole address behind.
  const clean = withoutEmails(value.replace(CONTROL, " ")).replace(/\s+/g, " ").trim().slice(0, maxChars);
  return clean === "" ? null : clean;
}

function money(value: unknown): { readonly currency_code: string; readonly value: string } | null {
  const currency = shaped(field(value, "currency_code"), CURRENCY);
  const amount = shaped(field(value, "value"), DECIMAL);
  return currency === null || amount === null ? null : { currency_code: currency, value: amount };
}

/** An order as the agent may see it: status, times, amounts, item names and counts, capture ids and statuses. */
function orderView(order: unknown) {
  return {
    id: shaped(field(order, "id"), PAYPAL_ID),
    status: shaped(field(order, "status"), CODE),
    create_time: shaped(field(order, "create_time"), TIME),
    update_time: shaped(field(order, "update_time"), TIME),
    purchase_units: list(field(order, "purchase_units"), 10).map((unit) => ({
      amount: money(field(unit, "amount")),
      items: list(field(unit, "items"), 50).map((item) => ({ name: prose(field(item, "name"), 127), quantity: shaped(field(item, "quantity"), QUANTITY) })),
      captures: list(field(field(unit, "payments"), "captures"), 20).map((capture) => ({ id: shaped(field(capture, "id"), PAYPAL_ID), status: shaped(field(capture, "status"), CODE) })),
    })),
  };
}

/** A dispute as the agent may see it: never the buyer, the seller, the messages or the evidence. */
function disputeView(dispute: unknown) {
  return {
    dispute_id: shaped(field(dispute, "dispute_id"), PAYPAL_ID),
    reason: shaped(field(dispute, "reason"), CODE),
    status: shaped(field(dispute, "status"), CODE),
    dispute_life_cycle_stage: shaped(field(dispute, "dispute_life_cycle_stage"), CODE),
    dispute_amount: money(field(dispute, "dispute_amount")),
    create_time: shaped(field(dispute, "create_time"), TIME),
    update_time: shaped(field(dispute, "update_time"), TIME),
    seller_response_due_date: shaped(field(dispute, "seller_response_due_date"), TIME),
  };
}

function productView(product: unknown) {
  return {
    id: shaped(field(product, "id"), PAYPAL_ID),
    name: prose(field(product, "name"), 127),
    description: prose(field(product, "description"), 256),
    type: shaped(field(product, "type"), CODE),
    category: shaped(field(product, "category"), CODE),
  };
}

export type PayPalView = Readonly<Record<string, unknown>>;

const VIEWS: Readonly<Record<ReadTool, (answer: unknown) => PayPalView>> = {
  get_order: orderView,
  list_disputes: (answer) => ({ disputes: list(field(answer, "items"), 20).map(disputeView) }),
  get_dispute: disputeView,
  show_product_details: productView,
};

/** Rebuild one tool's answer from its listed fields only. Exported for tests. */
export function viewOf(tool: ReadTool, answer: unknown): PayPalView {
  return VIEWS[tool](answer);
}

type StreamEvent = { readonly event: string; readonly data: string };

/**
 * work's outcome, or McpFailed("timeout") as soon as signal aborts, so a stream that never
 * sends cannot hold a call past its time limit whatever the fetch implementation does with
 * the signal. Shared with paypal-read.ts.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new McpFailed("timeout"));
    signal.addEventListener("abort", stop, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
    if (signal.aborted) stop();
  });
}

/** Server-sent events from one response body, under the byte cap, the event cap and the call's signal. */
class EventReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #signal: AbortSignal;
  readonly #decoder = new TextDecoder();
  readonly #ready: StreamEvent[] = [];
  #buffer = "";
  #bytes = 0;
  #events = 0;
  #type = "";
  #data: string[] = [];

  constructor(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
    this.#reader = body.getReader();
    this.#signal = signal;
  }

  async next(): Promise<StreamEvent> {
    for (;;) {
      const ready = this.#ready.shift();
      if (ready !== undefined) {
        this.#events += 1;
        if (this.#events > MAX_STREAM_EVENTS) throw new McpFailed("too_large");
        return ready;
      }
      const chunk = await untilAborted(this.#reader.read(), this.#signal);
      if (chunk.done) throw new McpFailed("protocol");
      this.#bytes += chunk.value.byteLength;
      if (this.#bytes > MAX_STREAM_BYTES) throw new McpFailed("too_large");
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
      this.#split();
    }
  }

  close(): void {
    this.#reader.cancel().catch(() => undefined);
  }

  #split(): void {
    for (;;) {
      const end = /\r\n|\r|\n/.exec(this.#buffer);
      if (end === null) return;
      // A lone CR at the end may be the first half of a CRLF still on its way.
      if (end[0] === "\r" && end.index === this.#buffer.length - 1) return;
      const line = this.#buffer.slice(0, end.index);
      this.#buffer = this.#buffer.slice(end.index + end[0].length);
      this.#line(line);
    }
  }

  #line(line: string): void {
    if (line === "") {
      if (this.#data.length > 0) this.#ready.push({ event: this.#type === "" ? "message" : this.#type, data: this.#data.join("\n") });
      this.#type = "";
      this.#data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (name === "event") this.#type = value;
    else if (name === "data") this.#data.push(value);
  }
}

const RPC_REPLY = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number() }).optional(),
});

const INITIALIZED = z.object({ protocolVersion: z.literal(PROTOCOL_VERSION) });

const TOOL_RESULT = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).max(16),
  isError: z.boolean().optional(),
});

async function replyTo(events: EventReader, id: number): Promise<unknown> {
  for (;;) {
    const event = await events.next();
    if (event.event !== "message") continue;
    let message: unknown;
    try {
      message = JSON.parse(event.data);
    } catch {
      throw new McpFailed("protocol");
    }
    // Requests and notifications from the server carry a method; an answer never does.
    if (field(message, "method") !== undefined) continue;
    const reply = RPC_REPLY.safeParse(message);
    if (!reply.success) throw new McpFailed("protocol");
    if (reply.data.id !== id) continue;
    if (reply.data.error !== undefined) throw new McpFailed("tool_error");
    if (reply.data.result === undefined) throw new McpFailed("protocol");
    return reply.data.result;
  }
}

/** The JSON PayPal returned inside a tools/call result, or McpFailed. */
function answerOf(result: unknown): unknown {
  const parsed = TOOL_RESULT.safeParse(result);
  if (!parsed.success) throw new McpFailed("protocol");
  if (parsed.data.isError === true) throw new McpFailed("tool_error");
  const texts = parsed.data.content.filter((part) => part.type === "text");
  if (texts.length !== 1 || texts[0].text === undefined) throw new McpFailed("protocol");
  let answer: unknown;
  try {
    answer = JSON.parse(texts[0].text);
  } catch {
    throw new McpFailed("protocol");
  }
  // PayPal's server wraps a REST error as {ok: false, status, code, message}; only the status is kept.
  if (field(answer, "ok") === false) {
    const status = field(answer, "status");
    if (field(answer, "code") === SETUP_ERROR_CODE) throw new McpFailed("server_setup", status);
    throw new McpFailed(status === 404 ? "not_found" : "paypal_error", status);
  }
  return answer;
}

async function converse(fetchFn: FetchFn, token: string, tool: ReadTool, input: unknown, signal: AbortSignal): Promise<unknown> {
  const authorization = `Bearer ${token}`;
  const opened = await fetchFn(mcpUrl(MCP_SSE_URL), {
    method: "GET",
    headers: { Accept: "text/event-stream", Authorization: authorization },
    redirect: "error",
    signal,
  });
  if (opened.status !== 200 || opened.body === null || !(opened.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
    await opened.body?.cancel().catch(() => undefined);
    throw new McpFailed(opened.status === 200 ? "protocol" : "paypal_error", opened.status);
  }
  const events = new EventReader(opened.body, signal);
  try {
    const first = await events.next();
    if (first.event !== "endpoint") throw new McpFailed("protocol");
    const endpoint = mcpUrl(first.data.trim());
    const post = async (message: Readonly<Record<string, unknown>>): Promise<void> => {
      const sent = await fetchFn(endpoint, {
        method: "POST",
        headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", Authorization: authorization },
        body: JSON.stringify(message),
        redirect: "error",
        signal,
      });
      await sent.body?.cancel().catch(() => undefined);
      if (sent.status < 200 || sent.status > 299) throw new McpFailed("paypal_error", sent.status);
    };
    await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "mend", version: "1.0.0" } } });
    if (!INITIALIZED.safeParse(await replyTo(events, 1)).success) throw new McpFailed("protocol");
    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: input } });
    return answerOf(await replyTo(events, 2));
  } finally {
    events.close();
  }
}

export type McpOptions = {
  /** Test seam; production leaves it unset and uses the global fetch at call time. */
  readonly fetch?: FetchFn;
  /** Production leaves it unset and uses the read-only app's sandbox keys, or the main app's when none are set. */
  readonly tokens?: TokenSource;
  readonly timeoutMs?: number;
  /** Ends the call early, for example when the agent's turn runs out of time. */
  readonly signal?: AbortSignal;
};

async function throughMcp(tool: ReadTool, input: unknown, tokens: TokenSource, fetchFn: FetchFn, limitMs: number, caller: AbortSignal | undefined): Promise<PayPalView> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limitMs);
  const signal = caller === undefined ? controller.signal : AbortSignal.any([controller.signal, caller]);
  let token: string | null = null;
  try {
    token = await untilAborted(tokens.get(), signal);
    return viewOf(tool, await converse(fetchFn, token, tool, input, signal));
  } catch (error) {
    if (error instanceof McpFailed && error.status === 401 && token !== null) tokens.drop(token);
    if (error instanceof McpFailed || error instanceof HostRefused) throw error;
    throw new McpFailed(signal.aborted || timedOut(error) ? "timeout" : "unreachable");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Call one of PayPal's four read tools through PayPal's sandbox MCP server, in a session
 * of its own, and return the answer rebuilt from that tool's listed fields, with via
 * "paypal_mcp". When the MCP read fails with server_setup, unreachable or protocol and at
 * least MIN_FALLBACK_MS of the call's time is left, logs one paypal_read_fallback line and
 * returns paypal-read.ts readDirect's answer for the same tool and input, with via
 * "paypal_rest", or its failure.
 *
 * Throws McpRefused when name is not one of the four or the arguments fail its strict
 * schema (nothing fetched, nothing sent); HostRefused when a URL, including the endpoint
 * the server names, is not on mcp.sandbox.paypal.com (nothing sent there, no fallback);
 * McpFailed on a timeout (15 s for the whole exchange, fallback included), a stream over
 * 1 MB or 200 events, PayPal's refusal or a tool error (none of these fall back), or a
 * fallback reason with too little time left to read directly.
 */
export async function callPayPalTool(name: string, args: unknown, options: McpOptions = {}): Promise<PayPalView> {
  if (!Object.hasOwn(READ_TOOL_INPUTS, name)) throw new McpRefused("not_allowed");
  const tool = name as ReadTool;
  const input = READ_TOOL_INPUTS[tool].safeParse(args);
  if (!input.success) throw new McpRefused("invalid_input");
  mcpUrl(MCP_SSE_URL);
  const tokens = options.tokens ?? defaultTokens();
  const fetchFn: FetchFn = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const limitMs = options.timeoutMs ?? MCP_CALL_TIMEOUT_MS;
  const startedAt = Date.now();
  let failed: McpFailed;
  try {
    return { ...(await throughMcp(tool, input.data, tokens, fetchFn, limitMs, options.signal)), via: "paypal_mcp" };
  } catch (error) {
    if (!(error instanceof McpFailed)) throw error;
    failed = error;
  }
  const leftMs = limitMs - (Date.now() - startedAt);
  if (!FALLBACK_REASONS.has(failed.reason) || leftMs < MIN_FALLBACK_MS) throw failed;
  writeLog({ kind: "paypal_read_fallback", tool, reason: failed.reason });
  // Loaded here, not at the top: paypal-read.ts builds on this module, so a static import both ways would be a cycle.
  const { readDirect } = await import("./paypal-read");
  return readDirect(tool, input.data, { tokens, fetch: fetchFn, signal: options.signal, timeoutMs: leftMs });
}
