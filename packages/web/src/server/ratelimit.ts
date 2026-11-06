/**
 * Rate limits counted in Postgres (C18, C20), on things the caller cannot choose: the
 * client address the platform saw, or a session id this server issued. The webhook and
 * the public join routes, which anyone can call, are counted in memory instead
 * (address-limits.ts), so that traffic nobody has authenticated never writes a row here.
 * Each bucket's rows are swept out once older than that bucket's own window, so the
 * table holds only rows that still count.
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
 * log (C23), best-effort, with a short tag in place of the address or session id, and
 * at most 20 such rows per bucket a minute across the process (appendCappedAudit).
 */
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { PoolClient } from "pg";
import { auditRows } from "./address-limits";
import { appendAudit, type AuditDetail } from "./audit";
import { csrfSecret } from "./csrf";
import { database } from "./db";
import { writeLog } from "./log";

/** What a limit counts on: one client address, one session this server issued, or every caller together. */
export type Per = "address" | "session" | "all";

/**
 * A count of max requests in a sliding window. keptForNewSessions, on a pool shared by
 * every demo visitor: the last that many of max are kept for sessions that have not drawn
 * on the pool in the current window. keptDraws: how many draws a session may make before it
 * stops counting as new, 1 when unset. A pool whose work comes in steps sets it to one whole
 * job, so a visitor let in at the keep line can finish instead of stopping after one step.
 */
export type Limit = { readonly bucket: string; readonly max: number; readonly windowMs: number; readonly per: Per; readonly keptForNewSessions?: number; readonly keptDraws?: number };

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Per-session limits count against a session id this server issued, per-address ones
// against clientAddress. The "all" limits count every caller together (subject GLOBAL),
// the global caps C20 asks for on demo Claude calls, demo approvals and simulates; the
// engine's demo pool caps demo spending on top. Each shared demo pool keeps its last part
// for sessions that have not drawn on it in the window, at least one draw for every session
// an address can hold open, and has a per-address share, so no one address can close a
// whole pool, and no pool counts over more than an hour, so a pool many addresses fill
// opens again within the hour (ratelimit.test.ts checks both from these numbers). Where a
// route takes several, the narrowest is taken first, so a caller stopped there never fills
// a wider count.
export const LIMITS = {
  signIn: { bucket: "sign_in", max: 10, windowMs: 15 * 60 * 1000, per: "address" },
  // Each demo session opens a fresh set of per-session counts, so the number one address
  // may start is what keeps a single visitor from taking every demo's share.
  demoSession: { bucket: "demo_session", max: 4, windowMs: HOUR_MS, per: "address" },
  demoSessionDay: { bucket: "demo_session_day", max: 10, windowMs: DAY_MS, per: "address" },
  draft: { bucket: "draft", max: 20, windowMs: HOUR_MS, per: "session" },
  quietRegulars: { bucket: "quiet_regulars", max: 60, windowMs: HOUR_MS, per: "session" },
  // Each view is an engine run that rebuilds the campaign, so one session cannot keep the engine busy.
  viewCampaign: { bucket: "view_campaign", max: 60, windowMs: HOUR_MS, per: "session" },
  approve: { bucket: "approve", max: 20, windowMs: HOUR_MS, per: "session" },
  demoApprovalsAddress: { bucket: "demo_approvals_address", max: 10, windowMs: HOUR_MS, per: "address" },
  demoApprovals: { bucket: "demo_approvals_all", max: 100, windowMs: HOUR_MS, per: "all", keptForNewSessions: 20 },
  submit: { bucket: "submit", max: 10, windowMs: HOUR_MS, per: "session" },
  // Demo submits per client address over a rolling day: at the engine's 1000-cent demo
  // campaign cap, 4 send at most 4000 cents, under the 5000-cent daily demo pool, so one
  // address always leaves room for the next visitor.
  demoSubmitsAddress: { bucket: "demo_submits_address", max: 4, windowMs: DAY_MS, per: "address" },
  // Its own count, so pulling rewards back never uses up a session's submits.
  cancelUnclaimed: { bucket: "cancel_unclaimed", max: 10, windowMs: HOUR_MS, per: "session" },
  simulate: { bucket: "simulate", max: 10, windowMs: HOUR_MS, per: "session" },
  simulateAddress: { bucket: "simulate_address", max: 10, windowMs: HOUR_MS, per: "address" },
  simulates: { bucket: "simulates_all", max: 100, windowMs: HOUR_MS, per: "all", keptForNewSessions: 20 },
  results: { bucket: "results", max: 240, windowMs: HOUR_MS, per: "session" },
  // One poll every 2 seconds for a whole hour; each poll may read Render's API.
  runPoll: { bucket: "run_poll", max: 1800, windowMs: HOUR_MS, per: "session" },
  admin: { bucket: "admin", max: 30, windowMs: HOUR_MS, per: "session" },
  // Claude calls, each request to the model and each tool-runner round (C20, 6n): per
  // demo session and per demo client address over a rolling day, across every demo
  // session over an hour, so a pool filled by many addresses opens again within the hour,
  // and for the owner over a day.
  claudeDemoSession: { bucket: "claude_demo_session", max: 40, windowMs: DAY_MS, per: "session" },
  claudeDemoAddress: { bucket: "claude_demo_address", max: 80, windowMs: DAY_MS, per: "address" },
  claudeDemoAll: { bucket: "claude_demo_all", max: 50, windowMs: HOUR_MS, per: "all", keptForNewSessions: 10 },
  // One dashboard question takes 4 to 10 calls, so the dashboard's agents draw on counts of
  // their own at every level, and a visitor chatting with them can never stop the next one
  // drafting a plan. keptDraws is one whole question, so a visitor let in at the keep line
  // gets an answer rather than being refused on the second round.
  claudeStudioSession: { bucket: "claude_studio_session", max: 30, windowMs: DAY_MS, per: "session" },
  claudeStudioSessionHour: { bucket: "claude_studio_session_hour", max: 24, windowMs: HOUR_MS, per: "session" },
  claudeStudioAddress: { bucket: "claude_studio_address", max: 60, windowMs: DAY_MS, per: "address" },
  claudeStudioAll: { bucket: "claude_studio_all", max: 120, windowMs: HOUR_MS, per: "all", keptForNewSessions: 20, keptDraws: 10 },
  claudeOwner: { bucket: "claude_owner", max: 2000, windowMs: DAY_MS, per: "all" },
} as const satisfies Record<string, Limit>;

/** The subject for limits that count every caller together. */
export const GLOBAL = "all";

// Lock keys: the two-number form scopes one lock per bucket and subject; the single
// number lets just one request at a time sweep out rows that no longer count.
const HIT_LOCK_CLASS = 773141;
const SWEEP_LOCK = 7731400001;
export const UNKNOWN_ADDRESS = "unknown";
const TAG_HEX_CHARS = 12;
// Marker rows saying "already recorded in this window" live in rate_limit_hits under
// this prefix. Limit buckets are plain lowercase names, so no marker shares their count.
const FIRST_MARKER = "first:";
const REFUSED_KEY = "refused:";

// What the sweep keeps: each bucket's rows, and its first-refusal marker, for that
// bucket's own window; a row under any other name, such as a bucket since removed, for
// the longest window. Built from LIMITS, so a new limit is swept without a list to keep.
const WINDOWS = Object.values(LIMITS).flatMap((limit: Limit) => [
  [limit.bucket, limit.windowMs],
  [`${FIRST_MARKER}${REFUSED_KEY}${limit.bucket}`, limit.windowMs],
] as const);
const SWEEP_BUCKETS = WINDOWS.map(([bucket]) => bucket);
const SWEEP_SECONDS = WINDOWS.map(([, windowMs]) => windowMs / 1000);
const SHORTEST_WINDOW_MS = Math.min(...WINDOWS.map(([, windowMs]) => windowMs));
const LONGEST_WINDOW_MS = Math.max(...WINDOWS.map(([, windowMs]) => windowMs));
// The first condition lets the at index skip every row still inside the shortest window.
const SWEEP_SQL = `delete from rate_limit_hits h
  where h.at < now() - make_interval(secs => $3)
    and h.at < now() - make_interval(secs => coalesce(
          (select w.secs from unnest($1::text[], $2::float8[]) as w(bucket, secs) where w.bucket = h.bucket), $4))`;

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

// One request at a time across every process deletes the rows that no longer count; a
// request that finds the sweep taken skips it.
async function sweep(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ got: boolean }>("select pg_try_advisory_xact_lock($1) as got", [SWEEP_LOCK]);
  if (!rows[0].got) return;
  await client.query(SWEEP_SQL, [SWEEP_BUCKETS, SWEEP_SECONDS, SHORTEST_WINDOW_MS / 1000, LONGEST_WINDOW_MS / 1000]);
}

/** For a pool every caller shares: the session drawing on it, which decides whether the pool's kept part is open to it. */
export type Draw = { readonly session?: string };

// The rows a limit counts. A pool's rows carry the session that drew each one (or
// GLOBAL when the caller named none), so a pool counts every subject and still knows
// who drew; any other limit counts its own subject's rows.
const COUNTED = "bucket = $1 and ($2 or subject = $3) and at > now() - make_interval(secs => $4)";

async function countHit(limit: Limit, subject: string, session: string | null): Promise<{ readonly result: HitResult; readonly firstRefusal: boolean }> {
  const pooled = limit.per === "all";
  const lockSubject = pooled ? GLOBAL : subject;
  const counted = [limit.bucket, pooled, subject, limit.windowMs / 1000];
  return underLock(limit.bucket, lockSubject, async (client) => {
    await sweep(client);
    const { rows } = await client.query<{ n: number; drawn: number }>(
      `select count(*)::int as n, (count(*) filter (where subject = $5))::int as drawn from rate_limit_hits where ${COUNTED}`,
      [...counted, session ?? GLOBAL],
    );
    const { n, drawn } = rows[0];
    const kept = limit.keptForNewSessions ?? 0;
    // A caller naming no session cannot show it is new, so the kept part is closed to it.
    const closedAt = kept > 0 && (session === null || drawn >= (limit.keptDraws ?? 1)) ? limit.max - kept : limit.max;
    if (n >= closedAt) {
      // The refusal lifts once enough of the oldest counted rows age out to bring n below closedAt.
      const { rows: waits } = await client.query<{ wait: number | null }>(
        `select ceil(extract(epoch from at + make_interval(secs => $4) - now()))::int as wait
           from rate_limit_hits where ${COUNTED} order by at offset $5 limit 1`,
        [...counted, n - closedAt],
      );
      const firstRefusal = await claimFirst(client, `${REFUSED_KEY}${limit.bucket}`, lockSubject, limit.windowMs);
      return { result: { allowed: false, retryAfterSeconds: Math.max(waits[0]?.wait ?? 1, 1) }, firstRefusal };
    }
    await client.query("insert into rate_limit_hits (bucket, subject) values ($1, $2)", [limit.bucket, pooled ? (session ?? GLOBAL) : subject]);
    return { result: { allowed: true }, firstRefusal: false };
  });
}

// Fires once the earliest minute holding rows back has ended, so its summary row is
// written even when no further row is asked for. unref: it never keeps the process up.
let suppressedTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSuppressedAudit(): void {
  if (suppressedTimer !== null) return;
  const wait = auditRows.nextDueInMs();
  if (wait === null) return;
  suppressedTimer = setTimeout(() => {
    suppressedTimer = null;
    void writeSuppressedAudit().then(scheduleSuppressedAudit);
  }, wait + 1000);
  suppressedTimer.unref();
}

/**
 * One audit_rows_suppressed row, detail {action, reason, suppressed}, for each action and
 * reason whose minute has ended with rows held back by appendCappedAudit, each minute
 * written once. Never throws: a row that cannot be written leaves one log line.
 */
export async function writeSuppressedAudit(): Promise<void> {
  for (const { key, held } of auditRows.due()) {
    const [action, reason] = key.split("\n");
    await appendAudit("audit_rows_suppressed", { action, reason, suppressed: held });
  }
}

/**
 * Append one audit row for action with detail, unless 20 rows for this action and reason
 * were already written this minute across the process (C23, C20): past that the row is
 * held back and counted, and one audit_rows_suppressed row holds the count once the
 * minute ends. reason is a code the caller chose, such as a bucket name or a rejection
 * reason. Best-effort, like appendAudit without a client: never throws.
 */
export async function appendCappedAudit(action: string, reason: string, detail: AuditDetail): Promise<void> {
  await writeSuppressedAudit();
  if (auditRows.take(`${action}\n${reason}`)) {
    await appendAudit(action, detail);
    return;
  }
  scheduleSuppressedAudit();
}

/**
 * The audit row for a refusal by limit for subject: the bucket, and the address or
 * session tag for a per-address or per-session limit, at most 20 per bucket a minute
 * (appendCappedAudit). Best-effort: a tag that cannot be made or a row that cannot be
 * written leaves one log line and never changes the refusal.
 */
export async function recordLimitHit(limit: Limit, subject: string): Promise<void> {
  let detail: AuditDetail;
  try {
    if (limit.per === "address") detail = { bucket: limit.bucket, per: limit.per, address_tag: addressTag(subject) };
    else if (limit.per === "session") detail = { bucket: limit.bucket, per: limit.per, session_tag: sessionTag(subject) };
    else detail = { bucket: limit.bucket, per: limit.per };
  } catch {
    writeLog({ kind: "audit", outcome: "not_written", action: "rate_limit_hit", reason: "no_tag", bucket: limit.bucket });
    return;
  }
  await appendCappedAudit("rate_limit_hit", limit.bucket, detail);
}

/**
 * Record a refusal by one of the in-memory counts (address-limits.ts) the way takeHit
 * records its own: only the first by that limit for that subject in a window, with the
 * address tag for a per-address limit. Writes nothing to rate_limit_hits.
 */
export async function recordMemoryRefusal(hit: { readonly limit: Limit; readonly firstRefusal: boolean }, address: string): Promise<void> {
  if (hit.firstRefusal) await recordLimitHit(hit.limit, hit.limit.per === "address" ? address : GLOBAL);
}

/**
 * Count one request against limit for subject. Allowed while fewer than limit.max
 * requests were let through in the last limit.windowMs; a refused request is not
 * counted, so the refusal lifts once enough counted requests age out, and
 * retryAfterSeconds says when. For a pool every caller shares (per "all", subject
 * GLOBAL), draw.session names the session drawing: once the pool holds max minus
 * keptForNewSessions, only a session with fewer than keptDraws draws on it in the window
 * may take one of the kept part, and a call naming no session may not. The first refusal in each window
 * for this bucket and subject is written to the audit log after the count's own
 * connection is released; that write never changes the answer.
 */
export async function takeHit(limit: Limit, subject: string, draw: Draw = {}): Promise<HitResult> {
  const counted = await countHit(limit, subject, draw.session ?? null);
  if (counted.firstRefusal) await recordLimitHit(limit, subject);
  return counted.result;
}

/**
 * Give back one request counted against limit for subject in its window, the most
 * recent, as if it had never been counted; for a pool, the latest draw by
 * draw.session. For a request whose work turned out to cost nothing, such as an engine
 * answer of not_found. Does nothing when there is none to give back.
 */
export async function returnHit(limit: Limit, subject: string, draw: Draw = {}): Promise<void> {
  const pooled = limit.per === "all";
  await underLock(limit.bucket, pooled ? GLOBAL : subject, async (client) => {
    await client.query(
      `delete from rate_limit_hits where ctid = (
         select ctid from rate_limit_hits
          where bucket = $1 and subject = $2 and at > now() - make_interval(secs => $3)
          order by at desc limit 1)`,
      [limit.bucket, pooled ? (draw.session ?? GLOBAL) : subject, limit.windowMs / 1000],
    );
  });
}
