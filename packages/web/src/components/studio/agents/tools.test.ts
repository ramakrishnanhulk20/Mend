// Covers the analyst's three read tools: what each hands back from the page's tables, the plain
// statement when no campaign is open, the group rule words, that a tool reads the page afresh on each
// call, and that none of them reaches the network or takes an argument. Does NOT cover Studio running
// them or how a model uses them (scratchpad/redesign/proof-a4.mjs drives those live).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForecastBands } from "../../live/summary";
import { dashboardData, type DashboardInputs } from "../dashboard-data";
import { analystTools, campaignResult, forecastGroups, money, NO_CAMPAIGN, READ_TOOLS, type PageFacts } from "./tools";

const BANDS = {
  likelyGoneBelow: 0.1,
  likelyBackFrom: 0.5,
  rising: true,
  regularMinDays: 3,
  silentMinDays: 90,
  cutoffs: [],
  pooled: { likelyGone: { customers: 10, returned: 1 }, worthANudge: { customers: 8, returned: 2 }, likelyBack: { customers: 4, returned: 3 } },
} as unknown as ForecastBands;

const SUMMARY = { backtest: { bands: BANDS } } as unknown as DashboardInputs["summary"];
const REGULARS = { likelyGone: 5, worthANudge: 7, likelyBack: 2, rows: [], worthANudgeRows: [] } as unknown as DashboardInputs["regulars"];
const PAYOUTS = { claimedMinor: 1000, unclaimedMinor: 2000, pendingMinor: 500, returnedMinor: 250 };
const RESULTS = {
  verdict: "too early to tell",
  rewarded: { members: 6, realReturns: 1, simulatedReturns: 2 },
  holdout: { members: 6, realReturns: 0, simulatedReturns: 0 },
  windowStartsAt: null,
  windowEndsAt: null,
  windowOpen: true,
  pValue: null,
  payouts: PAYOUTS,
  feesMinor: 120,
  rows: [],
} as unknown as DashboardInputs["results"];

function facts(inputs: Partial<DashboardInputs> = {}, bands: ForecastBands | null = BANDS): PageFacts {
  return { data: dashboardData({ summary: SUMMARY, regulars: REGULARS, view: null, results: RESULTS, ...inputs }), bands };
}

describe("the read tools", () => {
  it("campaign result: hands back the verdict row, with real and simulated returns apart", () => {
    const { data } = campaignResult(facts());
    expect(data).toMatchObject({ verdict_title: "Too early to tell.", paid_customers: 6, paid_came_back: 1, paid_simulated: 2, held_customers: 6, held_came_back: 0, held_simulated: 0 });
  });

  it("campaign result: says plainly that no campaign is open", () => {
    expect(campaignResult(facts({ results: null }))).toEqual({ response: NO_CAMPAIGN, data: null });
  });

  it("forecast groups: hands back both tables, each forecast group with its rule words", () => {
    const { data } = forecastGroups(facts());
    expect(data.forecast_groups).toEqual([
      { group: "Likely gone", customers: 5, sort_order: 1, rule: "Under 0.1 orders expected" },
      { group: "Worth a nudge", customers: 7, sort_order: 2, rule: "0.1 to under 0.5 orders expected" },
      { group: "Likely back anyway", customers: 2, sort_order: 3, rule: "0.5 or more orders expected" },
    ]);
    expect(data.proof_groups.map((row) => [row.group, row.customers, row.returned])).toEqual([
      ["Likely gone", 10, 1],
      ["Worth a nudge", 8, 2],
      ["Likely back anyway", 4, 3],
    ]);
  });

  it("forecast groups: leaves the rule out rather than guessing while the bands are unknown", () => {
    expect(forecastGroups(facts({}, null)).data.forecast_groups.map((row) => row.rule)).toEqual([null, null, null]);
  });

  it("money: hands back the four figures in dollars, and says so when there is no campaign", () => {
    expect(money(facts()).data).toEqual([
      { state: "Claimed", usd: 10 },
      { state: "Waiting", usd: 25 },
      { state: "Returned", usd: 2.5 },
      { state: "Fees", usd: 1.2 },
    ]);
    expect(money(facts({ results: null }))).toEqual({ response: NO_CAMPAIGN, data: [] });
  });
});

describe("analystTools", () => {
  afterEach(() => vi.unstubAllGlobals());

  type Config = { name: string; params: (s: { object: (shape: unknown) => unknown }) => unknown; execute: (args: unknown, ctx: unknown) => Promise<{ response: string; data: unknown }> };
  const defined = (config: unknown) => config as never;
  const success = <Data>(response: string, data: Data) => ({ response, data });

  it("offers exactly the three tools, each taking no argument", () => {
    const shapes: unknown[] = [];
    const tools = analystTools({ defineAiTool: defined }, () => facts()) as unknown as Config[];
    expect(tools.map((tool) => tool.name)).toEqual([...READ_TOOLS]);
    for (const tool of tools) tool.params({ object: (shape) => shapes.push(shape) });
    expect(shapes).toEqual([{}, {}, {}]);
  });

  it("reads the page each time it runs and fetches nothing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    let current = facts({ results: null });
    const [result] = analystTools({ defineAiTool: defined }, () => current) as unknown as Config[];
    expect((await result.execute({}, { success })).data).toBeNull();
    current = facts();
    expect((await result.execute({}, { success })).data).toMatchObject({ verdict_title: "Too early to tell." });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
