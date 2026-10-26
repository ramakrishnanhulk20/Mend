/**
 * Rate limits counted in Postgres (C18, C20), on things the caller cannot choose: the
 * client address the platform saw, or a session id this server issued.
 *
 * The client address is the right-most entry of X-Forwarded-For. On Render, the proxy
 * in front of the app appends the address it received the connection from, so
 * anything a client writes into the header itself lands to the left and is ignored.
 * In development there is no proxy: Next.js fills the header with the socket address
 * when it is absent, so a local caller can set it. IPv6 addresses count per /64,
 * the block one home or server usually holds, so cycling through a block does not
 * buy more attempts.
 *
 * Covers bursts from one address or one session, including concurrent ones: each
 * check takes a lock for its bucket and subject, so the count cannot be raced past.
 * Does not cover an attacker spread across many addresses, and it counts everyone
 * behind one shared address (an office, a mobile carrier) together. If Render ever
 * adds a second proxy hop, the right-most entry becomes that hop's address and every
 * client shares one count: the limit then errs towards refusing, not allowing. The
 * address tag in the webhook log line and in each limit-hit audit row is how to check
 * after a deploy which address Render hands the app.
 *
 * The first refusal in each window for a bucket and subject is written to the audit
 * log (C23), best-effort, with a short tag in place of the address or session id.
 */
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { PoolClient } from "pg";
import { appendAudit, type AuditDetail } from "./audit";
import { csrfSecret } from "./csrf";
import { database } from "./db";
import { writeLog } from "./log";

/** What a limit counts on: one client address, one session this server issued, or every caller together. */
export type Per = "address" | "session" | "all";

export type Limit = { readonly bucket: string; readonly max: number; readonly windowMs: number; readonly per: Per };

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Per-session limits count against a session id this server issued, per-address ones
// against clientAddress. The "all" limits count every caller together (subject GLOBAL),
// the global caps C20 asks for on demo approvals, simulates and webhook traffic; the
// engine's demo pool caps demo spending on top. Where a route takes several, the
// narrowest is taken first, so a caller stopped there never fills a wider count.
export const LIMITS = {
  signIn: { bucket: "sign_in", max: 10, windowMs: 15 * 60 * 1000, per: "address" },
  // Each demo session opens a fresh set of per-session counts, so the number one address
  // may start is what keeps a single visitor from taking every demo's share.
  demoSession: { bucket: "demo_session", max: 4, windowMs: HOUR_MS, per: "address" },
  demoSessionDay: { bucket: "demo_session_day", max: 10, windowMs: DAY_MS, per: "address" },
  draft: { bucket: "draft", max: 20, windowMs: HOUR_MS, per: "session" },
  quietRegulars: { bucket: "quiet_regulars", max: 60, windowMs: HOUR_MS, per: "session" },
  approve: { bucket: "approve", max: 20, windowMs: HOUR_MS, per: "session" },
  demoApprovalsAddress: { bucket: "demo_approvals_address", max: 10, windowMs: HOUR_MS, per: "address" },
  demoApprovals: { bucket: "demo_approvals_all", max: 100, windowMs: HOUR_MS, per: "all" },
  submit: { bucket: "submit", max: 10, windowMs: HOUR_MS, per: "session" },
  // Its own count, so pulling rewards back never uses up a session's submits.
  cancelUnclaimed: { bucket: "cancel_unclaimed", max: 10, windowMs: HOUR_MS, per: "session" },
  simulate: { bucket: "simulate", max: 10, windowMs: HOUR_MS, per: "session" },
  simulateAddress: { bucket: "simulate_address", max: 10, windowMs: HOUR_MS, per: "address" },
  simulates: { bucket: "simulates_all", max: 100, windowMs: HOUR_MS, per: "all" },
  results: { bucket: "results", max: 240, windowMs: HOUR_MS, per: "session" },
  // One poll every 2 seconds for a whole hour; each poll may read Render's API.
  runPoll: { bucket: "run_poll", max: 1800, windowMs: HOUR_MS, per: "session" },
  admin: { bucket: "admin", max: 30, windowMs: HOUR_MS, per: "session" },
  // Claude calls, each request to the model and each tool-runner round, over a rolling
  // day (C20, 6n): per demo session, per demo client address, across every demo session,
  // and for the owner.
  claudeDemoSession: { bucket: "claude_demo_session", max: 40, windowMs: DAY_MS, per: "session" },
  claudeDemoAddress: { bucket: "claude_demo_address", max: 80, windowMs: DAY_MS, per: "address" },
  claudeDemoAll: { bucket: "claude_demo_all", max: 600, windowMs: DAY_MS, per: "all" },
  claudeOwner: { bucket: "claude_owner", max: 2000, windowMs: DAY_MS, per: "all" },
  // The two public Join with PayPal steps, per client address. A person signs in once,
  // so a few retries after a cancel stay well inside 20 a minute.
  joinStart: { bucket: "join_start", max: 20, windowMs: MINUTE_MS, per: "address" },
  joinCallback: { bucket: "join_callback", max: 20, windowMs: MINUTE_MS, per: "address" },
  // The public consent words: each read is an engine run, so one address cannot keep the engine busy.
  joinConsent: { bucket: "join_consent", max: 60, windowMs: MINUTE_MS, per: "address" },
  // PayPal webhook deliveries, counted before the body is read. The address count is
  // taken first, so one flooding address is stopped there and never fills the shared
  // count that PayPal's own deliveries also need.
  webhookAddress: { bucket: "webhook_address", max: 120, windowMs: MINUTE_MS, per: "address" },
  webhookAll: { bucket: "webhook_all", max: 600, windowMs: MINUTE_MS, per: "all" },
  // Calls to PayPal's verify API from anywhere in the app. PayPal's rate limits are
  // shared with Payouts, so traffic nobody has verified yet may spend only this much.
  paypalVerify: { bucket: "paypal_verify_all", max: 60, windowMs: MINUTE_MS, per: "all" },
} as const satisfies Record<string, Limit>;

/** The subject for limits that count every caller together. */
export const GLOBAL = "all";

const LONGEST_WINDOW_MS = Math.max(...Object.values(LIMITS).map((limit) => limit.windowMs));
// Lock keys: the two-number form scopes one lock per bucket and subject; the single
// number lets just one request at a time sweep out rows older than every window.
const HIT_LOCK_CLASS = 773141;
const SWEEP_LOCK = 7731400001;
export const UNKNOWN_ADDRESS = "unknown";
const TAG_HEX_CHARS = 12;
// Marker rows saying "already recorded in this window" live in rate_limit_hits under
// this prefix. Limit buckets are plain lowercase names, so no marker shares their count.
const FIRST_MARKER = "first:";

function ipv6Block(address: string): string {
  const [head, tail = ""] = address.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = address.includes("::") ? (tail === "" ? [] : tail.split(":")) : [];
  const groups = address.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}

/**
 * The address a rate limit counts this request against: the right-most
 * X-Forwarded-For entry, an IPv4 address as written (IPv4-mapped IPv6 unwrapped) or an
 * IPv6 /64 block. Anything that is not an IP address counts as "unknown", and every
 * such request shares that one count.
 */
export function clientAddress(headers: Headers): string {
  const entry = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "";
  const bare = entry.startsWith("[") && entry.endsWith("]") ? entry.slice(1, -1) : entry;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped !== null && isIP(mapped[1]) === 4) return mapped[1];
  if (isIP(bare) === 4) return bare;
  // A dotted tail inside a full IPv6 address is not split into groups here, so such a
  // rare spelling falls to the shared unknown count rather than being misread.
  if (isIP(bare) === 6 && !bare.includes(".") && !bare.includes("%")) return ipv6Block(bare.toLowerCase());
  return UNKNOWN_ADDRESS;
}

function shortTag(text: string): string {
  return createHmac("sha256", csrfSecret()).update(text, "utf8").digest("hex").slice(0, TAG_HEX_CHARS);
}

/**
 * The tag that stands for a client address in logs and the audit log: the first 12 hex
 * characters of HMAC-SHA256(MEND_CSRF_SECRET, address), with address exactly as
 * clientAddress gives it. Whoever holds the secret can check which address a tag stands
 * for; without it the tag says nothing about the address. Throws ConfigError when
 * MEND_CSRF_SECRET is missing or short.
 */
export function addressTag(address: string): string {
  return shortTag(address);
}

/** The same kind of tag for a session id, so one session can be followed through the audit log without its id. */
export function sessionTag(sessionId: string): string {
  return shortTag(sessionId);
}

export type HitResult = { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

// One transaction holding the lock for bucket and subject, so checks on the same pair
// run one at a time.
async function underLock<T>(bucket: string, subject: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1::integer, hashtext($2))", [HIT_LOCK_CLASS, `${bucket}\n${subject}`]);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// True, and the marker written, when no marker for key and subject exists in the last
// windowMs. Runs inside a transaction that already holds the lock for that pair.
async function claimFirst(client: PoolClient, key: string, subject: string, windowMs: number): Promise<boolean> {
  const marker = `${FIRST_MARKER}${key}`;
  const { rows } = await client.query<{ seen: boolean }>(
    "select exists (select 1 from rate_limit_hits where bucket = $1 and subject = $2 and at > now() - make_interval(secs => $3)) as seen",
    [marker, subject, windowMs / 1000],
  );
  if (rows[0].seen) return false;
  await client.query("insert into rate_limit_hits (bucket, subject) values ($1, $2)", [marker, subject]);
  return true;
}

/**
 * True for the first call in windowMs for key and subject, false for each later one
 * until windowMs has passed since the last true, even when calls arrive at once. For
 * records written once a window rather than once a request. Throws a database error.
 */
export async function firstInWindow(key: string, subject: string, windowMs: number): Promise<boolean> {
  return underLock(`${FIRST_MARKER}${key}`, subject, (client) => claimFirst(client, key, subject, windowMs));
}

async function countHit(limit: Limit, subject: string): Promise<{ readonly result: HitResult; readonly firstRefusal: boolean }> {
  return underLock(limit.bucket, subject, async (client) => {
    const sweep = await client.query<{ got: boolean }>("select pg_try_advisory_xact_lock($1) as got", [SWEEP_LOCK]);
    if (sweep.rows[0].got) {
      await client.query("delete from rate_limit_hits where at < now() - make_interval(secs => $1)", [LONGEST_WINDOW_MS / 1000]);
    }
    const { rows } = await client.query<{ n: number; wait: number | null }>(
      `select count(*)::int as n,
              ceil(extract(epoch from min(at) + make_interval(secs => $3) - now()))::int as wait
         from rate_limit_hits where bucket = $1 and subject = $2 and at > now() - make_interval(secs => $3)`,
      [limit.bucket, subject, limit.windowMs / 1000],
    );
    if (rows[0].n >= limit.max) {
      const firstRefusal = await claimFirst(client, `refused:${limit.bucket}`, subject, limit.windowMs);
      return { result: { allowed: false, retryAfterSeconds: Math.max(rows[0].wait ?? 1, 1) }, firstRefusal };
    }
    await client.query("insert into rate_limit_hits (bucket, subject) values ($1, $2)", [limit.bucket, subject]);
    return { result: { allowed: true }, firstRefusal: false };
  });
}

// Best-effort: a tag that cannot be made or a row that cannot be written leaves one log
// line and never changes the refusal.
async function recordLimitHit(limit: Limit, subject: string): Promise<void> {
  let detail: AuditDetail;
  try {
    if (limit.per === "address") detail = { bucket: limit.bucket, per: limit.per, address_tag: addressTag(subject) };
    else if (limit.per === "session") detail = { bucket: limit.bucket, per: limit.per, session_tag: sessionTag(subject) };
    else detail = { bucket: limit.bucket, per: limit.per };
  } catch {
    writeLog({ kind: "audit", outcome: "not_written", action: "rate_limit_hit", reason: "no_tag", bucket: limit.bucket });
    return;
  }
  await appendAudit("rate_limit_hit", detail);
}

/**
 * Count one request against limit for subject. Allowed while fewer than limit.max
 * requests were let through in the last limit.windowMs; a refused request is not
 * counted, so the refusal lifts once the oldest counted request ages out, and
 * retryAfterSeconds says when. The first refusal in each window for this bucket and
 * subject is written to the audit log after the count's own connection is released;
 * that write never changes the answer.
 */
export async function takeHit(limit: Limit, subject: string): Promise<HitResult> {
  const counted = await countHit(limit, subject);
  if (counted.firstRefusal) await recordLimitHit(limit, subject);
  return counted.result;
}
