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
 * client shares one count: the limit then errs towards refusing, not allowing.
 */
import { isIP } from "node:net";
import { database } from "./db";

export type Limit = { readonly bucket: string; readonly max: number; readonly windowMs: number };

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Per-session limits count against a session id this server issued. The two "all"
// limits count every caller together (subject GLOBAL), the global cap C20 asks for on
// demo approvals and simulates; the engine's demo pool caps demo spending on top.
export const LIMITS = {
  signIn: { bucket: "sign_in", max: 10, windowMs: 15 * 60 * 1000 },
  demoSession: { bucket: "demo_session", max: 20, windowMs: HOUR_MS },
  draft: { bucket: "draft", max: 20, windowMs: HOUR_MS },
  quietRegulars: { bucket: "quiet_regulars", max: 60, windowMs: HOUR_MS },
  approve: { bucket: "approve", max: 20, windowMs: HOUR_MS },
  demoApprovals: { bucket: "demo_approvals_all", max: 100, windowMs: HOUR_MS },
  submit: { bucket: "submit", max: 10, windowMs: HOUR_MS },
  // Its own count, so pulling rewards back never uses up a session's submits.
  cancelUnclaimed: { bucket: "cancel_unclaimed", max: 10, windowMs: HOUR_MS },
  simulate: { bucket: "simulate", max: 10, windowMs: HOUR_MS },
  simulates: { bucket: "simulates_all", max: 100, windowMs: HOUR_MS },
  results: { bucket: "results", max: 240, windowMs: HOUR_MS },
  // One poll every 2 seconds for a whole hour; each poll may read Render's API.
  runPoll: { bucket: "run_poll", max: 1800, windowMs: HOUR_MS },
  admin: { bucket: "admin", max: 30, windowMs: HOUR_MS },
  // Claude calls, each request to the model and each tool-runner round, over a rolling
  // day (C20, 6n): per demo session, across every demo session, and for the owner.
  claudeDemoSession: { bucket: "claude_demo_session", max: 40, windowMs: DAY_MS },
  claudeDemoAll: { bucket: "claude_demo_all", max: 600, windowMs: DAY_MS },
  claudeOwner: { bucket: "claude_owner", max: 2000, windowMs: DAY_MS },
  // The two public Join with PayPal steps, per client address. A person signs in once,
  // so a few retries after a cancel stay well inside 20 a minute.
  joinStart: { bucket: "join_start", max: 20, windowMs: MINUTE_MS },
  joinCallback: { bucket: "join_callback", max: 20, windowMs: MINUTE_MS },
  // The public consent words: each read is an engine run, so one address cannot keep the engine busy.
  joinConsent: { bucket: "join_consent", max: 60, windowMs: MINUTE_MS },
} as const satisfies Record<string, Limit>;

/** The subject for limits that count every caller together. */
export const GLOBAL = "all";

const LONGEST_WINDOW_MS = Math.max(...Object.values(LIMITS).map((limit) => limit.windowMs));
// Lock keys: the two-number form scopes one lock per bucket and subject; the single
// number lets just one request at a time sweep out rows older than every window.
const HIT_LOCK_CLASS = 773141;
const SWEEP_LOCK = 7731400001;
export const UNKNOWN_ADDRESS = "unknown";

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

export type HitResult = { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * Count one request against limit for subject. Allowed while fewer than limit.max
 * requests were let through in the last limit.windowMs; a refused request is not
 * counted, so the refusal lifts once the oldest counted request ages out, and
 * retryAfterSeconds says when.
 */
export async function takeHit(limit: Limit, subject: string): Promise<HitResult> {
  const client = await database().connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1::integer, hashtext($2))", [HIT_LOCK_CLASS, `${limit.bucket}\n${subject}`]);
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
      await client.query("commit");
      return { allowed: false, retryAfterSeconds: Math.max(rows[0].wait ?? 1, 1) };
    }
    await client.query("insert into rate_limit_hits (bucket, subject) values ($1, $2)", [limit.bucket, subject]);
    await client.query("commit");
    return { allowed: true };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
