// Covers the local webhook signature check: the exact certificate address rule, the
// download limits (redirects refused, timeout, size caps), the chain built from the
// served PEM, the bundled intermediates and DigiCert's CA Issuers host, each chain rule
// with a passing and a failing certificate, the signed text, the caches, and the download
// budget: each client address's share, the process cap, and known-good addresses, kept
// across a restart, skipping both. Certificates come from a throwaway chain built at load
// time (__fixtures__/test-chain.ts) trusted through the injectable anchor list, plus
// PayPal's real sandbox leaf checked against Node's real roots and the bundled
// intermediate at a fixed time. The paypal_certs table is stood in for by a list in
// memory. Does NOT cover: the real table (webhooks.test.ts runs it), a real PayPal
// signature over a real body (the live proof, render.mjs prove "delivery", does),
// revocation, which is not checked, or DigiCert's real host, which is never contacted.
import { readFileSync } from "node:fs";
import { sign, X509Certificate } from "node:crypto";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issue, rsaKeys, testChain, type Issued } from "./__fixtures__/test-chain";
import {
  certificateUrl,
  issuerUrl,
  MAX_CERT_BYTES,
  MAX_ISSUER_BYTES,
  SignatureChecker,
  signedText,
  type SignatureOptions,
  type SignedHeaders,
  type VerifiedCertificates,
} from "./webhook-signature";

const WEBHOOK_ID = "TESTWEBHOOK1";
const SENDER = "198.51.100.8";
const CERT_URL = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test-0001";
const LIVE_CERT_URL = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-bf9ab596";
const ISSUER_URL = "http://cacerts.digicert.com/MendTestIntermediate.crt";
const LIVE_LEAF = readFileSync(new URL("./__fixtures__/paypal-sandbox-leaf.pem", import.meta.url), "latin1");
const INSIDE_LIVE_LEAF = Date.UTC(2026, 6, 1);
const chain = testChain();

type Served = () => Response | Promise<Response>;
const net = {
  served: new Map<string, Served>(),
  requests: [] as { url: string; init: RequestInit }[],
};

async function fakeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  net.requests.push({ url, init });
  const served = net.served.get(url);
  return served === undefined ? new Response("not found", { status: 404 }) : served();
}

function serve(url: string, ...certs: Issued[]): void {
  net.served.set(url, () => new Response(certs.map((cert) => cert.pem).join(""), { headers: { "content-type": "application/x-pem-file" } }));
}

// A client address of its own for each index, for tests that fill the process cap rather
// than one address's share.
function sender(index: number): string {
  return `203.0.113.${index + 1}`;
}

// The paypal_certs table as a list, and how often the checker asked for it.
function memory(urls: readonly string[] = []) {
  const kept = { urls: [...urls], recalls: 0 };
  const certificates: VerifiedCertificates = {
    async recall() {
      kept.recalls += 1;
      return [...kept.urls];
    },
    async record(href) {
      if (!kept.urls.includes(href)) kept.urls.push(href);
    },
  };
  return { kept, certificates };
}

function checker(options: SignatureOptions = {}): SignatureChecker {
  return new SignatureChecker({ anchors: [chain.root.pem], intermediates: [chain.intermediate.pem], certificates: memory().certificates, ...options });
}

// PayPal's real chain: Node's own roots and the bundled intermediate.
function realChecker(now: number, options: SignatureOptions = {}): SignatureChecker {
  return new SignatureChecker({ now: () => now, certificates: memory().certificates, ...options });
}

function headersFor(body: string, overrides: Partial<SignedHeaders> = {}, webhookId = WEBHOOK_ID): SignedHeaders {
  const base = {
    auth_algo: "SHA256withRSA",
    cert_url: CERT_URL,
    transmission_id: "6f1c1d3e-2b9a-4f0e-9a51-3c1d2e4f5a6b",
    transmission_time: "2026-10-26T12:00:00Z",
    ...overrides,
  };
  const text = `${base.transmission_id}|${base.transmission_time}|${webhookId}|${crc32(Buffer.from(body, "utf8"))}`;
  return { transmission_sig: sign("sha256", Buffer.from(text), chain.leafKeys.privateKey).toString("base64"), ...base };
}

const BODY = '{"id":"WH-1","event_type":"PAYMENT.PAYOUTS-ITEM.SUCCEEDED"}';

beforeEach(() => {
  net.served = new Map();
  net.requests = [];
  vi.stubGlobal("fetch", fakeFetch);
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the certificate address", () => {
  it("is used as one WHATWG parse gives it: https, api.sandbox.paypal.com, default port, the certs path", () => {
    expect(certificateUrl(CERT_URL)?.href).toBe(CERT_URL);
    expect(certificateUrl("https://API.Sandbox.PayPal.com:443/v1/notifications/certs/CERT-test-0001")?.href).toBe(CERT_URL);
  });

  it("is exactly PayPal's certificate path then CERT- and 1 to 100 letters, digits or hyphens", () => {
    expect(certificateUrl(LIVE_CERT_URL)?.href).toBe(LIVE_CERT_URL);
    const longest = `https://api.sandbox.paypal.com/v1/notifications/certs/CERT-${"a1-".repeat(33)}Z`;
    expect(certificateUrl(longest)?.href).toBe(longest);
  });

  it.each([
    `${CERT_URL}?n=1`,
    `${CERT_URL}?`,
    `${CERT_URL}#n`,
    `${CERT_URL}#`,
    "https://api.sandbox.paypal.com/v1/notifications/certs/",
    "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-",
    `https://api.sandbox.paypal.com/v1/notifications/certs/CERT-${"a".repeat(101)}`,
    "https://api.sandbox.paypal.com/v1/notifications/certs/cert-1",
    "https://api.sandbox.paypal.com/v1/notifications/certs/other-1",
    "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1/more",
    "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1.pem",
    "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-a_b",
    "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-%41",
  ])("refuses %s, which is not exactly a certificate id on PayPal's path", (text) => {
    expect(certificateUrl(text)).toBeNull();
  });

  it.each([
    "http://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "https://api.paypal.com/v1/notifications/certs/CERT-1",
    "https://api.sandbox.paypal.com.evil.example/v1/notifications/certs/CERT-1",
    "https://api.sandbox.paypal.com./v1/notifications/certs/CERT-1",
    "https://api.sandbox.paypal.com:8443/v1/notifications/certs/CERT-1",
    "https://user@api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "https://api.sandbox.paypal.com@evil.example/v1/notifications/certs/CERT-1",
    "https://api.sandbox.paypal.com/v1/oauth2/token",
    "https://api.sandbox.paypal.com/v1/notifications/certs/../../oauth2/token",
    "https://api.sandbox.paypal.com/v1/notifications/certs/%2e%2e/%2e%2e/oauth2/token",
    "not a url",
  ])("refuses %s", (text) => {
    expect(certificateUrl(text)).toBeNull();
  });

  it("allows a CA Issuers address only on cacerts.digicert.com, over http or https, on the default port", () => {
    expect(issuerUrl("http://cacerts.digicert.com/DigiCertEVRSACAG2.crt")?.href).toBe("http://cacerts.digicert.com/DigiCertEVRSACAG2.crt");
    expect(issuerUrl("https://cacerts.digicert.com/x.crt")).not.toBeNull();
    for (const text of ["http://cacerts.digicert.com.evil.example/x.crt", "http://evil.example/x.crt", "http://cacerts.digicert.com:8080/x.crt", "http://u@cacerts.digicert.com/x.crt", "ftp://cacerts.digicert.com/x.crt"]) {
      expect(issuerUrl(text), text).toBeNull();
    }
  });
});

describe("the signed text", () => {
  it("is transmission id, time and our webhook id with the CRC-32 of the raw body as an unsigned decimal", () => {
    const headers = { ...headersFor("a"), transmission_id: "T1", transmission_time: "2026-10-26T12:00:00Z" };
    expect(signedText(headers, "a", "WH9")).toBe("T1|2026-10-26T12:00:00Z|WH9|3904355907");
    expect(signedText(headers, "hello", "WH9")).toBe("T1|2026-10-26T12:00:00Z|WH9|907060870");
  });
});

describe("check", () => {
  it("passes a genuine delivery with one certificate download, redirects refused and a timeout set", async () => {
    serve(CERT_URL, chain.leaf);
    expect(await checker().check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: true });
    expect(net.requests.map((request) => request.url)).toEqual([CERT_URL]);
    expect(net.requests[0].init.redirect).toBe("error");
    expect(net.requests[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["an altered body", (headers: SignedHeaders) => ({ headers, body: `${BODY} ` })],
    ["another transmission time", (headers: SignedHeaders) => ({ headers: { ...headers, transmission_time: "2026-10-26T12:00:01Z" }, body: BODY })],
    ["another transmission id", (headers: SignedHeaders) => ({ headers: { ...headers, transmission_id: "another-id" }, body: BODY })],
    ["a signature that is not base64 of anything signed", (headers: SignedHeaders) => ({ headers: { ...headers, transmission_sig: "AAAA" }, body: BODY })],
  ])("refuses %s as a bad signature", async (_label, change) => {
    serve(CERT_URL, chain.leaf);
    const { headers, body } = change(headersFor(BODY));
    expect(await checker().check(headers, body, WEBHOOK_ID, SENDER)).toEqual({ ok: false, problem: "signature" });
  });

  it("refuses a delivery signed over any webhook id but ours", async () => {
    serve(CERT_URL, chain.leaf);
    expect(await checker().check(headersFor(BODY, {}, "ATTACKERWEBHOOK"), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: false, problem: "signature" });
  });

  it("refuses another algorithm or a certificate address off PayPal's path without any download", async () => {
    serve(CERT_URL, chain.leaf);
    expect(await checker().check(headersFor(BODY, { auth_algo: "SHA1withRSA" }), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: false, problem: "auth_algo" });
    expect(await checker().check(headersFor(BODY, { cert_url: "https://evil.example/cert.pem" }), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: false, problem: "cert_url" });
    expect(net.requests).toEqual([]);
  });

  it("refuses PayPal's own certificate address with a query or fragment before any cache, record or download", async () => {
    const { kept, certificates } = memory([CERT_URL]);
    serve(CERT_URL, chain.leaf);
    const signatures = checker({ certificates });
    expect(await signatures.check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: true });
    for (const cert_url of [`${CERT_URL}?n=1`, `${CERT_URL}#n`]) {
      expect(await signatures.check(headersFor(BODY, { cert_url }), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: false, problem: "cert_url" });
    }
    expect(net.requests.map((request) => request.url)).toEqual([CERT_URL]);
    expect(kept.recalls).toBe(1);
  });
});

describe("the chain", () => {
  async function verdictFor(served: Issued[], options: SignatureOptions = {}) {
    serve(CERT_URL, ...served);
    return checker(options).check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER);
  }

  it("passes when the served PEM carries the intermediate itself, each certificate signed by the next", async () => {
    expect(await verdictFor([chain.leaf, chain.intermediate], { intermediates: [] })).toEqual({ ok: true });
    expect(await verdictFor([chain.leaf, chain.intermediate, chain.root], { intermediates: [] })).toEqual({ ok: true });
  });

  it("refuses a leaf whose signature does not check against the intermediate it names, bundled or served next to it", async () => {
    expect(await verdictFor([chain.badSignature])).toEqual({ ok: false, problem: "cert_chain" });
    expect(await verdictFor([chain.badSignature, chain.intermediate], { intermediates: [] })).toEqual({ ok: false, problem: "cert_chain" });
  });

  it("refuses a chain that ends at a root that is not an anchor", async () => {
    expect(await verdictFor([chain.leaf], { anchors: [chain.stranger.pem] })).toEqual({ ok: false, problem: "cert_chain" });
  });

  it("refuses an unknown issuer whose CA Issuers address is not DigiCert's, without fetching it", async () => {
    expect(await verdictFor([chain.unknownIssuer])).toEqual({ ok: false, problem: "cert_chain" });
    expect(net.requests.map((request) => request.url)).toEqual([CERT_URL]);
  });

  it("refuses an issuer that is not a CA", async () => {
    expect(chain.underNotCa.cert.verify(chain.notCa.keys.publicKey)).toBe(true);
    expect(await verdictFor([chain.underNotCa, chain.notCa])).toEqual({ ok: false, problem: "cert_chain" });
  });

  it("refuses a leaf that is a CA", async () => {
    expect(await verdictFor([chain.caLeaf])).toEqual({ ok: false, problem: "cert_chain" });
  });

  it.each([
    ["expired", () => chain.expired],
    ["not yet valid", () => chain.notYetValid],
  ])("refuses a leaf that is %s", async (_label, leaf) => {
    expect(await verdictFor([leaf()])).toEqual({ ok: false, problem: "cert_chain" });
  });

  it("refuses an intermediate outside its dates, and passes the same chain inside them", async () => {
    const lapsed = issue({ commonName: "Mend Test Intermediate", keys: chain.intermediate.keys, issuer: chain.root, ca: true, notAfter: new Date(Date.UTC(2021, 0, 1)) });
    expect(await verdictFor([chain.leaf], { intermediates: [lapsed.pem] })).toEqual({ ok: false, problem: "cert_chain" });
    expect(await verdictFor([chain.leaf], { intermediates: [lapsed.pem], now: () => Date.UTC(2020, 6, 1) })).toEqual({ ok: true });
  });

  it.each([
    ["the live signing name", () => chain.liveName],
    ["a name that only starts with the sandbox one", () => chain.lookalikeName],
  ])("refuses a leaf with %s", async (_label, leaf) => {
    expect(await verdictFor([leaf()])).toEqual({ ok: false, problem: "cert_chain" });
  });

  it("refuses a served body that is not only PEM certificates", async () => {
    net.served.set(CERT_URL, () => new Response(`${chain.leaf.pem}\nsomething else\n`));
    expect(await checker().check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: false, problem: "cert_chain" });
  });

  it("adds at most two issuers to the served PEM", async () => {
    const keys = [rsaKeys(), rsaKeys(), rsaKeys()];
    const first = issue({ commonName: "Mend Test Level 1", keys: keys[0], issuer: chain.root, ca: true });
    const second = issue({ commonName: "Mend Test Level 2", keys: keys[1], issuer: first, ca: true });
    const third = issue({ commonName: "Mend Test Level 3", keys: keys[2], issuer: second, ca: true });
    const deep = issue({ commonName: chain.leaf.commonName, keys: chain.leafKeys, issuer: third, ca: false });
    const bundle = [first.pem, second.pem, third.pem];
    expect(await verdictFor([deep], { intermediates: bundle })).toEqual({ ok: false, problem: "cert_chain" });
    expect(await verdictFor([deep, third], { intermediates: bundle })).toEqual({ ok: true });
  });
});

describe("filling an issuer from DigiCert's CA Issuers address", () => {
  it("downloads it once as DER, checks it to an anchor, and keeps it for 24 hours", async () => {
    let now = Date.UTC(2026, 9, 26);
    const leaf = chain.leafWithIssuerUrl(ISSUER_URL);
    const signatures = checker({ intermediates: [], now: () => now });
    net.served.set(ISSUER_URL, () => new Response(new Uint8Array(chain.intermediate.der)));
    serve(CERT_URL, leaf);
    serve(`${CERT_URL}-again`, leaf);
    serve(`${CERT_URL}-later`, leaf);
    expect(await signatures.check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: true });
    // Another sender: the first delivery spent SENDER's share of 2 on the leaf and its issuer.
    expect(await signatures.check(headersFor(BODY, { cert_url: `${CERT_URL}-again` }), BODY, WEBHOOK_ID, sender(1))).toEqual({ ok: true });
    expect(net.requests.filter((request) => request.url === ISSUER_URL)).toHaveLength(1);
    expect(net.requests.find((request) => request.url === ISSUER_URL)?.init.redirect).toBe("error");
    now += 24 * 60 * 60 * 1000;
    expect(await signatures.check(headersFor(BODY, { cert_url: `${CERT_URL}-later` }), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: true });
    expect(net.requests.filter((request) => request.url === ISSUER_URL)).toHaveLength(2);
  });

  it("takes it as PEM too", async () => {
    net.served.set(ISSUER_URL, () => new Response(chain.intermediate.pem));
    serve(CERT_URL, chain.leafWithIssuerUrl(ISSUER_URL));
    expect(await checker({ intermediates: [] }).check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: true });
  });

  it("refuses an issuer over 16 KB, or one DigiCert's host does not serve", async () => {
    net.served.set(ISSUER_URL, () => new Response(new Uint8Array(Buffer.concat([chain.intermediate.der, Buffer.alloc(MAX_ISSUER_BYTES)]))));
    serve(CERT_URL, chain.leafWithIssuerUrl(ISSUER_URL));
    expect(await checker({ intermediates: [] }).check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: false, problem: "cert_chain" });
    net.served.delete(ISSUER_URL);
    expect(await checker({ intermediates: [] }).check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: false, problem: "cert_chain" });
  });

  it("keeps a downloaded issuer only once it has checked that the issuer signs the certificate below it", async () => {
    const leaf = chain.leafWithIssuerUrl(ISSUER_URL);
    serve(CERT_URL, leaf);
    serve(`${CERT_URL}-again`, leaf);
    const signatures = checker({ intermediates: [] });
    net.served.set(ISSUER_URL, () => new Response(new Uint8Array(chain.stranger.der)));
    expect(await signatures.check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: false, problem: "cert_chain" });
    net.served.set(ISSUER_URL, () => new Response(new Uint8Array(chain.intermediate.der)));
    expect(await signatures.check(headersFor(BODY, { cert_url: `${CERT_URL}-again` }), BODY, WEBHOOK_ID, sender(1))).toEqual({ ok: true });
    expect(net.requests.filter((request) => request.url === ISSUER_URL)).toHaveLength(2);
  });

  it("does not download what the bundle already holds", async () => {
    serve(CERT_URL, chain.leafWithIssuerUrl(ISSUER_URL));
    expect(await checker().check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: true });
    expect(net.requests.map((request) => request.url)).toEqual([CERT_URL]);
  });
});

describe("downloading the certificate", () => {
  it.each([
    ["a non-200 answer", () => new Response("gateway", { status: 502 })],
    ["a declared length over 64 KB", () => new Response(chain.leaf.pem, { headers: { "content-length": String(MAX_CERT_BYTES + 1) } })],
    ["a redirect, which fetch refuses", () => Promise.reject(new TypeError("fetch failed: redirect mode is set to error"))],
  ])("refuses %s", async (_label, answer) => {
    net.served.set(CERT_URL, answer);
    expect(await checker().check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: false, problem: "cert_fetch" });
  });

  it("stops reading a body with no length once it passes 64 KB", async () => {
    let given = 0;
    net.served.set(CERT_URL, () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          given += 16 * 1024;
          controller.enqueue(new Uint8Array(16 * 1024).fill(0x41));
        },
      }, { highWaterMark: 0 });
      return new Response(stream);
    });
    expect(await checker().check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: false, problem: "cert_fetch" });
    expect(given).toBeLessThanOrEqual(MAX_CERT_BYTES + 16 * 1024);
  });

  it("gives up when the answer does not come in time", async () => {
    const slow = vi.fn((input: string, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    );
    vi.stubGlobal("fetch", slow);
    expect(await checker({ fetchTimeoutMs: 50 }).check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: false, problem: "cert_fetch" });
    expect(slow).toHaveBeenCalledTimes(1);
  });
});

describe("the caches", () => {
  it("download a certificate once for many deliveries, even at the same moment", async () => {
    const signatures = checker();
    serve(CERT_URL, chain.leaf);
    const verdicts = await Promise.all(Array.from({ length: 5 }, () => signatures.check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)));
    expect(verdicts.every((verdict) => verdict.ok)).toBe(true);
    expect(await signatures.check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: true });
    expect(net.requests).toHaveLength(1);
  });

  it("keep at most 20 good certificates, dropping the oldest", async () => {
    let now = Date.UTC(2026, 9, 26);
    const signatures = checker({ now: () => now });
    const urls = Array.from({ length: 21 }, (_unused, index) => `${CERT_URL}-${index}`);
    for (const [index, url] of urls.entries()) {
      serve(url, chain.leaf);
      expect(await signatures.check(headersFor(BODY, { cert_url: url }), BODY, WEBHOOK_ID, sender(index))).toEqual({ ok: true });
      // Spaced so the downloads stay inside the 10 a minute budget.
      now += 7_000;
    }
    expect(net.requests).toHaveLength(21);
    await signatures.check(headersFor(BODY, { cert_url: urls[20] }), BODY, WEBHOOK_ID, SENDER);
    expect(net.requests).toHaveLength(21);
    await signatures.check(headersFor(BODY, { cert_url: urls[0] }), BODY, WEBHOOK_ID, SENDER);
    expect(net.requests).toHaveLength(22);
  });

  it("remember a failed address for 10 minutes", async () => {
    let now = Date.UTC(2026, 9, 26);
    const signatures = checker({ now: () => now });
    net.served.set(CERT_URL, () => new Response("down", { status: 503 }));
    for (let n = 0; n < 3; n += 1) expect(await signatures.check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: false, problem: "cert_fetch" });
    expect(net.requests).toHaveLength(1);
    now += 10 * 60 * 1000;
    serve(CERT_URL, chain.leaf);
    expect(await signatures.check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: true });
    expect(net.requests).toHaveLength(2);
  });

  it("serve a cached leaf past 24 hours while inside its dates, and refuse it once past its end date", async () => {
    const start = Date.UTC(2026, 9, 26);
    let now = start;
    const threeDays = issue({ commonName: chain.leaf.commonName, keys: chain.leafKeys, issuer: chain.intermediate, ca: false, notAfter: new Date(start + 3 * 24 * 60 * 60 * 1000) });
    const signatures = checker({ now: () => now });
    serve(CERT_URL, threeDays);
    expect(await signatures.check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: true });
    now += 25 * 60 * 60 * 1000;
    expect(await signatures.check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: true });
    expect(net.requests).toHaveLength(1);
    now = start + 3 * 24 * 60 * 60 * 1000 + 1_000;
    expect(await signatures.check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: false, problem: "cert_chain" });
  });
});

describe("the download budget", () => {
  it("allows 10 certificate downloads a minute across the process: the 11th new address is refused with no fetch, while a cached certificate still verifies", async () => {
    let now = Date.UTC(2026, 9, 26);
    const signatures = checker({ now: () => now });
    const urls = Array.from({ length: 11 }, (_unused, index) => `${CERT_URL}-budget-${index}`);
    for (const url of urls) serve(url, chain.leaf);
    for (const [index, url] of urls.slice(0, 10).entries()) {
      expect(await signatures.check(headersFor(BODY, { cert_url: url }), BODY, WEBHOOK_ID, sender(index))).toEqual({ ok: true });
    }
    expect(await signatures.check(headersFor(BODY, { cert_url: urls[10] }), BODY, WEBHOOK_ID, sender(10))).toEqual({ ok: false, problem: "certificate_budget" });
    expect(net.requests.map((request) => request.url)).toEqual(urls.slice(0, 10));
    expect(await signatures.check(headersFor(BODY, { cert_url: urls[3] }), BODY, WEBHOOK_ID, sender(10))).toEqual({ ok: true });
    expect(net.requests).toHaveLength(10);
    // The refusal was not remembered as a failed address: a minute on, it downloads and passes.
    now += 60_000;
    expect(await signatures.check(headersFor(BODY, { cert_url: urls[10] }), BODY, WEBHOOK_ID, sender(10))).toEqual({ ok: true });
    expect(net.requests).toHaveLength(11);
  });

  it("lets one client address cause 2 downloads a minute: its third new address is refused unfetched, while another address still downloads", async () => {
    let now = Date.UTC(2026, 9, 26);
    const signatures = checker({ now: () => now });
    const urls = Array.from({ length: 4 }, (_unused, index) => `${CERT_URL}-share-${index}`);
    for (const url of urls) serve(url, chain.leaf);
    for (const url of urls.slice(0, 2)) {
      expect(await signatures.check(headersFor(BODY, { cert_url: url }), BODY, WEBHOOK_ID, "203.0.113.9")).toEqual({ ok: true });
    }
    expect(await signatures.check(headersFor(BODY, { cert_url: urls[2] }), BODY, WEBHOOK_ID, "203.0.113.9")).toEqual({ ok: false, problem: "certificate_budget" });
    expect(net.requests.map((request) => request.url)).toEqual(urls.slice(0, 2));
    expect(await signatures.check(headersFor(BODY, { cert_url: urls[3] }), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: true });
    now += 60_000;
    expect(await signatures.check(headersFor(BODY, { cert_url: urls[2] }), BODY, WEBHOOK_ID, "203.0.113.9")).toEqual({ ok: true });
    expect(net.requests).toHaveLength(4);
  });

  it("counts an issuer download against the share of the address whose delivery caused it", async () => {
    const signatures = checker({ intermediates: [], now: () => Date.UTC(2026, 9, 26) });
    net.served.set(ISSUER_URL, () => new Response(new Uint8Array(chain.intermediate.der)));
    serve(CERT_URL, chain.leafWithIssuerUrl(ISSUER_URL));
    serve(`${CERT_URL}-next`, chain.leaf);
    expect(await signatures.check(headersFor(BODY), BODY, WEBHOOK_ID, "203.0.113.9")).toEqual({ ok: true });
    expect(await signatures.check(headersFor(BODY, { cert_url: `${CERT_URL}-next` }), BODY, WEBHOOK_ID, "203.0.113.9")).toEqual({ ok: false, problem: "certificate_budget" });
    expect(net.requests.map((request) => request.url)).toEqual([CERT_URL, ISSUER_URL]);
  });

  // The address verifies one delivery (or only forged ones), is pushed out of the cache by
  // twenty newer good addresses spaced inside the cap, and the cap is then filled by ten
  // forged first-time addresses; the answer for the next delivery under it is returned.
  async function afterCapFills(firstSignature: "genuine" | "forged") {
    let now = Date.UTC(2026, 9, 26);
    const signatures = checker({ now: () => now });
    serve(CERT_URL, chain.leaf);
    const first = firstSignature === "genuine" ? headersFor(BODY) : { ...headersFor(BODY), transmission_sig: Buffer.alloc(256, 1).toString("base64") };
    expect((await signatures.check(first, BODY, WEBHOOK_ID, SENDER)).ok).toBe(firstSignature === "genuine");
    for (let index = 0; index < 20; index += 1) {
      now += 7_000;
      serve(`${CERT_URL}-newer-${index}`, chain.leaf);
      expect((await signatures.signingKey(`${CERT_URL}-newer-${index}`, sender(index))).ok).toBe(true);
    }
    now += 60_000;
    for (let index = 0; index < 10; index += 1) {
      expect(await signatures.check(headersFor(BODY, { cert_url: `${CERT_URL}-forged-${index}` }), BODY, WEBHOOK_ID, sender(100 + index))).toEqual({ ok: false, problem: "cert_fetch" });
    }
    expect(await signatures.check(headersFor(BODY, { cert_url: `${CERT_URL}-forged-10` }), BODY, WEBHOOK_ID, sender(110))).toEqual({ ok: false, problem: "certificate_budget" });
    const before = net.requests.length;
    const verdict = await signatures.check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER);
    return { verdict, fetched: net.requests.slice(before).map((request) => request.url) };
  }

  it("never starves a known-good address: once it verified a delivery, downloading it again draws nothing from the cap", async () => {
    expect(await afterCapFills("genuine")).toEqual({ verdict: { ok: true }, fetched: [CERT_URL] });
  });

  it("does not treat an address as known good when every delivery under it was forged", async () => {
    expect(await afterCapFills("forged")).toEqual({ verdict: { ok: false, problem: "certificate_budget" }, fetched: [] });
  });

  it("knows an address the record kept after a restart: it skips both caps, its issuer download included", async () => {
    const { kept, certificates } = memory();
    net.served.set(ISSUER_URL, () => new Response(new Uint8Array(chain.intermediate.der)));
    serve(CERT_URL, chain.leafWithIssuerUrl(ISSUER_URL));
    expect(await checker({ intermediates: [], certificates }).check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: true });
    expect(kept.urls).toEqual([CERT_URL]);
    // The restart: a fresh checker, nothing in memory, the same record.
    const restarted = checker({ intermediates: [], certificates });
    for (let index = 0; index < 2; index += 1) {
      expect(await restarted.check(headersFor(BODY, { cert_url: `${CERT_URL}-gone-${index}` }), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: false, problem: "cert_fetch" });
    }
    for (let index = 0; index < 8; index += 1) {
      expect(await restarted.check(headersFor(BODY, { cert_url: `${CERT_URL}-other-${index}` }), BODY, WEBHOOK_ID, sender(index))).toEqual({ ok: false, problem: "cert_fetch" });
    }
    expect(await restarted.check(headersFor(BODY, { cert_url: `${CERT_URL}-other-8` }), BODY, WEBHOOK_ID, sender(8))).toEqual({ ok: false, problem: "certificate_budget" });
    const before = net.requests.length;
    expect(await restarted.check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: true });
    expect(net.requests.slice(before).map((request) => request.url)).toEqual([CERT_URL, ISSUER_URL]);
    expect(kept.recalls).toBe(2);
  });

  it("reads the record through the same parser as a delivery's address", async () => {
    const { certificates } = memory(["https://API.Sandbox.PayPal.com:443/v1/notifications/certs/CERT-test-0001", `${CERT_URL}-x?n=1`]);
    const signatures = checker({ certificates });
    for (let index = 0; index < 10; index += 1) {
      expect(await signatures.check(headersFor(BODY, { cert_url: `${CERT_URL}-other-${index}` }), BODY, WEBHOOK_ID, sender(index))).toEqual({ ok: false, problem: "cert_fetch" });
    }
    serve(CERT_URL, chain.leaf);
    expect(await signatures.check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: true });
    serve(`${CERT_URL}-x`, chain.leaf);
    expect(await signatures.check(headersFor(BODY, { cert_url: `${CERT_URL}-x` }), BODY, WEBHOOK_ID, sender(20))).toEqual({ ok: false, problem: "certificate_budget" });
  });

  it("counts a failed address's download, but not the answers its cache gives afterwards", async () => {
    const signatures = checker({ now: () => Date.UTC(2026, 9, 26) });
    net.served.set(CERT_URL, () => new Response("down", { status: 503 }));
    for (let n = 0; n < 20; n += 1) expect(await signatures.check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: false, problem: "cert_fetch" });
    const urls = Array.from({ length: 10 }, (_unused, index) => `${CERT_URL}-after-${index}`);
    for (const url of urls) serve(url, chain.leaf);
    for (const [index, url] of urls.slice(0, 9).entries()) expect((await signatures.check(headersFor(BODY, { cert_url: url }), BODY, WEBHOOK_ID, sender(index))).ok).toBe(true);
    expect(await signatures.check(headersFor(BODY, { cert_url: urls[9] }), BODY, WEBHOOK_ID, sender(9))).toEqual({ ok: false, problem: "certificate_budget" });
    expect(net.requests).toHaveLength(10);
  });

  it("shares the budget with DigiCert issuer downloads", async () => {
    const signatures = checker({ intermediates: [], now: () => Date.UTC(2026, 9, 26) });
    // Nine downloads of a leaf this checker cannot chain (no bundle, no CA Issuers address).
    const urls = Array.from({ length: 9 }, (_unused, index) => `${CERT_URL}-plain-${index}`);
    for (const url of urls) serve(url, chain.leaf);
    for (const [index, url] of urls.entries()) expect(await signatures.check(headersFor(BODY, { cert_url: url }), BODY, WEBHOOK_ID, sender(index))).toEqual({ ok: false, problem: "cert_chain" });
    // The tenth fetches the leaf; its issuer would be the eleventh, so it is refused unfetched.
    net.served.set(ISSUER_URL, () => new Response(new Uint8Array(chain.intermediate.der)));
    serve(CERT_URL, chain.leafWithIssuerUrl(ISSUER_URL));
    expect(await signatures.check(headersFor(BODY), BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: false, problem: "certificate_budget" });
    expect(net.requests.map((request) => request.url)).toEqual([...urls, CERT_URL]);
  });
});

describe("PayPal's real sandbox certificate", () => {
  function served(): void {
    net.served.set(LIVE_CERT_URL, () => new Response(LIVE_LEAF, { headers: { "content-type": "application/x-pem-file" } }));
  }

  it("chains through the bundled DigiCert EV RSA CA G2 to a root in Node's own store, with no other download", async () => {
    served();
    const leaf = await realChecker(INSIDE_LIVE_LEAF).signingKey(LIVE_CERT_URL, SENDER);
    expect(leaf.ok).toBe(true);
    const expected = new X509Certificate(LIVE_LEAF).publicKey.export({ type: "spki", format: "der" });
    expect(leaf.ok && leaf.key.export({ type: "spki", format: "der" }).equals(expected)).toBe(true);
    expect(net.requests.map((request) => request.url)).toEqual([LIVE_CERT_URL]);
  });

  it("reaches the signature check, and fails only there, for a delivery we cannot sign", async () => {
    served();
    const headers = { ...headersFor(BODY), cert_url: LIVE_CERT_URL };
    expect(await realChecker(INSIDE_LIVE_LEAF).check(headers, BODY, WEBHOOK_ID, SENDER)).toEqual({ ok: false, problem: "signature" });
  });

  it("is refused after its end date, and refused when Node's roots are not the anchors", async () => {
    served();
    expect(await realChecker(Date.UTC(2027, 0, 27)).signingKey(LIVE_CERT_URL, SENDER)).toEqual({ ok: false, problem: "cert_chain" });
    expect(await realChecker(INSIDE_LIVE_LEAF, { anchors: [chain.root.pem] }).signingKey(LIVE_CERT_URL, SENDER)).toEqual({ ok: false, problem: "cert_chain" });
  });

  it("names, in the bundle's own comment, the fingerprint of the certificate the bundle holds", () => {
    const text = readFileSync(new URL("./paypal-intermediates.pem", import.meta.url), "latin1");
    const pem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(text)?.[0] ?? "";
    const bundled = new X509Certificate(pem);
    expect(bundled.toLegacyObject().subject.CN).toBe("DigiCert EV RSA CA G2");
    expect(text).toContain(`SHA-256 fingerprint: ${bundled.fingerprint256}`);
    expect(bundled.fingerprint256).toBe("95:88:EF:74:19:9E:45:AC:EF:CC:CF:C0:C4:70:10:E9:F2:A3:7A:1D:D4:4C:61:A4:E1:C6:B3:34:DA:5A:F6:14");
  });
});
