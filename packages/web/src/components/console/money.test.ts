// Covers the display formatters the console steps share. Does NOT cover how a screen lays
// the results out; that is checked in the browser.
import { describe, expect, it } from "vitest";
import { formatPercent, formatShare, formatUsd, plural, shortHash, utcDay } from "./money";

describe("formatUsd", () => {
  it.each([
    [0, "USD 0.00"],
    [5, "USD 0.05"],
    [200, "USD 2.00"],
    [4821, "USD 48.21"],
    [100_000, "USD 1,000.00"],
    [-150, "-USD 1.50"],
  ])("writes %j cents as %j", (minor, expected) => {
    expect(formatUsd(minor)).toBe(expected);
  });
});

describe("formatShare", () => {
  it.each([
    ["0.05", "5%"],
    ["0.50", "50%"],
    ["0.5", "50%"],
    ["0.10", "10%"],
    ["0.33", "33%"],
    ["0.00", "0%"],
  ])("writes %j as %j", (share, expected) => {
    expect(formatShare(share)).toBe(expected);
  });
});

describe("shortHash", () => {
  const hash = "0123456789abcdef".repeat(4);

  it("keeps the first six and last four characters of a 64-character value", () => {
    expect(hash).toHaveLength(64);
    expect(shortHash(hash)).toBe("012345…cdef");
  });

  it("leaves a value of ten characters or fewer as it is", () => {
    expect(shortHash("abc123")).toBe("abc123");
    expect(shortHash("0123456789")).toBe("0123456789");
  });
});

describe("plural", () => {
  it.each([
    [0, "0 customers"],
    [1, "1 customer"],
    [2, "2 customers"],
    [1357, "1,357 customers"],
  ])("writes %j as %j", (n, expected) => {
    expect(plural(n, "customer", "customers")).toBe(expected);
  });

  it("uses the words it is given", () => {
    expect(plural(1, "payment was", "payments were")).toBe("1 payment was");
    expect(plural(3, "payment was", "payments were")).toBe("3 payments were");
  });
});

describe("formatPercent", () => {
  it.each([
    [0, "0%"],
    [0.2, "20%"],
    [0.0625, "6.3%"],
    [1, "100%"],
    [0.333333, "33.3%"],
  ])("writes %j as %j", (rate, expected) => {
    expect(formatPercent(rate)).toBe(expected);
  });
});

describe("utcDay", () => {
  it("cuts a UTC timestamp to its day", () => {
    expect(utcDay("2026-10-28T10:15:00.000Z")).toBe("2026-10-28");
    expect(utcDay("2026-11-27T23:59:59+00:00")).toBe("2026-11-27");
  });

  it("moves an offset time to the UTC day it falls on", () => {
    expect(utcDay("2026-10-28T01:30:00+05:00")).toBe("2026-10-27");
  });

  it("leaves text that is not a time as it is", () => {
    expect(utcDay("soon")).toBe("soon");
  });
});
