/**
 * Counts kept in this process's memory for traffic nobody has authenticated (C20): the
 * PayPal webhook, which anyone can post to, and the three public Join with PayPal
 * routes. None of them writes a rate_limit_hits row, so traffic from people who never
 * signed in cannot fill the database, and a flood is turned away without spending a
 * database connection that signed-in visitors and PayPal's genuine deliveries need.
 *
 * Each count is a sliding window: the times of the requests counted in the last window,
 * oldest first. A refused request is not counted, and the address count is taken first,
 * so one flooding address is stopped there and never fills the count shared by everyone.
 * Only counted requests create an entry, so memory is bounded by the shared count;
 * entries older than the window are swept out once a window.
 *
 * Also here: the cap on audit rows (C23) that unauthenticated or refused traffic can
 * cause, at most 20 per reason a minute across the process, with the count of rows held
 * back past that kept for one summary row per reason a minute.
 *
 * Covers one address flooding, and any flood beyond the shared count. Render runs one
 * mend-web instance, so one process sees every request; with more instances each would
 * keep its own counts and the limits would multiply by the instance count. Does not
 * cover a flood spread over many addresses under the shared count. Counts start again
 * from zero when the process restarts.
 */
import type { Limit } from "./ratelimit";

const MINUTE_MS = 60 * 1000;

/**
 * Webhook requests a minute, charged only for deliveries that are rejected (webhooks.ts):
 * 120 per client address inside 600 for the process.
 */
export const WEBHOOK_LIMITS = {
  address: { bucket: "webhook_address", max: 120, windowMs: MINUTE_MS, per: "address" },
  all: { bucket: "webhook_all", max: 600, windowMs: MINUTE_MS, per: "all" },
} as const satisfies Record<"address" | "all", Limit>;

// A person joins or leaves once, so a few retries after a cancel stay well inside 20 a
// minute. Each consent read and each start is an engine run, so the shared counts also
// bound what many addresses together can ask of the engine; past one, joins pause for
// at most a minute.
export const JOIN_LIMITS = {
  start: {
    address: { bucket: "join_start", max: 20, windowMs: MINUTE_MS, per: "address" },
    all: { bucket: "join_start_all", max: 600, windowMs: MINUTE_MS, per: "all" },
  },
  callback: {
    address: { bucket: "join_callback", max: 20, windowMs: MINUTE_MS, per: "address" },
    all: { bucket: "join_callback_all", max: 600, windowMs: MINUTE_MS, per: "all" },
  },
  consent: {
    address: { bucket: "join_consent", max: 60, windowMs: MINUTE_MS, per: "address" },
    all: { bucket: "join_consent_all", max: 1200, windowMs: MINUTE_MS, per: "all" },
  },
} as const satisfies Record<string, Record<"address" | "all", Limit>>;

type Clock = () => number;

/**
 * What one request may do: go ahead, or wait retryAfterSeconds because limit is full.
 * firstRefusal is true for the first refusal by that limit for that subject in a window,
 * the one worth an audit row.
 */
export type MemoryHit =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly limit: Limit; readonly retryAfterSeconds: number; readonly firstRefusal: boolean };

/** A count that is full, and the seconds until it would let one more through. */
export type FullCount = { readonly limit: Limit; readonly retryAfterSeconds: number };

/** Remembers which keys were seen in the last window, so a record can be written once per key per window. */
export class OncePerWindow {
  // A key is set only when first seen in a window, so insertion order is time order and
  // the expired keys are always at the front.
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
    private readonly now: Clock = () => Date.now(),
  ) {}

  /** True for the first call for key, then false until windowMs has passed since that true. */
  first(key: string): boolean {
    const now = this.now();
    for (const [old, at] of this.seen) {
      if (now - at < this.windowMs) break;
      this.seen.delete(old);
    }
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.maxKeys) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    this.seen.set(key, now);
    return true;
  }

  /** Forget every key. */
  clear(): void {
    this.seen.clear();
  }
}

function dropOlder(times: number[], cutoff: number): void {
  let stale = 0;
  while (stale < times.length && times[stale] <= cutoff) stale += 1;
  if (stale > 0) times.splice(0, stale);
}

function waitSeconds(oldest: number, windowMs: number, now: number): number {
  return Math.max(Math.ceil((oldest + windowMs - now) / 1000), 1);
}

/** A sliding count per client address and one across every address, both in memory. */
export class AddressLimiter {
  private readonly addresses = new Map<string, number[]>();
  private readonly everyone: number[] = [];
  private readonly refusals: OncePerWindow;
  private lastSweep: number;

  constructor(
    private readonly perAddress: Limit,
    private readonly overall: Limit,
    private readonly now: Clock = () => Date.now(),
  ) {
    this.refusals = new OncePerWindow(Math.max(perAddress.windowMs, overall.windowMs), 10_000, now);
    this.lastSweep = now();
  }

  /**
   * Count one request from address, or refuse it with the wait until it could pass: once
   * this address had perAddress.max requests counted in its window, or everyone together
   * overall.max. A refused request is counted nowhere.
   */
  take(address: string): MemoryHit {
    const now = this.now();
    const full = this.fullAt(address, now);
    if (full !== null) {
      const subject = full.limit === this.perAddress ? address : "";
      return { allowed: false, ...full, firstRefusal: this.refusals.first(`${full.limit.bucket}\n${subject}`) };
    }
    const mine = this.addresses.get(address) ?? [];
    mine.push(now);
    this.everyone.push(now);
    this.addresses.set(address, mine);
    return { allowed: true };
  }

  /** The count that would refuse a request from address now, or null when it would be counted. Counts and records nothing. */
  full(address: string): FullCount | null {
    return this.fullAt(address, this.now());
  }

  /** How many addresses have an entry, for checking that memory stays bounded. */
  get trackedAddresses(): number {
    return this.addresses.size;
  }

  /** Forget every count. */
  clear(): void {
    this.addresses.clear();
    this.everyone.length = 0;
    this.refusals.clear();
  }

  private fullAt(address: string, now: number): FullCount | null {
    this.sweep(now);
    const mine = this.addresses.get(address);
    if (mine !== undefined) dropOlder(mine, now - this.perAddress.windowMs);
    dropOlder(this.everyone, now - this.overall.windowMs);
    if (mine !== undefined && mine.length >= this.perAddress.max) {
      return { limit: this.perAddress, retryAfterSeconds: waitSeconds(mine[0], this.perAddress.windowMs, now) };
    }
    if (this.everyone.length >= this.overall.max) {
      return { limit: this.overall, retryAfterSeconds: waitSeconds(this.everyone[0], this.overall.windowMs, now) };
    }
    return null;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.perAddress.windowMs) return;
    this.lastSweep = now;
    for (const [address, times] of this.addresses) {
      if (times.length === 0 || times[times.length - 1] <= now - this.perAddress.windowMs) this.addresses.delete(address);
    }
  }
}

/** A key's rows held back in one window that has ended. */
export type HeldBack = { readonly key: string; readonly held: number };

type RowWindow = { readonly start: number; written: number; held: number };

/**
 * At most max audit rows per key in each window of windowMs, a window starting with the
 * key's first row; rows past that are held back and counted, and each window's count is
 * handed out once, after the window ends, for one summary row. Keys are reason codes the
 * code chose, so there are few; past maxKeys the oldest window is closed early and its
 * count kept.
 */
export class AuditRowBudget {
  private readonly windows = new Map<string, RowWindow>();
  private readonly ended: HeldBack[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: Clock = () => Date.now(),
    private readonly maxKeys = 1000,
  ) {}

  /** True when a row for key may be written now; otherwise false, and the row is counted as held back. */
  take(key: string): boolean {
    const now = this.now();
    let window = this.windows.get(key);
    if (window !== undefined && now - window.start >= this.windowMs) {
      this.close(key, window);
      window = undefined;
    }
    if (window === undefined) {
      if (this.windows.size >= this.maxKeys) {
        const oldest = this.windows.entries().next();
        if (!oldest.done) this.close(oldest.value[0], oldest.value[1]);
      }
      window = { start: now, written: 0, held: 0 };
      this.windows.set(key, window);
    }
    if (window.written < this.max) {
      window.written += 1;
      return true;
    }
    window.held += 1;
    return false;
  }

  /** Every held-back count from windows that have ended, oldest first, each handed out once. */
  due(): HeldBack[] {
    const now = this.now();
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.close(key, window);
    }
    return this.ended.splice(0, this.ended.length);
  }

  /** Milliseconds until the earliest window holding rows back ends (0 when one already has), or null when none holds any. */
  nextDueInMs(): number | null {
    if (this.ended.length > 0) return 0;
    const now = this.now();
    let soonest: number | null = null;
    for (const window of this.windows.values()) {
      if (window.held === 0) continue;
      const wait = Math.max(window.start + this.windowMs - now, 0);
      soonest = soonest === null ? wait : Math.min(soonest, wait);
    }
    return soonest;
  }

  /** Forget every window and every held-back count. */
  clear(): void {
    this.windows.clear();
    this.ended.length = 0;
  }

  private close(key: string, window: RowWindow): void {
    this.windows.delete(key);
    if (window.held > 0) this.ended.push({ key, held: window.held });
  }
}

/** The webhook route's counts: 120 rejected requests a minute per client address, 600 from everyone. */
export const webhookLimits = new AddressLimiter(WEBHOOK_LIMITS.address, WEBHOOK_LIMITS.all);

/** Rejected webhook requests already on the audit record this minute, by reason and address. */
export const webhookRejections = new OncePerWindow(MINUTE_MS);

/** The join routes' counts, one per route; GET and POST of the start route share theirs. */
export const joinLimits = {
  start: new AddressLimiter(JOIN_LIMITS.start.address, JOIN_LIMITS.start.all),
  callback: new AddressLimiter(JOIN_LIMITS.callback.address, JOIN_LIMITS.callback.all),
  consent: new AddressLimiter(JOIN_LIMITS.consent.address, JOIN_LIMITS.consent.all),
} as const;

export const AUDIT_ROWS_PER_MINUTE = 20;

// Every route writes through this one budget, and Next.js may load this module once per
// route bundle, so it lives on globalThis to be one count for the whole process.
const BUDGET_KEY = Symbol.for("mend.audit.rows");
const budgetHolder = globalThis as typeof globalThis & { [BUDGET_KEY]?: AuditRowBudget };

/** Audit rows per reason a minute across the process (C23): webhook rejections and first refusals by a limit. */
export const auditRows: AuditRowBudget = (budgetHolder[BUDGET_KEY] ??= new AuditRowBudget(AUDIT_ROWS_PER_MINUTE, MINUTE_MS));
