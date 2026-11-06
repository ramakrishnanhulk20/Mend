import type { AgFieldDefinition, AgSimpleDataSourceDefinition } from "ag-studio";
import type { CampaignView, QuietRegulars, Results } from "../console/api";
import { threadState, STATE_LABEL, type ThreadState } from "../console/status";
import type { ShopSummary } from "../live/summary";
import { groupName } from "../proof/groups";
import { LIST_SIZE } from "./dashboard-report";
import type { MendRegistry } from "./widgets";
import { hasVerdict, verdictTitle, windowNote } from "./widgets/verdict-words";

// Pure: every function here turns an answer the API already gave into flat rows. Nothing
// is fetched, and nothing in a row can name a customer's email, a PayPal payer or a batch item.

export type ListStatus = "Joined" | "Demo stand-in" | "Not on the list";

export type ShopTotalsRow = {
  readonly customers: number | null;
  readonly quiet_regulars: number | null;
  readonly worth_a_nudge: number | null;
  readonly spent_quiet_usd: number | null;
};

export type RegularRow = {
  readonly id: number;
  readonly name: string;
  readonly purchase_days: number;
  readonly days_silent: number;
  readonly expected_orders: number;
  readonly spent_usd: number;
  readonly list_status: ListStatus;
};

// sort_order is 1, 2, 3 in the order Mend names the groups. Charts colour their series in the order they are sorted, so it keeps Worth a nudge second.
export type ForecastGroupRow = { readonly group: string; readonly customers: number; readonly sort_order: number };

// share and returned_share are percent, 0 to 100, because a chart axis cannot show a fraction as a percent.
export type ProofGroupRow = {
  readonly group: string;
  readonly sort_order: number;
  readonly share: number | null;
  readonly returned: number;
  readonly customers: number;
};

export type ProofDecileRow = { readonly decile: number; readonly customers: number; readonly returned_share: number };

export type CampaignCustomerRow = {
  readonly id: number;
  readonly name: string;
  readonly arm: "Paid" | "Held back";
  readonly amount_usd: number | null;
  readonly status: string;
  readonly came_back: "Yes" | "No";
  readonly simulated: "Yes" | "No";
};

export type CampaignMoneyRow = { readonly state: "Claimed" | "Waiting" | "Returned" | "Fees"; readonly usd: number };

// Real returns and simulated purchases are separate columns, so a simulated one can never be counted as a real one.
export type CampaignVerdictRow = {
  readonly verdict_title: string;
  readonly paid_customers: number;
  readonly paid_came_back: number;
  readonly paid_simulated: number;
  readonly held_customers: number;
  readonly held_came_back: number;
  readonly held_simulated: number;
  readonly window_note: string;
};

/** Everything the dashboard reads. A part that has not loaded, or does not exist yet, is null. */
export type DashboardInputs = {
  readonly summary: ShopSummary | null;
  readonly regulars: QuietRegulars | null;
  readonly view: CampaignView | null;
  readonly results: Results | null;
};

export type DashboardTables = {
  readonly shop_totals: readonly ShopTotalsRow[];
  readonly regulars: readonly RegularRow[];
  readonly forecast_groups: readonly ForecastGroupRow[];
  readonly proof_groups: readonly ProofGroupRow[];
  readonly proof_deciles: readonly ProofDecileRow[];
  readonly campaign_customers: readonly CampaignCustomerRow[];
  readonly campaign_money: readonly CampaignMoneyRow[];
  readonly campaign_verdict: readonly CampaignVerdictRow[];
};

/** The campaign statuses that mean the batch has already gone to PayPal and is being paid. */
export const SENT_STATUSES: readonly string[] = ["submitted", "completed"];

/** results, or null for a campaign that was never sent. The tables call every rewarded row Paid, which a plan waiting to go out is not. */
export function sentResults(results: Results | null): Results | null {
  return results !== null && SENT_STATUSES.includes(results.status) ? results : null;
}

/** Whole cents to dollars. A cent count divided by 100 is the nearest double to the exact amount, and every display rounds to 2 places. */
export function dollars(minor: number): number {
  return minor / 100;
}

// Rounded down, as the Regulars step does, so a score just under 1 order never reads 1.00, the line where Mend stops nudging.
function twoDecimals(score: number): number {
  return Math.floor(score * 100 + 1e-9) / 100;
}

function listStatus(row: { readonly standIn: boolean; readonly member: boolean }): ListStatus {
  if (row.standIn) return "Demo stand-in";
  return row.member ? "Joined" : "Not on the list";
}

// A name that holds an @ could be an email, so it never goes into a table.
function safeName(name: string | null | undefined, rank: number): string {
  const text = typeof name === "string" ? name.trim() : "";
  return text === "" || text.includes("@") ? `Customer #${rank}` : text;
}

export function shopTotalsTable(summary: ShopSummary | null, regulars: QuietRegulars | null): ShopTotalsRow[] {
  if (summary === null && regulars === null) return [];
  return [
    {
      customers: summary?.shopCustomers ?? null,
      quiet_regulars: summary?.quietRegulars ?? null,
      worth_a_nudge: regulars?.worthANudge ?? null,
      spent_quiet_usd: summary === null ? null : dollars(summary.quietRegularsPaid12mMinor),
    },
  ];
}

export function regularsTable(regulars: QuietRegulars | null): RegularRow[] {
  if (regulars === null) return [];
  return [...regulars.rows]
    .sort((a, b) => a.position - b.position)
    .map((row) => ({
      id: row.position,
      name: safeName(row.displayName, row.position),
      purchase_days: row.purchaseDays,
      days_silent: row.daysSilent,
      expected_orders: twoDecimals(row.score),
      spent_usd: dollars(row.paidNetMinor),
      list_status: listStatus(row),
    }));
}

export function forecastGroupsTable(regulars: QuietRegulars | null): ForecastGroupRow[] {
  if (regulars === null) return [];
  return [
    { group: groupName("likelyGone"), customers: regulars.likelyGone, sort_order: 1 },
    { group: groupName("worthANudge"), customers: regulars.worthANudge, sort_order: 2 },
    { group: groupName("likelyBack"), customers: regulars.likelyBack, sort_order: 3 },
  ];
}

export function proofGroupsTable(summary: ShopSummary | null): ProofGroupRow[] {
  const pooled = summary?.backtest?.bands?.pooled;
  if (pooled === undefined) return [];
  return (["likelyGone", "worthANudge", "likelyBack"] as const).map((key, index) => ({
    group: groupName(key),
    sort_order: index + 1,
    share: pooled[key].customers === 0 ? null : (pooled[key].returned * 100) / pooled[key].customers,
    returned: pooled[key].returned,
    customers: pooled[key].customers,
  }));
}

export function proofDecilesTable(summary: ShopSummary | null): ProofDecileRow[] {
  const deciles = summary?.backtest?.deciles;
  if (deciles === undefined) return [];
  return [...deciles]
    .sort((a, b) => a.decile - b.decile)
    .map((row) => ({ decile: row.decile, customers: row.customers, returned_share: row.returnedShare * 100 }));
}

export function campaignCustomersTable(results: Results | null, view: CampaignView | null): CampaignCustomerRow[] {
  if (results === null) return [];
  const amounts = new Map((view?.rows ?? []).map((row) => [row.ref, row.amountMinor]));
  return [...results.rows]
    .sort((a, b) => a.rank - b.rank)
    .map((row) => {
      const amount = amounts.get(row.ref) ?? null;
      return {
        id: row.rank,
        name: safeName(row.displayName, row.rank),
        arm: row.role === "reward" ? "Paid" : "Held back",
        amount_usd: amount === null ? null : dollars(amount),
        status: STATE_LABEL[threadState(row.role, row.payoutStatus)],
        came_back: row.realReturn ? "Yes" : "No",
        simulated: row.simulatedReturn ? "Yes" : "No",
      };
    });
}

// The four figures the Payout step shows: waiting is the money PayPal holds unclaimed plus what it is still processing.
export function campaignMoneyTable(results: Results | null): CampaignMoneyRow[] {
  if (results === null) return [];
  const { payouts, feesMinor } = results;
  return [
    { state: "Claimed", usd: dollars(payouts.claimedMinor) },
    { state: "Waiting", usd: dollars(payouts.unclaimedMinor + payouts.pendingMinor) },
    { state: "Returned", usd: dollars(payouts.returnedMinor) },
    { state: "Fees", usd: dollars(feesMinor) },
  ];
}

/** One row: the verdict words, each group's size and returns, and the window line. The words come from the same functions the Results step uses. */
export function campaignVerdictTable(results: Results | null): CampaignVerdictRow[] {
  if (results === null) return [];
  const { rewarded, holdout } = results;
  return [
    {
      verdict_title: verdictTitle(results.verdict),
      paid_customers: rewarded.members,
      paid_came_back: rewarded.realReturns,
      paid_simulated: rewarded.simulatedReturns,
      held_customers: holdout.members,
      held_came_back: holdout.realReturns,
      held_simulated: holdout.simulatedReturns,
      window_note: windowNote(results),
    },
  ];
}

/** How a customer's thread is drawn: a mended thread, a thread still waiting, a thread sent back to the shop, or a customer held back. */
export type ThreadKind = "claimed" | "waiting" | "returned" | "held";

const KIND_OF_STATE: Record<ThreadState, ThreadKind> = {
  waiting: "waiting",
  sending: "waiting",
  sent: "waiting",
  claimed: "claimed",
  returned: "returned",
  refused: "returned",
  unclear: "waiting",
  held: "held",
};

/** The thread kind for the payment words the table holds. Words nobody recognises read as waiting, the one kind that claims nothing. */
export function threadKind(status: string): ThreadKind {
  const found = (Object.keys(STATE_LABEL) as ThreadState[]).find((state) => STATE_LABEL[state] === status);
  return found === undefined ? "waiting" : KIND_OF_STATE[found];
}

/** Each group's share who came back, or null when Mend has no verdict to give: a share beside "too early to tell" would read as a result. */
export function verdictShares(row: CampaignVerdictRow): { readonly paid: number | null; readonly held: number | null } | null {
  if (!hasVerdict(row.window_note)) return null;
  const share = (cameBack: number, customers: number) => (customers === 0 ? null : cameBack / customers);
  return { paid: share(row.paid_came_back, row.paid_customers), held: share(row.held_came_back, row.held_customers) };
}

export function dashboardTables(inputs: DashboardInputs): DashboardTables {
  return {
    shop_totals: shopTotalsTable(inputs.summary, inputs.regulars),
    regulars: regularsTable(inputs.regulars),
    forecast_groups: forecastGroupsTable(inputs.regulars),
    proof_groups: proofGroupsTable(inputs.summary),
    proof_deciles: proofDecilesTable(inputs.summary),
    campaign_customers: campaignCustomersTable(inputs.results, inputs.view),
    campaign_money: campaignMoneyTable(inputs.results),
    campaign_verdict: campaignVerdictTable(inputs.results),
  };
}

export type DashboardData = ReturnType<typeof dashboardData>;

/** True when two data definitions hold the same rows, so a refresh that found nothing new can keep the object Studio already has. */
export function sameData(a: DashboardData, b: DashboardData): boolean {
  return JSON.stringify(a.sources.map((source) => source.data)) === JSON.stringify(b.sources.map((source) => source.data));
}

const USD = '"USD "#,##0.00';
type FieldDefinition = AgFieldDefinition<MendRegistry>;
const text = (id: string, name: string): FieldDefinition => ({ id, name, format: "textFormat" });
const whole = (id: string, name: string): FieldDefinition => ({ id, name, format: "integerFormat" });
const money = (id: string, name: string): FieldDefinition => ({ id, name, format: "currencyFormat", formatOptions: { format: USD } });
const percent = (id: string, name: string): FieldDefinition => ({ id, name, format: "decimalFormat", formatOptions: { format: '0"%"' } });
// A number that reads as the group's name, so a chart orders and colours its groups by it instead of alphabetically.
const GROUP_KEYS = [groupName("likelyGone"), groupName("worthANudge"), groupName("likelyBack")];
const order = (): FieldDefinition => ({
  id: "sort_order",
  name: "Forecast group",
  format: "integerFormat",
  formatOptions: { format: `[=1]"${GROUP_KEYS[0]}";[=2]"${GROUP_KEYS[1]}";"${GROUP_KEYS[2]}"` },
  hide: true,
});
// A position or rank is a label, so it gets no thousands separator.
const label = (id: string, name: string): FieldDefinition => ({ id, name, format: "integerFormat", formatOptions: { format: "0" } });

/** The same tables as one Studio data definition. All eight always exist, empty when there is nothing to show, because Studio cannot add a table after it starts. */
export function dashboardData(inputs: DashboardInputs): { readonly description: string; readonly sources: AgSimpleDataSourceDefinition<MendRegistry>[] } {
  const tables = dashboardTables(inputs);
  return {
    description:
      "A shop owner's dashboard for Mend: the shop's quiet regulars and forecast groups, the latest cashback campaign and who came back, and how well the forecast held up on past orders. No table holds an email address.",
    sources: [
      {
        id: "shop_totals",
        name: "Shop totals",
        description: "One row: customers, quiet regulars, how many are worth a nudge, and what the quiet regulars spent in the last 12 months.",
        data: tables.shop_totals.map((row) => ({ ...row })),
        fields: [
          whole("customers", "Customers"),
          whole("quiet_regulars", "Quiet regulars"),
          whole("worth_a_nudge", "Worth a nudge"),
          money("spent_quiet_usd", "Spent by quiet regulars last year"),
        ],
      },
      {
        id: "regulars",
        name: "Quiet regulars",
        description: `The first ${LIST_SIZE} of the worth-a-nudge list, biggest spenders first, so any count from this table stops at ${LIST_SIZE}: worth_a_nudge in shop_totals is the whole list. expected_orders is the forecast for the next 13 weeks.`,
        data: tables.regulars.map((row) => ({ ...row })),
        fields: [
          label("id", "Position"),
          text("name", "Name"),
          whole("purchase_days", "Purchase days"),
          whole("days_silent", "Days silent"),
          { id: "expected_orders", name: "Expected orders", format: "decimalFormat", formatOptions: { format: "0.00" } },
          money("spent_usd", "Spent"),
          text("list_status", "List status"),
        ],
      },
      {
        id: "forecast_groups",
        name: "Forecast groups",
        description: "How many quiet regulars fall in each forecast group today.",
        data: tables.forecast_groups.map((row) => ({ ...row })),
        fields: [text("group", "Forecast group"), whole("customers", "Customers"), order()],
      },
      {
        id: "proof_groups",
        name: "Proof by forecast group",
        description: "On past orders: of the quiet regulars in each forecast group, the share who came back on their own with no cashback.",
        data: tables.proof_groups.map((row) => ({ ...row })),
        fields: [text("group", "Forecast group"), percent("share", "Came back on their own"), whole("returned", "Came back"), whole("customers", "Customers"), order()],
      },
      {
        id: "proof_deciles",
        name: "Proof by decile",
        description: "On past orders: customers ranked by forecast and split into ten equal groups, with the share of each group who came back.",
        data: tables.proof_deciles.map((row) => ({ ...row })),
        fields: [label("decile", "Forecast decile"), whole("customers", "Customers"), percent("returned_share", "Came back")],
      },
      {
        id: "campaign_customers",
        name: "Campaign customers",
        description: "Everyone in the latest campaign: paid or held back, what they were paid, where the payment stands, and whether they came back.",
        data: tables.campaign_customers.map((row) => ({ ...row })),
        fields: [
          label("id", "Rank"),
          text("name", "Name"),
          text("arm", "Group"),
          money("amount_usd", "Amount"),
          text("status", "Payment"),
          text("came_back", "Came back"),
          text("simulated", "Simulated return"),
        ],
      },
      {
        id: "campaign_money",
        name: "Campaign money",
        description: "Where the latest campaign's money is: claimed, waiting, returned to the shop, and PayPal fees.",
        data: tables.campaign_money.map((row) => ({ ...row })),
        fields: [text("state", "State"), money("usd", "Amount")],
      },
      {
        id: "campaign_verdict",
        name: "Campaign verdict",
        description:
          "One row for the latest campaign: the verdict in words, how many customers the paid and held-back groups hold, how many of each really came back, how many came back by simulated purchase (kept apart from real ones), and the window the count runs over.",
        data: tables.campaign_verdict.map((row) => ({ ...row })),
        fields: [
          text("verdict_title", "Verdict"),
          whole("paid_customers", "Paid customers"),
          whole("paid_came_back", "Paid who came back"),
          whole("paid_simulated", "Paid simulated returns"),
          whole("held_customers", "Held-back customers"),
          whole("held_came_back", "Held back who came back"),
          whole("held_simulated", "Held-back simulated returns"),
          text("window_note", "Window"),
        ],
      },
    ],
  };
}
