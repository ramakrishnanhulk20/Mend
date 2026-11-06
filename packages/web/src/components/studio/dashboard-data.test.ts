// Covers the eight tables the dashboard reads, built from the same answer shapes the API sends:
// their rows, their nulls, exact money, that no email-like text can get into any table, that a
// plan never sent feeds none of the campaign tables, and that a verdict is read from the p value.
// Does NOT cover how Studio draws them, or DashboardStep's own panel; those are checked in the browser.
import { describe, expect, it } from "vitest";
import { CampaignViewSchema, QuietRegularsSchema, ResultsSchema } from "../console/api";
import { formatUsd } from "../console/money";
import { STATE_LABEL } from "../console/status";
import { ShopSummarySchema } from "../live/summary";
import {
  campaignCustomersTable,
  campaignMoneyTable,
  campaignVerdictTable,
  dashboardData,
  dashboardTables,
  dollars,
  forecastGroupsTable,
  proofDecilesTable,
  proofGroupsTable,
  regularsTable,
  SENT_STATUSES,
  sentResults,
  shopTotalsTable,
  threadKind,
  verdictShares,
  type DashboardInputs,
} from "./dashboard-data";
import { campaignResult, money, NO_CAMPAIGN } from "./agents/tools";
import { hasVerdict, verdictTitle, windowNote } from "./widgets/verdict-words";

const MODEL = { r: 0.24, alpha: 4.4, a: 0.79, b: 2.4, logLikelihood: -9582.4 };

const SUMMARY = ShopSummarySchema.parse({
  asOf: "2026-10-16",
  shopCustomers: 5852,
  membersJoined: 0,
  membersSeeded: 41,
  membersSeededLabel: "demo stand-ins",
  quietRegulars: 1357,
  quietRegularsPaid12mMinor: 149898701,
  currency: "USD",
  benchmark: { source: "CDNOW", customers: 2357, fitted: MODEL, published: MODEL, passed: true, computedAt: "2026-10-28T10:10:09Z" },
  backtest: {
    source: "UCI Online Retail II (Chen 2012, CC BY 4.0)",
    holdoutDays: 91,
    decileCutoff: "2011-06-09",
    deciles: [
      { decile: 2, customers: 500, returnedShare: 0.5 },
      { decile: 1, customers: 526, returnedShare: 0.9182509505703422 },
    ],
    headline: null,
    allCustomers: null,
    passed: true,
    computedAt: "2026-10-28T10:10:09Z",
    bands: {
      likelyGoneBelow: 0.1,
      likelyBackFrom: 1,
      regularMinDays: 3,
      silentMinDays: 60,
      horizonWeeks: 13,
      pooled: {
        likelyGone: { customers: 2000, returned: 300 },
        worthANudge: { customers: 800, returned: 200 },
        likelyBack: { customers: 0, returned: 0 },
      },
      rising: true,
      cutoffs: [],
    },
  },
});

const REGULARS = QuietRegularsSchema.parse({
  asOf: "2026-10-16",
  total: 1357,
  worthANudge: 90,
  likelyGone: 1000,
  likelyBack: 267,
  rows: [
    { position: 2, displayName: "Ben Okoro", purchaseDays: 7, daysSilent: 120, score: 0.2999, paidNetMinor: 4821, member: false, standIn: true },
    { position: 1, displayName: "Asha Rao", purchaseDays: 12, daysSilent: 80, score: 0.9999, paidNetMinor: 149898701, member: true },
    { position: 3, displayName: "Cara Lim", purchaseDays: 3, daysSilent: 61, score: 0.004, paidNetMinor: -150, member: false },
  ],
});

const VIEW = CampaignViewSchema.parse({
  campaignId: "camp-1",
  status: "submitted",
  goalText: "Win back quiet regulars",
  asOf: "2026-10-16",
  budgetMinor: 1000,
  perRecipientMinor: 200,
  holdoutShare: "0.05",
  totalMinor: 400,
  rows: [
    { ref: "r1", role: "reward", rank: 1, displayName: "Asha Rao", amountMinor: 200, note: "x", standIn: false },
    { ref: "r2", role: "reward", rank: 2, displayName: "Ben Okoro", amountMinor: 200, note: "x", standIn: true },
    { ref: "r3", role: "holdout", rank: 3, displayName: null, amountMinor: null, note: null, standIn: true },
  ],
  reviewHash: null,
  reviewProblem: null,
});

const ARM = { members: 2, realReturns: 1, realRate: 0.5, simulatedReturns: 0 };

const RESULTS = ResultsSchema.parse({
  campaignId: "camp-1",
  status: "submitted",
  rewarded: ARM,
  holdout: { members: 1, realReturns: 0, realRate: 0, simulatedReturns: 1 },
  spendMinor: 400,
  feesMinor: 12,
  windowStartsAt: null,
  windowEndsAt: null,
  windowOpen: true,
  pValue: null,
  verdict: "too early to tell",
  payouts: {
    items: 2,
    byStatus: { SUCCESS: 1, UNCLAIMED: 1 },
    claimedMinor: 200,
    unclaimedMinor: 150,
    returnedMinor: 0,
    failedMinor: 0,
    pendingMinor: 50,
    unclaimedReturnBy: null,
  },
  rows: [
    { ref: "r3", role: "holdout", rank: 3, displayName: null, standIn: true, payoutStatus: null, simulatedReturn: true, realReturn: false },
    { ref: "r2", role: "reward", rank: 2, displayName: "Ben Okoro", standIn: true, payoutStatus: "UNCLAIMED", simulatedReturn: false, realReturn: false },
    { ref: "r1", role: "reward", rank: 1, displayName: "Asha Rao", standIn: false, payoutStatus: "SUCCESS", simulatedReturn: false, realReturn: true },
  ],
});

const FULL: DashboardInputs = { summary: SUMMARY, regulars: REGULARS, view: VIEW, results: RESULTS };
const NOTHING: DashboardInputs = { summary: null, regulars: null, view: null, results: null };

describe("dollars", () => {
  it.each([0, 5, 150, 4821, 149898701, 99999999999])("keeps %j cents exact to the cent", (minor) => {
    expect(formatUsd(Math.round(dollars(minor) * 100))).toBe(formatUsd(minor));
    expect(dollars(minor).toFixed(2)).toBe(formatUsd(minor).replace("USD ", "").replaceAll(",", ""));
  });
});

describe("shopTotalsTable", () => {
  it("reads the four shop figures from the summary and the regulars answer", () => {
    expect(shopTotalsTable(SUMMARY, REGULARS)).toEqual([
      { customers: 5852, quiet_regulars: 1357, worth_a_nudge: 90, spent_quiet_usd: 1498987.01 },
    ]);
  });

  it("leaves a figure null when only part of it has loaded", () => {
    expect(shopTotalsTable(SUMMARY, null)).toEqual([
      { customers: 5852, quiet_regulars: 1357, worth_a_nudge: null, spent_quiet_usd: 1498987.01 },
    ]);
    expect(shopTotalsTable(null, REGULARS)).toEqual([
      { customers: null, quiet_regulars: null, worth_a_nudge: 90, spent_quiet_usd: null },
    ]);
  });

  it("is empty with nothing loaded", () => {
    expect(shopTotalsTable(null, null)).toEqual([]);
  });
});

describe("regularsTable", () => {
  it("is in position order with plain list words", () => {
    const rows = regularsTable(REGULARS);
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.list_status)).toEqual(["Joined", "Demo stand-in", "Not on the list"]);
  });

  it("rounds the forecast down to 2 places so a score under 1 never reads 1.00", () => {
    expect(regularsTable(REGULARS).map((row) => row.expected_orders)).toEqual([0.99, 0.29, 0]);
  });

  it("holds money in dollars to the cent, refunds included", () => {
    expect(regularsTable(REGULARS).map((row) => row.spent_usd)).toEqual([1498987.01, 48.21, -1.5]);
  });

  it("gives a stand-in the stand-in word even when it also counts as joined", () => {
    const both = QuietRegularsSchema.parse({ ...REGULARS, rows: [{ ...REGULARS.rows[0], member: true, standIn: true }] });
    expect(regularsTable(both)[0].list_status).toBe("Demo stand-in");
  });

  it("is empty with no answer", () => {
    expect(regularsTable(null)).toEqual([]);
  });
});

describe("forecastGroupsTable", () => {
  it("names the groups as the proof section does", () => {
    expect(forecastGroupsTable(REGULARS)).toEqual([
      { group: "Likely gone", customers: 1000, sort_order: 1 },
      { group: "Worth a nudge", customers: 90, sort_order: 2 },
      { group: "Likely back anyway", customers: 267, sort_order: 3 },
    ]);
  });

  it("is empty with no answer", () => {
    expect(forecastGroupsTable(null)).toEqual([]);
  });
});

describe("proofGroupsTable", () => {
  it("gives the share who came back in percent, and null for a group nobody was in", () => {
    expect(proofGroupsTable(SUMMARY)).toEqual([
      { group: "Likely gone", sort_order: 1, share: 15, returned: 300, customers: 2000 },
      { group: "Worth a nudge", sort_order: 2, share: 25, returned: 200, customers: 800 },
      { group: "Likely back anyway", sort_order: 3, share: null, returned: 0, customers: 0 },
    ]);
  });

  it("is empty when the summary or its groups are missing", () => {
    expect(proofGroupsTable(null)).toEqual([]);
    const noBands = ShopSummarySchema.parse({ ...SUMMARY, backtest: { ...SUMMARY.backtest, bands: null } });
    expect(proofGroupsTable(noBands)).toEqual([]);
    expect(proofGroupsTable(ShopSummarySchema.parse({ ...SUMMARY, backtest: null }))).toEqual([]);
  });
});

describe("proofDecilesTable", () => {
  it("is in decile order", () => {
    expect(proofDecilesTable(SUMMARY)).toEqual([
      { decile: 1, customers: 526, returned_share: 91.82509505703422 },
      { decile: 2, customers: 500, returned_share: 50 },
    ]);
  });

  it("is empty with no backtest", () => {
    expect(proofDecilesTable(null)).toEqual([]);
    expect(proofDecilesTable(ShopSummarySchema.parse({ ...SUMMARY, backtest: null }))).toEqual([]);
  });
});

describe("campaignCustomersTable", () => {
  it("lists everyone by rank with the payment words the Payout step shows", () => {
    expect(campaignCustomersTable(RESULTS, VIEW)).toEqual([
      { id: 1, name: "Asha Rao", arm: "Paid", amount_usd: 2, status: "claimed by the customer", came_back: "Yes", simulated: "No" },
      { id: 2, name: "Ben Okoro", arm: "Paid", amount_usd: 2, status: "sent, waiting to be claimed", came_back: "No", simulated: "No" },
      { id: 3, name: "Customer #3", arm: "Held back", amount_usd: null, status: "held back, never paid", came_back: "No", simulated: "Yes" },
    ]);
  });

  it("leaves the amount null when the plan view is not there", () => {
    expect(campaignCustomersTable(RESULTS, null).map((row) => row.amount_usd)).toEqual([null, null, null]);
  });

  it("is empty with no results", () => {
    expect(campaignCustomersTable(null, VIEW)).toEqual([]);
  });
});

describe("campaignMoneyTable", () => {
  it("counts money PayPal is still processing as waiting, like the Payout step", () => {
    expect(campaignMoneyTable(RESULTS)).toEqual([
      { state: "Claimed", usd: 2 },
      { state: "Waiting", usd: 2 },
      { state: "Returned", usd: 0 },
      { state: "Fees", usd: 0.12 },
    ]);
  });

  it("is empty with no results", () => {
    expect(campaignMoneyTable(null)).toEqual([]);
  });
});

describe("campaignVerdictTable", () => {
  it("is one row with the verdict words and each group's size and real returns", () => {
    expect(campaignVerdictTable(RESULTS)).toEqual([
      {
        verdict_title: "Too early to tell.",
        paid_customers: 2,
        paid_came_back: 1,
        paid_simulated: 0,
        held_customers: 1,
        held_came_back: 0,
        held_simulated: 1,
        window_note: "",
      },
    ]);
  });

  it("keeps a simulated return out of the real count", () => {
    const [row] = campaignVerdictTable(RESULTS);
    expect(row.held_came_back).toBe(0);
    expect(row.held_simulated).toBe(1);
  });

  it("carries the window line and the p value in the Results step's words", () => {
    const closed = ResultsSchema.parse({
      ...RESULTS,
      verdict: "rewarded customers came back more (one-sided p = 0.03)",
      windowStartsAt: "2026-10-16T10:00:00Z",
      windowEndsAt: "2026-11-15T10:00:00Z",
      windowOpen: false,
      pValue: 0.0312,
    });
    const [row] = campaignVerdictTable(closed);
    expect(row.verdict_title).toBe("Rewarded customers came back more (one-sided p = 0.03).");
    expect(row.window_note).toBe("Window 16 Oct 2026 to 15 Nov 2026 · closed · p = 0.03");
  });

  it("is empty with no results, never a made-up verdict", () => {
    expect(campaignVerdictTable(null)).toEqual([]);
  });
});

describe("verdict words", () => {
  it("makes a title of the verdict: a capital first, one full stop last", () => {
    expect(verdictTitle("too early to tell")).toBe("Too early to tell.");
    expect(verdictTitle("  no measurable difference yet (one-sided p = 0.20).  ")).toBe("No measurable difference yet (one-sided p = 0.20).");
  });

  it("says a window is open until it closes", () => {
    const open = { windowStartsAt: "2026-10-16T00:00:00Z", windowEndsAt: "2026-11-15T00:00:00Z", windowOpen: true, pValue: null };
    expect(windowNote(open)).toBe("Window 16 Oct 2026 to 15 Nov 2026 · open");
    expect(windowNote({ ...open, windowStartsAt: null, windowEndsAt: null })).toBe("");
  });

  it("counts a verdict only where the window line carries a p value, which the engine sets when its gate passes", () => {
    const closed = { windowStartsAt: "2026-10-16T00:00:00Z", windowEndsAt: "2026-11-15T00:00:00Z", windowOpen: false };
    expect(hasVerdict(windowNote({ ...closed, pValue: 0.03 }))).toBe(true);
    expect(hasVerdict(windowNote({ ...closed, pValue: 0 }))).toBe(true);
    expect(hasVerdict(windowNote({ ...closed, windowStartsAt: null, windowEndsAt: null, pValue: 0.2 }))).toBe(true);
    expect(hasVerdict(windowNote({ ...closed, pValue: null }))).toBe(false);
    expect(hasVerdict("")).toBe(false);
  });
});

describe("verdictShares", () => {
  const row = (title: string, paid: [number, number], held: [number, number], note = "") => ({
    verdict_title: title,
    paid_customers: paid[1],
    paid_came_back: paid[0],
    paid_simulated: 0,
    held_customers: held[1],
    held_came_back: held[0],
    held_simulated: 0,
    window_note: note,
  });

  it("shows no share bar while the verdict is Too early to tell, whatever the counts", () => {
    const [tooEarly] = campaignVerdictTable(RESULTS);
    expect(verdictShares(tooEarly)).toBeNull();
    expect(verdictShares(row("Too few returns to tell.", [9, 10], [0, 10]))).toBeNull();
  });

  it("gives each group's share once there is a verdict, and null for an empty group", () => {
    expect(verdictShares(row("Rewarded customers came back more (one-sided p = 0.03).", [9, 30], [3, 30], "p = 0.03"))).toEqual({ paid: 0.3, held: 0.1 });
    expect(verdictShares(row("No measurable difference yet (one-sided p = 0.20).", [1, 30], [0, 0], "p = 0.20"))).toEqual({ paid: 1 / 30, held: null });
  });

  it("goes by the p value and never by the verdict's words, so a new way of declining draws no share", () => {
    const [declined] = campaignVerdictTable({ ...RESULTS, verdict: "still counting returns" });
    expect(declined.verdict_title).toBe("Still counting returns.");
    expect(verdictShares(declined)).toBeNull();
    const [given] = campaignVerdictTable({ ...RESULTS, verdict: "any words at all", pValue: 0.03 });
    expect(verdictShares(given)).toEqual({ paid: 0.5, held: 0 });
  });
});

describe("threadKind", () => {
  it("draws a claimed payment mended and a held-back customer held", () => {
    expect(threadKind(STATE_LABEL.claimed)).toBe("claimed");
    expect(threadKind(STATE_LABEL.held)).toBe("held");
  });

  it("keeps every payment still on its way as waiting", () => {
    for (const state of ["waiting", "sending", "sent", "unclear"] as const) expect(threadKind(STATE_LABEL[state])).toBe("waiting");
  });

  it("draws a payment that came back, or PayPal refused, with a clean gap", () => {
    expect(threadKind(STATE_LABEL.returned)).toBe("returned");
    expect(threadKind(STATE_LABEL.refused)).toBe("returned");
  });

  it("reads words it does not know as waiting, the one kind that claims nothing", () => {
    expect(threadKind("something new")).toBe("waiting");
  });

  it("reads every status the campaign table can hold", () => {
    const kinds = campaignCustomersTable(RESULTS, VIEW).map((row) => threadKind(row.status));
    expect(kinds).toEqual(["claimed", "waiting", "held"]);
  });
});

describe("dashboardTables", () => {
  it("is empty everywhere with nothing loaded, never a made-up number", () => {
    for (const rows of Object.values(dashboardTables(NOTHING))) expect(rows).toEqual([]);
  });

  it("keeps a campaign out of the shop tables and the shop out of the campaign tables", () => {
    const shopOnly = dashboardTables({ ...FULL, view: null, results: null });
    expect(shopOnly.campaign_customers).toEqual([]);
    expect(shopOnly.campaign_money).toEqual([]);
    expect(shopOnly.campaign_verdict).toEqual([]);
    expect(shopOnly.regulars).toHaveLength(3);
    const campaignOnly = dashboardTables({ summary: null, regulars: null, view: VIEW, results: RESULTS });
    expect(campaignOnly.regulars).toEqual([]);
    expect(campaignOnly.campaign_customers).toHaveLength(3);
  });

  it("never lets an at-sign into a field name or a value, even if a name carries one", () => {
    const leaky = QuietRegularsSchema.parse({
      ...REGULARS,
      rows: [{ ...REGULARS.rows[0], displayName: "asha@example.com" }],
    });
    const leakyResults = ResultsSchema.parse({
      ...RESULTS,
      rows: RESULTS.rows.map((row) => ({ ...row, displayName: "ben@example.com" })),
    });
    const all = dashboardTables({ summary: SUMMARY, regulars: leaky, view: VIEW, results: leakyResults });
    for (const [table, rows] of Object.entries(all)) {
      for (const row of rows) {
        for (const [field, value] of Object.entries(row)) {
          expect(field, `${table} field`).not.toContain("@");
          expect(String(value), `${table}.${field}`).not.toContain("@");
        }
      }
    }
    expect(all.regulars[0].name).toBe("Customer #2");
  });

  it("never carries a field for an email, a payer or a batch item", () => {
    const fields = Object.values(dashboardTables(FULL)).flatMap((rows) => rows.flatMap((row) => Object.keys(row)));
    for (const field of fields) expect(field).not.toMatch(/mail|payer|item|ref|batch|member/i);
  });
});

describe("a plan that was never sent", () => {
  it.each(["draft", "awaiting_approval", "approved", "submitting", "voided"])("feeds no results for a campaign in %s", (status) => {
    expect(sentResults({ ...RESULTS, status })).toBeNull();
  });

  it.each(["submitted", "completed"])("feeds the results of a campaign in %s", (status) => {
    expect(SENT_STATUSES).toContain(status);
    expect(sentResults({ ...RESULTS, status })?.status).toBe(status);
  });

  it("feeds nothing with no results", () => {
    expect(sentResults(null)).toBeNull();
  });

  it("leaves no Paid row, no money and no verdict in the tables, and the analyst's reads say there is no campaign", () => {
    const inputs = { ...FULL, results: sentResults({ ...RESULTS, status: "approved" }) };
    const tables = dashboardTables(inputs);
    expect(tables.campaign_customers).toEqual([]);
    expect(tables.campaign_money).toEqual([]);
    expect(tables.campaign_verdict).toEqual([]);
    expect(JSON.stringify(tables)).not.toContain("Paid");
    const facts = { data: dashboardData(inputs), bands: null };
    expect(campaignResult(facts)).toEqual({ response: NO_CAMPAIGN, data: null });
    expect(money(facts)).toEqual({ response: NO_CAMPAIGN, data: [] });
  });
});

describe("dashboardData", () => {
  it("says the regulars table holds the first 50 of the worth-a-nudge list", () => {
    expect(dashboardData(NOTHING).sources.find((source) => source.id === "regulars")?.description).toContain("first 50 of the worth-a-nudge list");
  });

  it("declares all eight tables with snake_case field ids, even with nothing to show", () => {
    const sources = dashboardData(NOTHING).sources;
    expect(sources.map((source) => source.id)).toEqual([
      "shop_totals",
      "regulars",
      "forecast_groups",
      "proof_groups",
      "proof_deciles",
      "campaign_customers",
      "campaign_money",
      "campaign_verdict",
    ]);
    for (const source of sources) {
      expect(source.data).toEqual([]);
      for (const field of source.fields ?? []) expect(field.id).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it("has a row for every column it declares", () => {
    const sources = dashboardData(FULL).sources;
    for (const source of sources) {
      const declared = (source.fields ?? []).map((field) => field.id).sort();
      const rows = source.data ?? [];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(Object.keys(row as object).sort()).toEqual(declared);
    }
  });
});
