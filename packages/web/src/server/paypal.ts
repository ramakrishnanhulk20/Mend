/**
 * The only door from the web app to PayPal's REST API.
 *
 * Every URL, including links PayPal hands back, goes through sandboxUrl() before
 * anything is sent, and the URL object that was checked is the object that is
 * fetched. Redirects are refused, so a reply cannot move a request to another host.
 * Errors carry the HTTP status, PayPal's error name and debug_id, never the client
 * secret, the token or an Authorization header.
 */
import { loadConfig, SANDBOX_API_HOST, type PayPalCredentials } from "./config";

export const PAYPAL_TIMEOUT_MS = 15_000;
export const TOKEN_REFRESH_MARGIN_MS = 60_000;
const MAX_RESPONSE_CHARS = 2_000_000;
const CALLER_FORBIDDEN_HEADERS = new Set(["authorization", "host"]);
const PRINTABLE_NO_SPACE = /^[\x21-\x7e]+$/;
const ERROR_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const DEBUG_ID = /^[A-Za-z0-9]{1,64}$/;

/** A request was aimed somewhere other than the PayPal sandbox API. Nothing was sent. */
export class HostRefused extends Error {
  constructor(reason: string) {
    super(`refused before sending: ${reason}`);
    this.name = "HostRefused";
  }
}

/** PayPal refused, or answered in a way we cannot use. Carries no secret. */
export class PayPalError extends Error {
  readonly status: number | null;
  readonly errorName: string | null;
  readonly debugId: string | null;

  constructor(status: number | null, errorName: string | null, debugId: string | null) {
    super(`PayPal error status=${status} name=${errorName} debug_id=${debugId}`);
    this.name = "PayPalError";
    this.status = status;
    this.errorName = errorName;
    this.debugId = debugId;
  }
}

/** Timeout or connection failure. The request may or may not have reached PayPal. */
export class PayPalUnreachable extends PayPalError {
  constructor(reason: "TIMEOUT" | "CONNECTION_ERROR") {
    super(null, reason, null);
    this.name = "PayPalUnreachable";
  }
}

export type PayPalInit = {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
};

export type PayPalReply = {
  readonly status: number;
  readonly body: unknown;
  readonly debugId: string | null;
};

export type FetchFn = (input: URL, init: RequestInit) => Promise<Response>;

/**
 * Resolve and check a path or URL, returning the parsed URL that may be fetched.
 *
 * A path starting with a single "/" is joined to https://api-m.sandbox.paypal.com.
 * The result must be https, its hostname must equal the sandbox host exactly (WHATWG
 * parser, no suffix or pattern match), with no userinfo and no port but 443. Throws
 * HostRefused otherwise. Covers lookalike and suffix hosts, userinfo tricks, plain
 * http, other ports and hosts hidden in the query or fragment. Does not cover DNS or
 * TLS attacks on the real host; Node's TLS certificate check covers that.
 */
export function sandboxUrl(pathOrUrl: string): URL {
  if (typeof pathOrUrl !== "string" || pathOrUrl === "") {
    throw new HostRefused("empty URL");
  }
  // The URL parser silently drops tabs and newlines and trims spaces, so a URL could
  // read one way to a person and another way to the parser.
  if (!PRINTABLE_NO_SPACE.test(pathOrUrl)) {
    throw new HostRefused("URL contains spaces, control or non-ASCII characters");
  }
  const absolute =
    pathOrUrl.startsWith("/") && !pathOrUrl.startsWith("//")
      ? `https://${SANDBOX_API_HOST}${pathOrUrl}`
      : pathOrUrl;
  let url: URL;
  try {
    url = new URL(absolute);
  } catch {
    throw new HostRefused("URL could not be parsed");
  }
  if (url.protocol !== "https:") {
    throw new HostRefused("only https is allowed");
  }
  if (url.hostname !== SANDBOX_API_HOST) {
    throw new HostRefused("host is not the PayPal sandbox API");
  }
  if (url.username !== "" || url.password !== "") {
    throw new HostRefused("URL carries userinfo");
  }
  if (url.port !== "") {
    throw new HostRefused("unexpected port");
  }
  return url;
}

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
}

function cleaned(value: unknown, shape: RegExp): string | null {
  return typeof value === "string" && shape.test(value) ? value : null;
}

function errorNameOf(body: unknown): string | null {
  return cleaned(field(body, "name"), ERROR_NAME) ?? cleaned(field(body, "error"), ERROR_NAME);
}

function timedOut(error: unknown): boolean {
  const name = field(error, "name");
  return name === "TimeoutError" || name === "AbortError";
}

export type PayPalClientOptions = {
  /** Test seam; production leaves it unset and uses the global fetch at call time. */
  readonly fetch?: FetchFn;
  readonly now?: () => number;
  readonly timeoutMs?: number;
};

/** Authenticated JSON client for the PayPal sandbox REST API, with a cached token. */
export class PayPalClient {
  readonly #credentials: PayPalCredentials;
  readonly #fetch: FetchFn | undefined;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  #token: { readonly value: string; readonly usableUntil: number } | null = null;
  #pendingToken: Promise<string> | null = null;
  #requestsSent = 0;

  constructor(credentials: PayPalCredentials, options: PayPalClientOptions = {}) {
    this.#credentials = credentials;
    this.#fetch = options.fetch;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? PAYPAL_TIMEOUT_MS;
  }

  /** How many HTTP requests this client has handed to fetch, token calls included. */
  get requestsSent(): number {
    return this.#requestsSent;
  }

  /**
   * Send one authenticated request and return PayPal's answer, whatever its status.
   *
   * Throws HostRefused before sending if path is not on the sandbox host, TypeError if
   * the caller sets Authorization or Host, PayPalUnreachable on timeout (15 s for the
   * whole exchange) or connection failure, and PayPalError if no token can be had.
   */
  async request(path: string, init: PayPalInit = {}): Promise<PayPalReply> {
    const url = sandboxUrl(path);
    const extra = init.headers ?? {};
    if (Object.keys(extra).some((key) => CALLER_FORBIDDEN_HEADERS.has(key.toLowerCase()))) {
      throw new TypeError("callers may not set Authorization or Host");
    }
    const token = await this.#bearer();
    const reply = await this.#send(url, {
      method: init.method ?? "GET",
      headers: { Accept: "application/json", ...extra, Authorization: `Bearer ${token}` },
      body: init.body,
    });
    if (reply.status === 401 && this.#token?.value === token) {
      // PayPal no longer accepts this token, so the next call fetches a fresh one.
      this.#token = null;
    }
    return reply;
  }

  async #bearer(): Promise<string> {
    if (this.#token !== null && this.#now() < this.#token.usableUntil) {
      return this.#token.value;
    }
    this.#token = null;
    // Concurrent callers share one token request instead of each minting their own.
    this.#pendingToken ??= this.#fetchToken().finally(() => {
      this.#pendingToken = null;
    });
    return this.#pendingToken;
  }

  async #fetchToken(): Promise<string> {
    const startedAt = this.#now();
    const basic = Buffer.from(`${this.#credentials.clientId}:${this.#credentials.clientSecret}`).toString("base64");
    const reply = await this.#send(sandboxUrl("/v1/oauth2/token"), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body: "grant_type=client_credentials",
    });
    const token = field(reply.body, "access_token");
    const expiresIn = field(reply.body, "expires_in");
    if (reply.status !== 200 || typeof token !== "string" || token === "") {
      throw new PayPalError(reply.status, errorNameOf(reply.body), reply.debugId);
    }
    if (typeof expiresIn !== "number" || !Number.isInteger(expiresIn) || expiresIn <= 0) {
      throw new PayPalError(reply.status, "TOKEN_WITHOUT_EXPIRY", reply.debugId);
    }
    // Measured from before the request, so the cached token never outlives PayPal's clock.
    this.#token = { value: token, usableUntil: startedAt + expiresIn * 1000 - TOKEN_REFRESH_MARGIN_MS };
    return token;
  }

  async #send(url: URL, init: RequestInit): Promise<PayPalReply> {
    const fetchFn: FetchFn = this.#fetch ?? ((input, options) => globalThis.fetch(input, options));
    this.#requestsSent += 1;
    let response: Response;
    let text: string;
    try {
      // One signal covers the headers and the body, so the whole exchange is capped.
      response = await fetchFn(url, { ...init, redirect: "error", signal: AbortSignal.timeout(this.#timeoutMs) });
      text = await response.text();
    } catch (error) {
      throw new PayPalUnreachable(timedOut(error) ? "TIMEOUT" : "CONNECTION_ERROR");
    }
    const headerDebugId = cleaned(response.headers.get("paypal-debug-id"), DEBUG_ID);
    if (text.length > MAX_RESPONSE_CHARS) {
      throw new PayPalError(response.status, "RESPONSE_TOO_LARGE", headerDebugId);
    }
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body, debugId: headerDebugId ?? cleaned(field(body, "debug_id"), DEBUG_ID) };
  }
}

let defaultClient: PayPalClient | undefined;

/**
 * Send one request to the PayPal sandbox with the app's own credentials.
 *
 * The URL is checked before config is read or a token is fetched, so a request built
 * for any other host is refused with HostRefused and nothing leaves the process.
 * Other behaviour as PayPalClient.request.
 */
export async function paypalFetch(path: string, init: PayPalInit = {}): Promise<PayPalReply> {
  sandboxUrl(path);
  defaultClient ??= new PayPalClient(loadConfig().paypal);
  return defaultClient.request(path, init);
}
