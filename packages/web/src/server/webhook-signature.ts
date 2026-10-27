/**
 * PayPal webhook signatures checked inside the app, with no call to PayPal's verify API
 * (C9), so a forged delivery spends none of the PayPal rate limits Payouts needs.
 *
 * PayPal signs transmission_id|transmission_time|webhook_id|crc32, where crc32 is the
 * CRC-32 of the raw body as an unsigned decimal, with SHA256withRSA, and names the
 * signing certificate in PAYPAL-CERT-URL. That address is used only when one WHATWG
 * parse gives https, host exactly api.sandbox.paypal.com on the default port, no user
 * or password, and a path under /v1/notifications/certs/. The parsed href is both what
 * is fetched and the cache key, so the address checked is the address used.
 *
 * The certificate is believed only through a chain this file builds and checks. PayPal
 * serves the leaf alone, so a missing issuer is taken first from paypal-intermediates.pem
 * and otherwise downloaded from the certificate's CA Issuers address, only when that
 * parses to host exactly cacerts.digicert.com; plain http is accepted there because
 * nothing downloaded is believed until its signature checks up to a root. At most two
 * issuers are added. Every certificate in the chain must be signed by the next and be
 * inside its dates, and the root it ends at too; every certificate above the leaf must
 * be a CA; the last must be signed by a root in Node's tls.rootCertificates. The leaf
 * must name exactly messageverificationcerts.sandbox.paypal.com (sandbox only, C16),
 * must not be a CA, and must hold an RSA key.
 *
 * Downloads refuse redirects, stop after 10 seconds, and read at most 64 KB for the
 * certificate and 16 KB for an issuer. A leaf that checks out is cached by address until
 * the first end date in its chain (at most 20 addresses), a downloaded issuer for 24
 * hours, and an address that failed for 10 minutes, so a flood naming the same address
 * causes one download. Downloads of new addresses and of DigiCert issuers are capped
 * together at 10 a minute across the process, so a flood naming new addresses cannot
 * make the app hammer PayPal's or DigiCert's hosts; over the cap a delivery is refused
 * (certificate_budget) with nothing fetched and nothing cached, and an answer from a
 * cache never counts. An address that has verified a delivery since the process started
 * is known good: downloading it again never draws on the cap, so a flood of new
 * addresses cannot starve the certificate PayPal really uses. Only a delivery PayPal
 * signed can make an address known good. The cap can still hold off a genuine delivery
 * under an address not yet known, such as the first after a restart, which PayPal then
 * retries.
 *
 * Covers forged or altered deliveries, certificates from any other host, for any other
 * name, expired or not yet valid, or not reaching a root Node trusts. Does not cover
 * revocation (no OCSP or CRL check) or PayPal's own signing key being stolen.
 */
import { verify, X509Certificate, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { rootCertificates } from "node:tls";
import { crc32 } from "node:zlib";
import { writeLog } from "./log";

export const CERT_HOST = "api.sandbox.paypal.com";
const CERT_PATH = "/v1/notifications/certs/";
export const SIGNING_NAME = "messageverificationcerts.sandbox.paypal.com";
export const ISSUER_HOST = "cacerts.digicert.com";
export const AUTH_ALGO = "SHA256withRSA";
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_CERT_BYTES = 64 * 1024;
export const MAX_ISSUER_BYTES = 16 * 1024;
const ISSUER_FOR_MS = 24 * 60 * 60 * 1000;
export const FAILED_FOR_MS = 10 * 60 * 1000;
export const MAX_GOOD = 20;
const MAX_FAILED = 1000;
const MAX_ISSUERS = 20;
export const MAX_FILLS = 2;
export const MAX_DOWNLOADS_PER_MINUTE = 10;
const DOWNLOAD_WINDOW_MS = 60 * 1000;
const MAX_SERVED = 4;
const INTERMEDIATES_FILE = ["src", "server", "paypal-intermediates.pem"];

// The class leaves out "-", so a match cannot run past its own END line.
const PEM_BLOCK = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g;

/** The PAYPAL-* header values a signature check reads, already held to their header shapes. */
export type SignedHeaders = {
  readonly auth_algo: string;
  readonly cert_url: string;
  readonly transmission_id: string;
  readonly transmission_sig: string;
  readonly transmission_time: string;
};

/**
 * Which check refused a delivery: the algorithm, the certificate address, the download,
 * the download cap, the chain, or the signature itself.
 */
export type SignatureProblem = "auth_algo" | "cert_url" | "cert_fetch" | "certificate_budget" | "cert_chain" | "signature";

export type SignatureVerdict = { readonly ok: true } | { readonly ok: false; readonly problem: SignatureProblem };

/** The signing key a certificate address holds once its chain checks out, or why not. */
export type SigningKey =
  | { readonly ok: true; readonly key: KeyObject }
  | { readonly ok: false; readonly problem: "cert_fetch" | "certificate_budget" | "cert_chain" };

export type SignatureOptions = {
  /** Roots (PEM) a chain may end at. Production uses Node's tls.rootCertificates. */
  readonly anchors?: readonly string[];
  /** Intermediates (PEM) that fill a chain before anything is downloaded. Production uses paypal-intermediates.pem. */
  readonly intermediates?: readonly string[];
  readonly now?: () => number;
  readonly fetchTimeoutMs?: number;
};

type Checked = { readonly ok: true; readonly key: KeyObject; readonly from: number; readonly until: number } | { readonly ok: false; readonly overBudget?: true };
const OVER_BUDGET = "over_budget";
type Good = { readonly key: KeyObject; readonly from: number; readonly until: number };
type Failed = { readonly problem: "cert_fetch" | "cert_chain"; readonly at: number };

function noUserinfo(url: URL): boolean {
  return url.username === "" && url.password === "";
}

/**
 * The certificate address as one WHATWG parse gives it, or null unless it is https, host
 * exactly api.sandbox.paypal.com on the default port, with no user or password, and a
 * path starting /v1/notifications/certs/.
 */
export function certificateUrl(text: string): URL | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const allowed = url.protocol === "https:" && url.hostname === CERT_HOST && url.port === "" && noUserinfo(url) && url.pathname.startsWith(CERT_PATH);
  return allowed ? url : null;
}

/** A CA Issuers address parsed the same way, or null unless it is http or https on cacerts.digicert.com's default port with no user or password. */
export function issuerUrl(text: string): URL | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const allowed = (url.protocol === "http:" || url.protocol === "https:") && url.hostname === ISSUER_HOST && url.port === "" && noUserinfo(url);
  return allowed ? url : null;
}

/** The problem with the algorithm or certificate address, found without any download, or null when both may be used. */
export function signatureHeaderProblem(headers: SignedHeaders): "auth_algo" | "cert_url" | null {
  if (headers.auth_algo !== AUTH_ALGO) return "auth_algo";
  return certificateUrl(headers.cert_url) === null ? "cert_url" : null;
}

/** The exact text PayPal signs for a delivery. */
export function signedText(headers: SignedHeaders, rawBody: string, webhookId: string): string {
  return `${headers.transmission_id}|${headers.transmission_time}|${webhookId}|${crc32(Buffer.from(rawBody, "utf8"))}`;
}

// The body, or null for any error status, redirect, timeout, network failure, or a body
// past maxBytes, declared or not. Reading stops at the first chunk past the cap.
async function download(href: string, maxBytes: number, timeoutMs: number): Promise<Buffer | null> {
  try {
    const response = await fetch(href, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    const declared = response.headers.get("content-length");
    if (response.status !== 200 || response.body === null || (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes)) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

function pemBlocks(text: string): string[] {
  return text.match(PEM_BLOCK) ?? [];
}

// Certificates from a body that is nothing but 1 to max PEM certificate blocks.
function onlyPem(body: Buffer, max: number): X509Certificate[] | null {
  const text = body.toString("latin1");
  const blocks = pemBlocks(text);
  if (blocks.length === 0 || blocks.length > max || text.replace(PEM_BLOCK, "").trim() !== "") return null;
  try {
    return blocks.map((block) => new X509Certificate(block));
  } catch {
    return null;
  }
}

// One certificate, as a single PEM block or as DER.
function oneCertificate(body: Buffer): X509Certificate | null {
  if (body.toString("latin1").includes("-----BEGIN")) return onlyPem(body, 1)?.[0] ?? null;
  try {
    return new X509Certificate(body);
  } catch {
    return null;
  }
}

// Each PEM that parses; one that does not is left out rather than failing every check.
function parseAll(pems: readonly string[]): X509Certificate[] {
  return pems.flatMap((pem) => {
    try {
      return [new X509Certificate(pem)];
    } catch {
      return [];
    }
  });
}

function signedBy(child: X509Certificate, parent: X509Certificate): boolean {
  try {
    return child.checkIssued(parent) && child.verify(parent.publicKey);
  } catch {
    return false;
  }
}

function within(cert: X509Certificate, now: number): boolean {
  return now >= cert.validFromDate.getTime() && now <= cert.validToDate.getTime();
}

function remember<T>(map: Map<string, T>, key: string, value: T, max: number): void {
  map.delete(key);
  if (map.size >= max) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

function caIssuersHref(cert: X509Certificate): string | null {
  for (const text of cert.toLegacyObject().infoAccess?.["CA Issuers - URI"] ?? []) {
    const url = issuerUrl(text);
    if (url !== null) return url.href;
  }
  return null;
}

function bundledIntermediates(): string[] {
  try {
    // next start runs from packages/web on Render, as the tests do.
    return pemBlocks(readFileSync(path.join(process.cwd(), ...INTERMEDIATES_FILE), "latin1"));
  } catch (error) {
    // Not fatal: a chain is still filled from DigiCert's host and checked to a Node root.
    const code = (error as { code?: unknown }).code;
    writeLog({ kind: "webhook", outcome: "intermediates_unreadable", code: typeof code === "string" ? code : null });
    return [];
  }
}

/** Checks delivery signatures and keeps the certificate caches for as long as it lives. */
export class SignatureChecker {
  private readonly anchorPems: readonly string[];
  private readonly intermediatePems: readonly string[] | undefined;
  private anchors: X509Certificate[] | null = null;
  private bundled: X509Certificate[] | null = null;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly good = new Map<string, Good>();
  private readonly failed = new Map<string, Failed>();
  private readonly pending = new Map<string, Promise<SigningKey>>();
  private readonly issuers = new Map<string, { readonly cert: X509Certificate; readonly storedAt: number }>();
  // Start times of the downloads in the last minute, oldest first.
  private readonly downloads: number[] = [];
  // Addresses whose certificate has verified a delivery since the process started.
  private readonly knownGood = new Set<string>();

  constructor(options: SignatureOptions = {}) {
    this.anchorPems = options.anchors ?? rootCertificates;
    this.intermediatePems = options.intermediates;
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  }

  /**
   * Whether headers carry PayPal's signature over this exact body for webhookId. Never
   * throws and never calls PayPal's API; the only requests are the certificate download
   * and, when the bundle lacks an issuer, one to DigiCert's host.
   */
  async check(headers: SignedHeaders, rawBody: string, webhookId: string): Promise<SignatureVerdict> {
    const early = signatureHeaderProblem(headers);
    const url = certificateUrl(headers.cert_url);
    if (early !== null || url === null) return { ok: false, problem: early ?? "cert_url" };
    const leaf = await this.signingKey(url.href);
    if (!leaf.ok) return leaf;
    let genuine: boolean;
    try {
      genuine = verify("sha256", Buffer.from(signedText(headers, rawBody, webhookId), "utf8"), leaf.key, Buffer.from(headers.transmission_sig, "base64"));
    } catch {
      genuine = false;
    }
    if (!genuine) return { ok: false, problem: "signature" };
    this.knownGood.add(url.href);
    return { ok: true };
  }

  /**
   * The key of the certificate at href, an address certificateUrl gave, once its chain
   * checks out. Answers from the caches when it can; concurrent calls for one address
   * share one download.
   */
  async signingKey(href: string): Promise<SigningKey> {
    const now = this.now();
    const good = this.good.get(href);
    if (good !== undefined) {
      if (now >= good.from && now <= good.until) return { ok: true, key: good.key };
      this.good.delete(href);
    }
    const failed = this.failed.get(href);
    if (failed !== undefined) {
      if (now - failed.at < FAILED_FOR_MS) return { ok: false, problem: failed.problem };
      this.failed.delete(href);
    }
    const running = this.pending.get(href);
    if (running !== undefined) return running;
    const task = this.load(href).finally(() => this.pending.delete(href));
    this.pending.set(href, task);
    return task;
  }

  // True, and one download counted, while fewer than 10 started in the last minute.
  private takeDownload(): boolean {
    const now = this.now();
    while (this.downloads.length > 0 && this.downloads[0] <= now - DOWNLOAD_WINDOW_MS) this.downloads.shift();
    if (this.downloads.length >= MAX_DOWNLOADS_PER_MINUTE) return false;
    this.downloads.push(now);
    return true;
  }

  private async load(href: string): Promise<SigningKey> {
    if (!this.knownGood.has(href) && !this.takeDownload()) return { ok: false, problem: "certificate_budget" };
    const body = await download(href, MAX_CERT_BYTES, this.timeoutMs);
    const served = body === null ? null : onlyPem(body, MAX_SERVED);
    const checked: Checked = served === null ? { ok: false } : await this.checkChain(served);
    // Running out of downloads says nothing about the address, so it is not remembered as failed.
    if (!checked.ok && checked.overBudget) return { ok: false, problem: "certificate_budget" };
    if (checked.ok) {
      remember(this.good, href, { key: checked.key, from: checked.from, until: checked.until }, MAX_GOOD);
      return { ok: true, key: checked.key };
    }
    const problem = body === null ? "cert_fetch" : "cert_chain";
    remember(this.failed, href, { problem, at: this.now() }, MAX_FAILED);
    return { ok: false, problem };
  }

  private anchorFor(cert: X509Certificate): X509Certificate | null {
    this.anchors ??= parseAll(this.anchorPems);
    return this.anchors.find((anchor) => signedBy(cert, anchor)) ?? null;
  }

  private bundledIssuer(cert: X509Certificate): X509Certificate | null {
    this.bundled ??= parseAll(this.intermediatePems ?? bundledIntermediates());
    return this.bundled.find((candidate) => signedBy(cert, candidate)) ?? null;
  }

  private async downloadedIssuer(cert: X509Certificate): Promise<X509Certificate | null | typeof OVER_BUDGET> {
    const href = caIssuersHref(cert);
    if (href === null) return null;
    const cached = this.issuers.get(href);
    if (cached !== undefined && this.now() - cached.storedAt < ISSUER_FOR_MS) return cached.cert;
    if (!this.takeDownload()) return OVER_BUDGET;
    const body = await download(href, MAX_ISSUER_BYTES, this.timeoutMs);
    const issuer = body === null ? null : oneCertificate(body);
    if (issuer !== null) remember(this.issuers, href, { cert: issuer, storedAt: this.now() }, MAX_ISSUERS);
    return issuer;
  }

  private async checkChain(served: readonly X509Certificate[]): Promise<Checked> {
    const chain = [...served];
    let anchor = this.anchorFor(chain[chain.length - 1]);
    for (let fills = 0; anchor === null && fills < MAX_FILLS; fills += 1) {
      const last = chain[chain.length - 1];
      const issuer = this.bundledIssuer(last) ?? (await this.downloadedIssuer(last));
      if (issuer === OVER_BUDGET) return { ok: false, overBudget: true };
      if (issuer === null) return { ok: false };
      chain.push(issuer);
      anchor = this.anchorFor(issuer);
    }
    if (anchor === null) return { ok: false };
    const now = this.now();
    const leaf = chain[0];
    const linked = chain.every((cert, index) => index === chain.length - 1 || signedBy(cert, chain[index + 1]));
    const dated = [...chain, anchor].every((cert) => within(cert, now));
    const issuersAreCas = chain.slice(1).every((cert) => cert.ca);
    const commonName: unknown = leaf.toLegacyObject().subject.CN;
    const leafFits = commonName === SIGNING_NAME && !leaf.ca && leaf.publicKey.asymmetricKeyType === "rsa";
    if (!linked || !dated || !issuersAreCas || !leafFits) return { ok: false };
    const dates = [...chain, anchor];
    return {
      ok: true,
      key: leaf.publicKey,
      from: Math.max(...dates.map((cert) => cert.validFromDate.getTime())),
      until: Math.min(...dates.map((cert) => cert.validToDate.getTime())),
    };
  }
}

let shared: SignatureChecker | null = null;

/** The one checker the webhook route uses, so its caches last as long as the process. */
export function deliverySignatures(): SignatureChecker {
  shared ??= new SignatureChecker();
  return shared;
}
