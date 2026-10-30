import { z } from "zod";

const count = z.number().int().min(0);

const modelParameters = z.looseObject({
  r: z.number(),
  alpha: z.number(),
  a: z.number(),
  b: z.number(),
  logLikelihood: z.number(),
});

// The engine writes null where a group was too small to measure, so a difference and its
// range can each be null and the page says "not measured" instead of drawing a stand-in.
const measuredGroup = z.looseObject({
  group: z.string(),
  modelWins: count,
  validCutoffs: count,
  meanAucDifference: z.number().nullable(),
  intervalLow: z.number().nullable(),
  intervalHigh: z.number().nullable(),
});

const bandCount = z.looseObject({ customers: count, returned: count });

// A cutoff the model did not converge at has no group counts, so each is null there.
const forecastBands = z.looseObject({
  likelyGoneBelow: z.number(),
  likelyBackFrom: z.number(),
  regularMinDays: z.number(),
  silentMinDays: z.number(),
  horizonWeeks: z.number(),
  pooled: z.looseObject({ likelyGone: bandCount, worthANudge: bandCount, likelyBack: bandCount }),
  rising: z.boolean(),
  cutoffs: z.array(
    z.looseObject({
      cutoff: z.string(),
      converged: z.boolean(),
      likelyGone: bandCount.nullable(),
      worthANudge: bandCount.nullable(),
      likelyBack: bandCount.nullable(),
    }),
  ),
});

export const ShopSummarySchema = z.looseObject({
  asOf: z.string().nullable(),
  shopCustomers: count,
  membersJoined: count,
  membersSeeded: count,
  membersSeededLabel: z.string(),
  quietRegulars: count,
  quietRegularsPaid12mMinor: count,
  currency: z.string(),
  benchmark: z
    .looseObject({
      source: z.string(),
      customers: count,
      fitted: modelParameters,
      published: modelParameters,
      passed: z.boolean(),
      computedAt: z.string(),
    })
    .nullable(),
  backtest: z
    .looseObject({
      source: z.string(),
      holdoutDays: count,
      decileCutoff: z.string().nullable(),
      deciles: z.array(
        z.looseObject({
          decile: z.number().int().min(1).max(10),
          customers: count,
          returnedShare: z.number().min(0).max(1),
        }),
      ),
      headline: measuredGroup.nullable(),
      allCustomers: measuredGroup.nullable(),
      passed: z.boolean(),
      computedAt: z.string(),
      // A summary stored before the forecast groups were measured has none.
      bands: forecastBands.nullable().optional(),
    })
    .nullable(),
});

export type ShopSummary = z.infer<typeof ShopSummarySchema>;
export type ForecastBands = NonNullable<NonNullable<ShopSummary["backtest"]>["bands"]>;

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

export function formatCount(n: number): string {
  return COUNT_FORMAT.format(n);
}

function oneDecimal(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function formatUsdCompact(minor: number): string {
  const dollars = minor / 100;
  const whole = Math.round(dollars);
  if (whole < 1000) return `USD ${whole}`;
  // Round at each step so 999,960 dollars reads "1M", never "1000K".
  const thousands = Math.round(dollars / 100) / 10;
  if (thousands < 1000) return `USD ${oneDecimal(thousands)}K`;
  return `USD ${oneDecimal(Math.round(dollars / 100_000) / 10)}M`;
}

export function formatShare(share: number): string {
  return `${Math.round(share * 100)}%`;
}

const MINUS = "−";

export function formatDifference(d: number): string {
  const text = Math.abs(d).toFixed(3);
  if (Number(text) === 0) return "0.000";
  return `${d > 0 ? "+" : MINUS}${text}`;
}

export function verdict(low: number | null, high: number | null): "better" | "worse" | "tie" | "unknown" {
  if (low === null || high === null) return "unknown";
  if (low > 0) return "better";
  if (high < 0) return "worse";
  return "tie";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Read straight from the text, never through Date, so a time zone cannot move the day.
export function formatDay(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return iso;
  const month = MONTHS[Number(match[2]) - 1];
  if (month === undefined) return iso;
  return `${Number(match[3])} ${month} ${match[1]}`;
}
