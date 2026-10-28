// Covers the in-memory counts for unauthenticated traffic on a clock the test moves: the
// per-address and shared sliding windows, the wait a refusal carries, that a refused
// request is counted nowhere, that one flooding address cannot fill the shared count,
// the first refusal per window, memory that stays bounded, a look at a count that
// changes nothing, the three join routes' counts, once-per-window records, and the cap
// on audit rows per reason a minute with its held-back counts. Does NOT cover: the
// webhook and join routes using them (webhooks.test.ts, join-routes.test.ts), or more
// than one mend-web instance, where each would keep its own counts (a named limit).
import { describe, expect, it } from "vitest";
import { AddressLimiter, AuditRowBudget, JOIN_LIMITS, joinLimits, OncePerWindow, WEBHOOK_LIMITS } from "./address-limits";

function limiterAt(start = 1_000_000) {
  const clock = { now: start };
  return { clock, limiter: new AddressLimiter(WEBHOOK_LIMITS.address, WEBHOOK_LIMITS.all, () => clock.now) };
}

describe("AddressLimiter", () => {
  it("lets 120 requests a minute through from one address and refuses the 121st with the wait until the oldest ages out", () => {
    const { clock, limiter } = limiterAt();
    for (let n = 0; n < 120; n += 1) {
      expect(limiter.take("198.51.100.7").allowed).toBe(true);
      clock.now += 250;
    }
    const refused = limiter.take("198.51.100.7");
    expect(refused).toEqual({ allowed: false, limit: WEBHOOK_LIMITS.address, retryAfterSeconds: 30, firstRefusal: true });
    expect(limiter.take("198.51.100.8").allowed).toBe(true);
    clock.now = 1_000_000 + 60_000;
    expect(limiter.take("198.51.100.7").allowed).toBe(true);
  });

  it("refuses everyone once 600 requests came in within a minute, and lets the next through as the window slides", () => {
    const { clock, limiter } = limiterAt();
    for (let n = 0; n < 600; n += 1) expect(limiter.take(`198.51.${Math.floor(n / 100)}.${n % 100}`).allowed).toBe(true);
    const refused = limiter.take("203.0.113.9");
    expect(!refused.allowed && refused.limit.bucket).toBe("webhook_all");
    clock.now += 60_000;
    expect(limiter.take("203.0.113.9").allowed).toBe(true);
  });

  it("stops a flooding address at its own count, so it never fills the shared one", () => {
    const { limiter } = limiterAt();
    let refused = 0;
    for (let n = 0; n < 5_000; n += 1) if (!limiter.take("203.0.113.9").allowed) refused += 1;
    expect(refused).toBe(5_000 - 120);
    for (let n = 0; n < 480; n += 1) expect(limiter.take(`198.51.100.${n % 200}-${n}`).allowed).toBe(true);
  });

  it("counts a refused request nowhere, so refusals never extend the wait", () => {
    const { clock, limiter } = limiterAt();
    for (let n = 0; n < 120; n += 1) limiter.take("198.51.100.7");
    clock.now += 59_000;
    for (let n = 0; n < 50; n += 1) expect(limiter.take("198.51.100.7").allowed).toBe(false);
    clock.now += 1_000;
    expect(limiter.take("198.51.100.7").allowed).toBe(true);
  });

  it("marks only the first refusal per limit and subject in a minute", () => {
    const { clock, limiter } = limiterAt();
    for (let n = 0; n < 120; n += 1) limiter.take("198.51.100.7");
    const flags = Array.from({ length: 3 }, () => {
      const hit = limiter.take("198.51.100.7");
      return !hit.allowed && hit.firstRefusal;
    });
    expect(flags).toEqual([true, false, false]);
    clock.now += 60_000;
    for (let n = 0; n < 120; n += 1) limiter.take("198.51.100.7");
    const again = limiter.take("198.51.100.7");
    expect(!again.allowed && again.firstRefusal).toBe(true);
  });

  it("keeps memory bounded: only requests let through create entries, and old ones are swept out", () => {
    const { clock, limiter } = limiterAt();
    for (let n = 0; n < 600; n += 1) limiter.take(`10.0.${Math.floor(n / 250)}.${n % 250}`);
    for (let n = 0; n < 10_000; n += 1) limiter.take(`10.1.${Math.floor(n / 250)}.${n % 250}`);
    expect(limiter.trackedAddresses).toBe(600);
    clock.now += 61_000;
    limiter.take("198.51.100.7");
    expect(limiter.trackedAddresses).toBe(1);
  });

  it("says which count is full for an address, with the wait, and counts nothing by looking", () => {
    const { clock, limiter } = limiterAt();
    expect(limiter.full("198.51.100.7")).toBeNull();
    for (let n = 0; n < 120; n += 1) {
      expect(limiter.full("198.51.100.7")).toBeNull();
      limiter.take("198.51.100.7");
      clock.now += 250;
    }
    expect(limiter.full("198.51.100.7")).toEqual({ limit: WEBHOOK_LIMITS.address, retryAfterSeconds: 30 });
    expect(limiter.full("198.51.100.8")).toBeNull();
    const refused = limiter.take("198.51.100.7");
    expect(!refused.allowed && refused.firstRefusal).toBe(true);
    for (let n = 0; n < 480; n += 1) limiter.take(`10.2.0.${n}`);
    expect(limiter.full("198.51.100.8")).toEqual({ limit: WEBHOOK_LIMITS.all, retryAfterSeconds: 30 });
    expect(limiter.trackedAddresses).toBe(481);
  });
});

describe("the join routes' counts", () => {
  it("hold each route to its own count per address in a minute, 20 starts, 20 returns and 60 consent reads, under a shared count for each", () => {
    expect(JOIN_LIMITS).toEqual({
      start: { address: { bucket: "join_start", max: 20, windowMs: 60_000, per: "address" }, all: { bucket: "join_start_all", max: 600, windowMs: 60_000, per: "all" } },
      callback: { address: { bucket: "join_callback", max: 20, windowMs: 60_000, per: "address" }, all: { bucket: "join_callback_all", max: 600, windowMs: 60_000, per: "all" } },
      consent: { address: { bucket: "join_consent", max: 60, windowMs: 60_000, per: "address" }, all: { bucket: "join_consent_all", max: 1200, windowMs: 60_000, per: "all" } },
    });
    for (const limiter of Object.values(joinLimits)) limiter.clear();
    for (let n = 0; n < 20; n += 1) expect(joinLimits.start.take("198.51.100.7").allowed).toBe(true);
    const refused = joinLimits.start.take("198.51.100.7");
    expect(!refused.allowed && refused.limit.bucket === "join_start" && refused.retryAfterSeconds <= 60).toBe(true);
    expect(joinLimits.callback.take("198.51.100.7").allowed).toBe(true);
    expect(joinLimits.start.take("198.51.100.8").allowed).toBe(true);
    for (let n = 0; n < 60; n += 1) expect(joinLimits.consent.take("198.51.100.7").allowed).toBe(true);
    expect(joinLimits.consent.take("198.51.100.7").allowed).toBe(false);
    for (const limiter of Object.values(joinLimits)) limiter.clear();
  });
});

describe("AuditRowBudget", () => {
  it("lets 20 rows per key through a minute, holds back the rest, and reports each window's count once after it ends", () => {
    const clock = { now: 0 };
    const budget = new AuditRowBudget(20, 60_000, () => clock.now);
    const taken = Array.from({ length: 25 }, () => budget.take("webhook_rejected\nmissing_header"));
    expect(taken.filter(Boolean)).toHaveLength(20);
    expect(taken.slice(20)).toEqual([false, false, false, false, false]);
    expect(budget.take("webhook_rejected\nsyntax")).toBe(true);
    expect(budget.due()).toEqual([]);
    expect(budget.nextDueInMs()).toBe(60_000);
    clock.now = 30_000;
    expect(budget.nextDueInMs()).toBe(30_000);
    clock.now = 60_000;
    expect(budget.due()).toEqual([{ key: "webhook_rejected\nmissing_header", held: 5 }]);
    expect(budget.due()).toEqual([]);
    expect(budget.nextDueInMs()).toBeNull();
    expect(budget.take("webhook_rejected\nmissing_header")).toBe(true);
  });

  it("keeps a held-back count when a new window starts before anyone asked for it", () => {
    const clock = { now: 0 };
    const budget = new AuditRowBudget(1, 60_000, () => clock.now);
    expect([budget.take("a"), budget.take("a"), budget.take("a")]).toEqual([true, false, false]);
    clock.now = 61_000;
    expect([budget.take("a"), budget.take("a")]).toEqual([true, false]);
    clock.now = 122_000;
    expect(budget.due()).toEqual([
      { key: "a", held: 2 },
      { key: "a", held: 1 },
    ]);
  });
});

describe("OncePerWindow", () => {
  it("says true once per key per window, and again once the window has passed", () => {
    const clock = { now: 0 };
    const once = new OncePerWindow(60_000, 10_000, () => clock.now);
    expect([once.first("syntax\n198.51.100.7"), once.first("syntax\n198.51.100.7"), once.first("syntax\n198.51.100.8")]).toEqual([true, false, true]);
    clock.now += 59_999;
    expect(once.first("syntax\n198.51.100.7")).toBe(false);
    clock.now += 1;
    expect(once.first("syntax\n198.51.100.7")).toBe(true);
  });

  it("holds at most maxKeys, dropping the oldest", () => {
    const once = new OncePerWindow(60_000, 2, () => 0);
    expect([once.first("a"), once.first("b"), once.first("c"), once.first("a")]).toEqual([true, true, true, true]);
  });
});
