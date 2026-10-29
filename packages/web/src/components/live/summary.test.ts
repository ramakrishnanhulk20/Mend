// Covers the answer schema and the number formatters the landing page uses. Does NOT cover
// the network fetch in useShopSummary.ts or how the charts draw these numbers.
import { describe, expect, it } from "vitest";
import {
  ShopSummarySchema,
  formatCount,
  formatDay,
  formatDifference,
  formatShare,
  formatUsdCompact,
  verdict,
} from "./summary";

const DECILES = [
  [526, 0.9182509505703422],
  [526, 0.7832699619771863],
  [526, 0.623574144486692],
  [526, 0.5209125475285171],
  [526, 0.43346007604562736],
  [526, 0.3403041825095057],
  [525, 0.24761904761904763],
  [525, 0.21904761904761905],
  [525, 0.17142857142857143],
  [525, 0.09523809523809523],
].map(([customers, returnedShare], i) => ({ decile: i + 1, customers, returnedShare }));

function liveAnswer() {
  return {
    asOf: "2026-10-16",
    shopCustomers: 5852,
    membersJoined: 1,
    membersSeeded: 40,
    membersSeededLabel: "demo stand-ins",
    quietRegulars: 1357,
    quietRegularsPaid12mMinor: 149898701,
    currency: "USD",
    benchmark: {
      source: "CDNOW sample, Fader, Hardie and Lee (2005)",
      customers: 2357,
      fitted: { r: 0.2426, alpha: 4.4136, a: 0.7929, b: 2.4259, logLikelihood: -9582.4292 },
      published: { r: 0.243, alpha: 4.414, a: 0.793, b: 2.426, logLikelihood: -9582.4 },
      passed: true,
      computedAt: "2026-10-25T10:32:56.234370+00:00",
    },
    backtest: {
      source: "UCI Online Retail II (Chen 2012, CC BY 4.0)",
      holdoutDays: 91,
      decileCutoff: "2011-09-09",
      deciles: DECILES,
      headline: {
        group: "live segment",
        regularMinDays: 3,
        silentMinDays: 60,
        validCutoffs: 5,
        modelWins: 3,
        meanAucDifference: -0.004645448179286827,
        intervalLow: -0.02403257713445043,
        intervalHigh: 0.01577378542026826,
        cutoffs: [],
      },
      allCustomers: {
        group: "all customers",
        regularMinDays: null,
        silentMinDays: null,
        validCutoffs: 5,
        modelWins: 5,
        meanAucDifference: 0.05242494299104479,
        intervalLow: 0.04767621561048752,
        intervalHigh: 0.05724156533832603,
        cutoffs: [],
      },
      passed: true,
      computedAt: "2026-10-28T07:59:58.819544+00:00",
    },
  };
}

describe("ShopSummarySchema", () => {
  it("accepts the live answer and keeps the fields it does not list", () => {
    const parsed = ShopSummarySchema.safeParse(liveAnswer());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.quietRegulars).toBe(1357);
      expect(parsed.data.backtest?.headline?.group).toBe("live segment");
      expect(parsed.data.backtest).toHaveProperty("computedAt");
    }
  });

  it("rejects a body that has no quietRegulars", () => {
    const body: Record<string, unknown> = liveAnswer();
    delete body.quietRegulars;
    expect(ShopSummarySchema.safeParse(body).success).toBe(false);
  });

  it("accepts null for the benchmark, the backtest and both groups", () => {
    const noProof = { ...liveAnswer(), benchmark: null, backtest: null };
    expect(ShopSummarySchema.safeParse(noProof).success).toBe(true);
    const answer = liveAnswer();
    const noGroups = { ...answer, backtest: { ...answer.backtest, headline: null, allCustomers: null } };
    expect(ShopSummarySchema.safeParse(noGroups).success).toBe(true);
  });

  it("accepts a group whose difference and range were not measured", () => {
    const answer = liveAnswer();
    const unmeasured = {
      ...answer.backtest.headline,
      meanAucDifference: null,
      intervalLow: null,
      intervalHigh: null,
    };
    const body = { ...answer, backtest: { ...answer.backtest, headline: unmeasured } };
    expect(ShopSummarySchema.safeParse(body).success).toBe(true);
  });

  it("rejects a share outside 0 to 1 and a string where a count belongs", () => {
    const answer = liveAnswer();
    const badShare = { ...answer, backtest: { ...answer.backtest, deciles: [{ decile: 1, customers: 5, returnedShare: 1.4 }] } };
    expect(ShopSummarySchema.safeParse(badShare).success).toBe(false);
    expect(ShopSummarySchema.safeParse({ ...answer, quietRegulars: "1357" }).success).toBe(false);
  });
});

describe("formatCount", () => {
  it("puts a comma in thousands", () => {
    expect(formatCount(1357)).toBe("1,357");
    expect(formatCount(5852)).toBe("5,852");
    expect(formatCount(12)).toBe("12");
    expect(formatCount(0)).toBe("0");
  });
});

describe("formatUsdCompact", () => {
  it("writes millions and thousands with one decimal", () => {
    expect(formatUsdCompact(149898701)).toBe("USD 1.5M");
    expect(formatUsdCompact(123456)).toBe("USD 1.2K");
  });

  it("writes whole dollars under a thousand", () => {
    expect(formatUsdCompact(98000)).toBe("USD 980");
    expect(formatUsdCompact(0)).toBe("USD 0");
  });

  it("drops a trailing .0", () => {
    expect(formatUsdCompact(200000000)).toBe("USD 2M");
    expect(formatUsdCompact(300000)).toBe("USD 3K");
  });

  it("moves up a unit instead of printing 1000K or USD 1000", () => {
    expect(formatUsdCompact(99996000)).toBe("USD 1M");
    expect(formatUsdCompact(99960)).toBe("USD 1K");
  });
});

describe("formatShare", () => {
  it("rounds to a whole percent", () => {
    expect(formatShare(0.918)).toBe("92%");
    expect(formatShare(0.095)).toBe("10%");
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(1)).toBe("100%");
  });
});

describe("formatDifference", () => {
  it("writes a plus sign, three decimals and a true minus sign", () => {
    expect(formatDifference(0.0524)).toBe("+0.052");
    expect(formatDifference(-0.0046)).toBe("−0.005");
  });

  it("writes zero with no sign", () => {
    expect(formatDifference(0)).toBe("0.000");
  });

  it("writes a difference that rounds to zero with no sign", () => {
    expect(formatDifference(-0.0001)).toBe("0.000");
    expect(formatDifference(0.0004)).toBe("0.000");
  });
});

describe("verdict", () => {
  it("is better when the whole range is above zero", () => {
    expect(verdict(0.01, 0.05)).toBe("better");
  });

  it("is worse when the whole range is below zero", () => {
    expect(verdict(-0.05, -0.01)).toBe("worse");
  });

  it("is a tie when the range crosses zero", () => {
    expect(verdict(-0.02, 0.02)).toBe("tie");
    expect(verdict(0, 0.02)).toBe("tie");
    expect(verdict(-0.02, 0)).toBe("tie");
  });

  it("is unknown when either end is missing", () => {
    expect(verdict(null, 0.1)).toBe("unknown");
    expect(verdict(0.1, null)).toBe("unknown");
    expect(verdict(null, null)).toBe("unknown");
  });
});

describe("formatDay", () => {
  it("writes day, short month and year", () => {
    expect(formatDay("2011-09-09")).toBe("9 Sep 2011");
    expect(formatDay("2026-10-16")).toBe("16 Oct 2026");
    expect(formatDay("2010-01-01")).toBe("1 Jan 2010");
  });

  it("hands back text it cannot read instead of guessing", () => {
    expect(formatDay("soon")).toBe("soon");
    expect(formatDay("2011-13-09")).toBe("2011-13-09");
  });
});
