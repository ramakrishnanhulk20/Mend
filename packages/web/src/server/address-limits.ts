/**
 * Counts kept in this process's memory for traffic nobody has authenticated yet (C20):
 * the PayPal webhook, which anyone can post to. They are taken before the body is read
 * or any database query runs, so a flood is turned away without spending a database
 * connection that signed-in visitors and PayPal's genuine deliveries need.
 *
 * Each count is a sliding window: the times of the requests let through in the last
 * window, oldest first. A refused request is not counted, and the address count is taken
 * first, so one flooding address is stopped there and never fills the count shared by
 * everyone. Only requests let through create an entry, so memory is bounded by the
 * shared count; entries older than the window are swept out once a window.
 *
 * Covers one address flooding, and any flood beyond the shared count. Render runs one
 * mend-web instance, so one process sees every request; with more instances each would
 * keep its own counts and the limits would multiply by the instance count. Does not
 * cover a flood spread over many addresses under the shared count, which delays genuine
 * deliveries (PayPal retries anything not answered 2xx) but spends nothing else. Counts
 * start again from zero when the process restarts.
 */
import type { Limit } from "./ratelimit";

const MINUTE_MS = 60 * 1000;

export const WEBHOOK_LIMITS = {
  address: { bucket: "webhook_address", max: 120, windowMs: MINUTE_MS, per: "address" },
  all: { bucket: "webhook_all", max: 600, windowMs: MINUTE_MS, per: "all" },
} as const satisfies Record<"address" | "all", Limit>;

type Clock = () => number;

/**
 * What one request may do: go ahead, or wait retryAfterSeconds because limit is full.
 * firstRefusal is true for the first refusal by that limit for that subject in a window,
 * the one worth an audit row.
 */
export type MemoryHit =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly limit: Limit; readonly retryAfterSeconds: number; readonly firstRefusal: boolean };

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
   * this address had perAddress.max requests let through in its window, or everyone
   * together overall.max. A refused request is counted nowhere.
   */
  take(address: string): MemoryHit {
    const now = this.now();
    this.sweep(now);
    const mine = this.addresses.get(address) ?? [];
    dropOlder(mine, now - this.perAddress.windowMs);
    dropOlder(this.everyone, now - this.overall.windowMs);
    if (mine.length >= this.perAddress.max) return this.refuse(this.perAddress, address, mine[0], now);
    if (this.everyone.length >= this.overall.max) return this.refuse(this.overall, "", this.everyone[0], now);
    mine.push(now);
    this.everyone.push(now);
    this.addresses.set(address, mine);
    return { allowed: true };
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

  private refuse(limit: Limit, subject: string, oldest: number, now: number): MemoryHit {
    const firstRefusal = this.refusals.first(`${limit.bucket}\n${subject}`);
    return { allowed: false, limit, retryAfterSeconds: waitSeconds(oldest, limit.windowMs, now), firstRefusal };
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.perAddress.windowMs) return;
    this.lastSweep = now;
    for (const [address, times] of this.addresses) {
      if (times.length === 0 || times[times.length - 1] <= now - this.perAddress.windowMs) this.addresses.delete(address);
    }
  }
}

/** The webhook route's counts: 120 requests a minute per client address, 600 from everyone. */
export const webhookLimits = new AddressLimiter(WEBHOOK_LIMITS.address, WEBHOOK_LIMITS.all);

/** Rejected webhook requests already on the audit record this minute, by reason and address. */
export const webhookRejections = new OncePerWindow(MINUTE_MS);
