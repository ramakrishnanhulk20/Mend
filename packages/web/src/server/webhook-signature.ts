/**
 * PayPal webhook signatures checked inside the app, with no call to PayPal's verify API
 * (C9), so a forged delivery spends none of the PayPal rate limits Payouts needs.
 *
 * PayPal signs transmission_id|transmission_time|webhook_id|crc32, where crc32 is the
 * CRC-32 of the raw body as an unsigned decimal, taken here over the request's own bytes
 * and never over a decoded copy, with SHA256withRSA, and names the
 * signing certificate in PAYPAL-CERT-URL. That address is used only when the href of one
 * WHATWG parse is exactly https://api.sandbox.paypal.com/v1/notifications/certs/CERT-
 * and 1 to 100 letters, digits or hyphens, with no port, user, query or fragment; anything
 * else is refused before any cache, the table or a download is consulted. The parsed href
 * is what is fetched, the cache key and what the table holds, so the address checked is
 * the address used.
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
 * causes one download. Downloads of new addresses and of DigiCert issuers are counted in
 * memory, at most 2 a minute for what one client address causes inside 10 a minute for
 * the process, so a flood naming new addresses cannot make the app hammer PayPal's or
 * DigiCert's hosts and no one address can use up the process's share; over either a
 * delivery is refused (certificate_budget) with nothing fetched and nothing cached, and
 * an answer from a cache never counts. An address whose certificate verified a delivery
 * is known good: its downloads, its issuer's included, draw on neither cap, so a flood
 * cannot starve the certificate PayPal really uses. Each verified delivery upserts its
 * address with the time into the paypal_certs table, and the first download decision
 * after a start reads the addresses verified in the last 400 days, so a restart forgets
 * nothing. Only a delivery PayPal signed can make an address known good, and what the
 * table returns is held to the address rule again before it counts. If the table cannot
 * be read, the read is tried again a minute later and the caps hold meanwhile. A flood
 * across five or more addresses can still fill the process cap ahead of the first
 * delivery under an address never verified before, as after PayPal's yearly certificate
 * rotation; PayPal retries that delivery.
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
import { AddressLimiter } from "./address-limits";
import { database } from "./db";
import { writeLog } from "./log";
import type { Limit } from "./ratelimit";

// Matched against the href of one WHATWG parse, so a port, user, query or fragment would
// show in the text and fail it.
const CERT_HREF = /^https:\/\/api\.sandbox\.paypal\.com\/v1\/notifications\/certs\/CERT-[A-Za-z0-9-]{1,100}$/;
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
const DOWNLOAD_WINDOW_MS = 60 * 1000;

/** Certificate downloads a minute, counted in memory: 2 for what one client address causes, inside 10 for the process. */
export const CERTIFICATE_LIMITS = {
  address: { bucket: "certificate_address", max: 2, windowMs: DOWNLOAD_WINDOW_MS, per: "address" },
  all: { bucket: "certificate_all", max: 10, windowMs: DOWNLOAD_WINDOW_MS, per: "all" },
} as const satisfies Record<"address" | "all", Limit>;

export const REMEMBER_FOR_DAYS = 400;
// After a failed read of the table, the next try waits this long, so a missing table
// costs one query a minute rather than one per delivery.
const RECALL_RETRY_MS = 60 * 1000;
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

/** Where certificate addresses that verified a genuine delivery are kept, so a restart does not forget them. */
export type VerifiedCertificates = {
  /** The addresses last verified within REMEMBER_FOR_DAYS, newest first, at most MAX_GOOD. */
  recall(): Promise<readonly string[]>;
  /** Mark href as having verified a delivery now. */
  record(href: string): Promise<void>;
};

/** The paypal_certs table in the app's database. Either method rejects when the database does. */
export const paypalCertsTable: VerifiedCertificates = {
  async recall() {
    const { rows } = await database().query<{ url: string }>(
      "select url from paypal_certs where last_verified_at > now() - make_interval(days => $1) order by last_verified_at desc limit $2",
      [REMEMBER_FOR_DAYS, MAX_GOOD],
    );
    return rows.map((row) => row.url);
  },
  async record(href) {
    await database().query(
      "insert into paypal_certs (url, last_verified_at) values ($1, now()) on conflict (url) do update set last_verified_at = excluded.last_verified_at",
      [href],
    );
  },
};

export type SignatureOptions = {
  /** Roots (PEM) a chain may end at. Production uses Node's tls.rootCertificates. */
  readonly anchors?: readonly string[];
  /** Intermediates (PEM) that fill a chain before anything is downloaded. Production uses paypal-intermediates.pem. */
  readonly intermediates?: readonly string[];
  /** Where verified certificate addresses outlive the process. Production uses the paypal_certs table. */
  readonly certificates?: VerifiedCertificates;
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
 * The certificate address as one WHATWG parse gives it, or null unless its href is exactly
 * https://api.sandbox.paypal.com/v1/notifications/certs/CERT- followed by 1 to 100
 * letters, digits or hyphens: no port, user, query or fragment, not even an empty one.
 */
export function certificateUrl(text: string): URL | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  return CERT_HREF.test(url.href) ? url : null;
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
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

/** The exact text PayPal signs for a delivery, with the CRC-32 taken over the body's bytes exactly as received. */
export function signedText(headers: SignedHeaders, rawBody: Uint8Array, webhookId: string): string {
  return `${headers.transmission_id}|${headers.transmission_time}|${webhookId}|${crc32(rawBody)}`;
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
  private readonly budget: AddressLimiter;
  private readonly verified: VerifiedCertificates;
  // Addresses whose certificate verified a delivery: this process's own, plus the table's
  // once it has been read.
  private readonly knownGood = new Set<string>();
  private recalled = false;
  private recalling: Promise<void> | null = null;
  private recallAgainAt = 0;

  constructor(options: SignatureOptions = {}) {
    this.anchorPems = options.anchors ?? rootCertificates;
    this.intermediatePems = options.intermediates;
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
    this.verified = options.certificates ?? paypalCertsTable;
    this.budget = new AddressLimiter(CERTIFICATE_LIMITS.address, CERTIFICATE_LIMITS.all, this.now);
  }

  /**
   * Whether headers carry PayPal's signature over these exact body bytes, as received,
   * for webhookId. address is the sender's client address (ratelimit.ts clientAddress),
   * whose share of the download budget any download this delivery causes draws on. Never
   * throws and never calls PayPal's API; the only requests are the certificate download
   * and, when the bundle lacks an issuer, one to DigiCert's host. A delivery that
   * verifies records its certificate address in the table, and is still verified if that
   * write fails.
   */
  async check(headers: SignedHeaders, rawBody: Uint8Array, webhookId: string, address: string): Promise<SignatureVerdict> {
    const early = signatureHeaderProblem(headers);
    const url = certificateUrl(headers.cert_url);
    if (early !== null || url === null) return { ok: false, problem: early ?? "cert_url" };
    const leaf = await this.signingKey(url.href, address);
    if (!leaf.ok) return leaf;
    let genuine: boolean;
    try {
      genuine = verify("sha256", Buffer.from(signedText(headers, rawBody, webhookId), "utf8"), leaf.key, Buffer.from(headers.transmission_sig, "base64"));
    } catch {
      genuine = false;
    }
    if (!genuine) return { ok: false, problem: "signature" };
    this.knownGood.add(url.href);
    await this.recordVerified(url.href);
    return { ok: true };
  }

  /**
   * The key of the certificate at href, an address certificateUrl gave, once its chain
   * checks out. Answers from the caches when it can; concurrent calls for one address
   * share one download. A download draws on address's share and the process cap unless
   * href is known good; over either, the answer is certificate_budget with nothing fetched.
   */
  async signingKey(href: string, address: string): Promise<SigningKey> {
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
    const task = this.load(href, address).finally(() => this.pending.delete(href));
    this.pending.set(href, task);
    return task;
  }

  // True, and one download counted for address and for the process, while address has
  // started fewer than 2 in the last minute and the process fewer than 10. A refusal
  // counts nowhere. null is a known-good address's download, which no cap holds back.
  private takeDownload(chargedTo: string | null): boolean {
    return chargedTo === null || this.budget.take(chargedTo).allowed;
  }

  private async isKnownGood(href: string): Promise<boolean> {
    if (this.knownGood.has(href)) return true;
    await this.recall();
    return this.knownGood.has(href);
  }

  // Reads the table once per process. Until a read succeeds, only this process's own
  // verifications count as known good, so a failure leaves every cap in place.
  private recall(): Promise<void> {
    if (this.recalled || this.now() < this.recallAgainAt) return Promise.resolve();
    this.recalling ??= Promise.resolve()
      .then(() => this.verified.recall())
      .then(
        (urls) => {
          for (const text of urls) {
            // Read back through the parser a delivery's address goes through, so both compare as hrefs.
            const url = certificateUrl(text);
            if (url !== null) this.knownGood.add(url.href);
          }
          this.recalled = true;
        },
        (error: unknown) => {
          this.recallAgainAt = this.now() + RECALL_RETRY_MS;
          writeLog({ kind: "webhook", outcome: "certs_not_recalled", code: errorCode(error) });
        },
      )
      .finally(() => {
        this.recalling = null;
      });
    return this.recalling;
  }

  private async recordVerified(href: string): Promise<void> {
    try {
      await this.verified.record(href);
    } catch (error) {
      // The delivery is still genuine; this process keeps href as known good regardless.
      writeLog({ kind: "webhook", outcome: "cert_not_recorded", code: errorCode(error) });
    }
  }

  private async load(href: string, address: string): Promise<SigningKey> {
    const chargedTo = (await this.isKnownGood(href)) ? null : address;
    if (!this.takeDownload(chargedTo)) return { ok: false, problem: "certificate_budget" };
    const body = await download(href, MAX_CERT_BYTES, this.timeoutMs);
    const served = body === null ? null : onlyPem(body, MAX_SERVED);
    const checked: Checked = served === null ? { ok: false } : await this.checkChain(served, chargedTo);
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

  // The issuer named by cert's CA Issuers address, cached only once it is seen to sign
  // cert, so a certificate that signs nothing below it is never handed to a later chain.
  private async downloadedIssuer(cert: X509Certificate, chargedTo: string | null): Promise<X509Certificate | null | typeof OVER_BUDGET> {
    const href = caIssuersHref(cert);
    if (href === null) return null;
    const cached = this.issuers.get(href);
    if (cached !== undefined && this.now() - cached.storedAt < ISSUER_FOR_MS) return cached.cert;
    if (!this.takeDownload(chargedTo)) return OVER_BUDGET;
    const body = await download(href, MAX_ISSUER_BYTES, this.timeoutMs);
    const issuer = body === null ? null : oneCertificate(body);
    if (issuer === null || !signedBy(cert, issuer)) return null;
    remember(this.issuers, href, { cert: issuer, storedAt: this.now() }, MAX_ISSUERS);
    return issuer;
  }

  private async checkChain(served: readonly X509Certificate[], chargedTo: string | null): Promise<Checked> {
    const chain = [...served];
    let anchor = this.anchorFor(chain[chain.length - 1]);
    for (let fills = 0; anchor === null && fills < MAX_FILLS; fills += 1) {
      const last = chain[chain.length - 1];
      const issuer = this.bundledIssuer(last) ?? (await this.downloadedIssuer(last, chargedTo));
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
