/**
 * The agent's four PayPal reads straight from PayPal's sandbox REST API. callPayPalTool
 * uses this only when PayPal's hosted MCP server fails in its own setup, cannot be reached
 * or breaks the protocol, so the agent keeps answering while that server is down. Same four
 * tools, same strict inputs, same rebuilt answers as the MCP path (C1, C15, C16, C17).
 *
 * The URL is built from a fixed path per tool with every id encoded, and goes through
 * paypal.ts's sandboxUrl, so only api-m.sandbox.paypal.com is ever fetched. The request
 * carries Accept and the Bearer token and nothing else. Redirects are not followed: any
 * 3xx is a failure, so an answer cannot send the token anywhere. At most 1 MB of body is
 * read, inside the time the caller gives. A 200 answer is rebuilt by paypal-mcp.ts's
 * viewOf from that tool's listed fields, so emails, identity and control characters are
 * stripped exactly as on the MCP path, and the view says via "paypal_rest".
 *
 * Does not cover: what the token itself may do at PayPal (the read-only app has no
 * Payouts, but keeps refund and checkout scopes; the four-tool list in paypal-mcp.ts is the
 * control for those), or DNS and TLS attacks on the real host.
 */
import type { z } from "zod";
import { MAX_STREAM_BYTES, McpFailed, McpRefused, READ_TOOL_INPUTS, untilAborted, viewOf, type PayPalView, type ReadTool, type TokenSource } from "./paypal-mcp";
import { HostRefused, sandboxUrl, type FetchFn } from "./paypal";

type ReadInput = { readonly [T in ReadTool]: z.infer<(typeof READ_TOOL_INPUTS)[T]> };
type DirectPaths = { readonly [T in ReadTool]: (input: ReadInput[T]) => string };

const PATHS: DirectPaths = {
  get_order: ({ id }) => `/v2/checkout/orders/${encodeURIComponent(id)}`,
  list_disputes: ({ dispute_state }) => `/v1/customer/disputes?page_size=20${dispute_state === undefined ? "" : `&dispute_state=${encodeURIComponent(dispute_state)}`}`,
  get_dispute: ({ dispute_id }) => `/v1/customer/disputes/${encodeURIComponent(dispute_id)}`,
  show_product_details: ({ product_id }) => `/v1/catalogs/products/${encodeURIComponent(product_id)}`,
};

/** PayPal's REST path for each read tool. list_disputes asks for 20, the most the view keeps. */
export const DIRECT_PATHS: DirectPaths = Object.freeze(PATHS);

export type DirectReadOptions = {
  readonly tokens: TokenSource;
  /** Test seam; production leaves it unset and uses the global fetch at call time. */
  readonly fetch?: FetchFn;
  /** Ends the read early, for example when the agent's turn runs out of time. */
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
};

function timedOut(error: unknown): boolean {
  const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === "TimeoutError" || name === "AbortError";
}

function pathFor<T extends ReadTool>(tool: T, input: unknown): string {
  const parsed = READ_TOOL_INPUTS[tool].safeParse(input);
  if (!parsed.success) throw new McpRefused("invalid_input");
  return DIRECT_PATHS[tool](parsed.data as ReadInput[T]);
}

async function cappedText(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<string> {
  if (body === null) return "";
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await untilAborted(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) throw new McpFailed("too_large");
      parts.push(chunk.value);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
  } catch {
    throw new McpFailed("protocol");
  }
}

/**
 * Read one of the four tools' answers from PayPal's sandbox REST API and return it rebuilt
 * from that tool's listed fields, with via "paypal_rest".
 *
 * Throws McpRefused before a token is fetched or anything is sent when tool is not one of
 * the four or input fails its strict schema. Throws McpFailed with the status only, never
 * PayPal's text or the token: not_found on 404; paypal_error on 401 (after dropping the
 * token), on any 3xx (not followed) and on every other status but 200; too_large past
 * 1 MB of body; protocol for a body that is not UTF-8 JSON; timeout when timeoutMs passes
 * or signal aborts; unreachable on a connection failure.
 */
export async function readDirect(tool: ReadTool, input: unknown, options: DirectReadOptions): Promise<PayPalView> {
  if (!Object.hasOwn(READ_TOOL_INPUTS, tool)) throw new McpRefused("not_allowed");
  const url = sandboxUrl(pathFor(tool, input));
  const fetchFn: FetchFn = options.fetch ?? ((target, init) => globalThis.fetch(target, init));
  const limit = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal === undefined ? limit : AbortSignal.any([limit, options.signal]);
  try {
    const token = await untilAborted(options.tokens.get(), signal);
    const response = await untilAborted(
      fetchFn(url, { method: "GET", headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, redirect: "manual", signal }),
      signal,
    );
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401) options.tokens.drop(token);
      throw new McpFailed(response.status === 404 ? "not_found" : "paypal_error", response.status);
    }
    const text = await cappedText(response.body, signal);
    let answer: unknown;
    try {
      answer = JSON.parse(text);
    } catch {
      throw new McpFailed("protocol");
    }
    return { ...viewOf(tool, answer), via: "paypal_rest" };
  } catch (error) {
    if (error instanceof McpFailed || error instanceof HostRefused) throw error;
    throw new McpFailed(signal.aborted || timedOut(error) ? "timeout" : "unreachable");
  }
}
