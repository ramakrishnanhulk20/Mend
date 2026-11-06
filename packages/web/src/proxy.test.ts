// Covers the exact policy buildCsp writes, the fresh nonce proxy() puts on the answer and on the
// forwarded request, and which addresses the matcher lets through, read through Next's own
// matcher helper. Does NOT cover: a browser enforcing the policy, or Next stamping the nonce on
// every script. Those need a real build and browser, so they are proven by loading served pages.
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCsp, config, proxy } from "./proxy";

const NONCE = "AAAAAAAAAAAAAAAAAAAAAA==";
const PRODUCTION =
  `default-src 'self'; script-src 'self' 'nonce-${NONCE}'; style-src 'self' 'unsafe-inline'; ` +
  "img-src 'self' data:; media-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; " +
  "base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

function directive(policy: string, name: string): string {
  return policy.split("; ").find((part) => part.startsWith(`${name} `)) ?? "";
}

function nonceOf(policy: string | null): string {
  const match = /'nonce-([A-Za-z0-9+/]+={0,2})'/.exec(policy ?? "");
  if (match === null) throw new Error(`no nonce in ${policy}`);
  return match[1];
}

function answerTo(path: string) {
  return proxy(new NextRequest(`http://localhost${path}`));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildCsp", () => {
  it("writes the production policy exactly", () => {
    expect(buildCsp(NONCE, false)).toBe(PRODUCTION);
  });

  it("never allows eval or inline script in production, and keeps script-src to the origin and the nonce", () => {
    const policy = buildCsp(NONCE, false);
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toContain("strict-dynamic");
    expect(directive(policy, "script-src")).toBe(`script-src 'self' 'nonce-${NONCE}'`);
  });

  it("adds only unsafe-eval and ws: in development", () => {
    const policy = buildCsp(NONCE, true);
    expect(directive(policy, "script-src")).toBe(`script-src 'self' 'nonce-${NONCE}' 'unsafe-eval'`);
    expect(directive(policy, "connect-src")).toBe("connect-src 'self' ws:");
    expect(policy.replace(" 'unsafe-eval'", "").replace(" ws:", "")).toBe(PRODUCTION);
  });
});

describe("proxy", () => {
  it("gives two requests different nonces of at least 128 bits", () => {
    const first = nonceOf(answerTo("/").headers.get("content-security-policy"));
    const second = nonceOf(answerTo("/").headers.get("content-security-policy"));
    expect(first).not.toBe(second);
    expect(Buffer.from(first, "base64").length).toBeGreaterThanOrEqual(16);
  });

  it("sends the policy on the answer and forwards the same one for Next to read the nonce from", () => {
    const response = answerTo("/demo");
    const sent = response.headers.get("content-security-policy");
    expect(sent).not.toBeNull();
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(sent);
  });

  it("sends the production policy under a production build, even with no dev flag anywhere", () => {
    vi.stubEnv("NODE_ENV", "production");
    const sent = answerTo("/").headers.get("content-security-policy") ?? "";
    expect(sent).toBe(buildCsp(nonceOf(sent), false));
  });

  it("sends the dev extras only when NODE_ENV is development", () => {
    vi.stubEnv("NODE_ENV", "development");
    const sent = answerTo("/").headers.get("content-security-policy") ?? "";
    expect(sent).toBe(buildCsp(nonceOf(sent), true));
  });
});

describe("the proxy matcher", () => {
  const runsOn = (url: string, headers?: Record<string, string>) => unstable_doesMiddlewareMatch({ config, url, headers });

  it("runs on every page and on an unknown address", () => {
    for (const url of ["/", "/demo", "/docs", "/docs/developers/architecture", "/join/done", "/join/done?result=joined.x", "/no-such-page"]) {
      expect(runsOn(url), url).toBe(true);
    }
  });

  it("does not skip by file extension", () => {
    for (const url of ["/no-such.page", "/docs/no-such.page", "/join/done.html", "/docs/film.mp4"]) {
      expect(runsOn(url), url).toBe(true);
    }
  });

  it("runs on an address that only looks like a skipped one", () => {
    for (const url of ["/apiary", "/worldly", "/_nextish", "/docs/api", "/docs/world/how-1.jpg", "/docs/icon.svg", "/icon.svg.bak", "/robots.txt.html"]) {
      expect(runsOn(url), url).toBe(true);
    }
  });

  it("skips the API routes", () => {
    for (const url of ["/api", "/api/join/paypal/start?intent=join", "/api/webhooks/paypal", "/api/search"]) {
      expect(runsOn(url), url).toBe(false);
    }
  });

  it("skips everything under /_next", () => {
    for (const url of ["/_next", "/_next/static/chunks/main.js", "/_next/static/media/font.woff2", "/_next/image?url=%2Fworld%2Fhow-1.jpg&w=640&q=75"]) {
      expect(runsOn(url), url).toBe(false);
    }
  });

  it("skips everything under /world", () => {
    for (const url of ["/world", "/world/film/loop.mp4", "/world/film/first-phone.jpg", "/world/how-1.jpg", "/world/icons/plan.webp"]) {
      expect(runsOn(url), url).toBe(false);
    }
  });

  it("skips the four named root files", () => {
    for (const url of ["/icon.svg", "/favicon.ico", "/robots.txt", "/sitemap.xml"]) {
      expect(runsOn(url), url).toBe(false);
    }
  });

  it("skips prefetches", () => {
    expect(runsOn("/demo", { "next-router-prefetch": "1" })).toBe(false);
    expect(runsOn("/demo", { purpose: "prefetch" })).toBe(false);
    expect(runsOn("/demo", { purpose: "other" })).toBe(true);
  });
});
