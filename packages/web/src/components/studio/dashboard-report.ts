import type { AgPageLayoutState, AgPageState, AgReportState, AgWidgetState } from "ag-studio";
import type { MendRegistry, ThreadsWidgetState, VerdictWidgetState } from "./widgets";

// The dashboard's pages and widgets. To add a widget, add one entry to a page's list below: its
// narrow (phone) place is worked out from its kind, so only the wide place needs writing.

export type PageId = "campaign" | "shop" | "proof";

/** How many of the worth-a-nudge list the dashboard reads. Every title and description that counts them says this number. */
export const LIST_SIZE = 50;

export const PAGES: readonly { readonly id: PageId; readonly label: string }[] = [
  { id: "campaign", label: "This campaign" },
  { id: "shop", label: "The shop" },
  { id: "proof", label: "The proof" },
];

export const COLUMNS = 24;
const ROW_HEIGHT = 28;
// The page's floor on a phone. A 375px screen leaves about 305px beside the collapsed AI strip, so 320 would cut the right edge off.
const PHONE_MIN_WIDTH = 280;
const DISPLAY_FONT = "var(--font-fraunces)";
const KPI_SIZE = 38;
// Two figures share a 375px screen, and Studio shrinks a figure to half its size at most, so the long ones need to start smaller.
const KPI_SIZE_NARROW = 22;
// A 20px title does not fit a word like Customers in half a phone screen and breaks it in two.
const KPI_TITLE_SIZE_NARROW = 15;
const INK = "#123B3F";
/** The stitch colour from globals.css: the line round every widget. */
export const STITCH = "#CDBB95";

type Widget = AgWidgetState<MendRegistry>;
type Place = { readonly xTrack: number; readonly yTrack: number; readonly xSpan: number; readonly ySpan: number };
type Kind = "kpi" | "chart" | "table" | "text" | "verdict" | "threads";

type Entry = {
  readonly id: string;
  readonly kind: Kind;
  readonly widget: Widget;
  readonly wide: Place;
};

// Rows a widget takes when the page is one column wide, by kind.
const NARROW_ROWS: Record<Kind, number> = { kpi: 5, chart: 12, table: 14, text: 5, verdict: 13, threads: 16 };

const place = (xTrack: number, yTrack: number, xSpan: number, ySpan: number): Place => ({ xTrack, yTrack, xSpan, ySpan });

type Mapping = { readonly id: string; readonly aggregation?: "sum" | "count" };
const field = (id: string, aggregation?: "sum" | "count"): Mapping => (aggregation === undefined ? { id } : { id, aggregation });
/** The ids of Mend's two own widgets, as Studio knows them. */
export const VERDICT_WIDGET = "mend-verdict";
export const THREADS_WIDGET = "mend-threads";

// The same fields fill a widget added fresh from the menu and the widgets already on the page.
export const VERDICT_MAPPING: VerdictWidgetState["dataMapping"] = {
  title: [field("campaign_verdict.verdict_title")],
  paidCustomers: [field("campaign_verdict.paid_customers", "sum")],
  paidCameBack: [field("campaign_verdict.paid_came_back", "sum")],
  paidSimulated: [field("campaign_verdict.paid_simulated", "sum")],
  heldCustomers: [field("campaign_verdict.held_customers", "sum")],
  heldCameBack: [field("campaign_verdict.held_came_back", "sum")],
  heldSimulated: [field("campaign_verdict.held_simulated", "sum")],
  windowNote: [field("campaign_verdict.window_note")],
};

export const THREADS_MAPPING: ThreadsWidgetState["dataMapping"] = {
  rank: [field("campaign_customers.id")],
  name: [field("campaign_customers.name")],
  status: [field("campaign_customers.status")],
  cameBack: [field("campaign_customers.came_back")],
  simulated: [field("campaign_customers.simulated")],
  amount: [field("campaign_customers.amount_usd", "sum")],
};

// A donut with its category names beside the slices: the legend runs out of room in a narrow widget and pages itself.
const NAMED_SLICES = {
  theme: { common: { legend: { enabled: false } } },
  custom: { pieDataLabel: { enabled: true, category: true, position: "outside" as const, format: "value" as const } },
};
// Titles wrap rather than cut off, so every title reads in full whatever the width.
const title = (text: string) => ({ enabled: true, text, wrapping: true });

/** A big figure. Its own filter picks one row of the table, so four of them can share one table. */
function kpi(id: string, text: string, value: Mapping, wide: Place, narrow: boolean): Entry {
  return {
    id,
    kind: "kpi",
    wide,
    widget: {
      type: "value",
      dataMapping: { value: [value] },
      format: {
        title: narrow ? { ...title(text), typography: { fontSize: KPI_TITLE_SIZE_NARROW } } : title(text),
        crossFilter: "none",
        style: { typography: { fontFamily: DISPLAY_FONT, fontSize: narrow ? KPI_SIZE_NARROW : KPI_SIZE }, textScaling: { enabled: true }, verticalAlign: "center" },
      },
    },
  };
}

// Centred, because a text widget draws its words right up to the widget's edge and has no padding of its own.
function textWidget(id: string, text: string, wide: Place, size: number, caption?: string): Entry {
  return {
    id,
    kind: "text",
    wide,
    widget: {
      type: "text",
      dataMapping: {},
      format: {
        crossFilter: "none",
        ...(caption === undefined ? {} : { caption: { enabled: true, text: caption, textAlign: "center" as const } }),
        style: { text, typography: { fontFamily: DISPLAY_FONT, fontSize: size }, color: INK, verticalAlign: "center", textAlign: "center" },
      },
    },
  };
}

type PageSpec = {
  readonly id: PageId;
  readonly entries: readonly Entry[];
  readonly filter?: AgPageState<MendRegistry>["filter"];
};

export type ReportOptions = {
  readonly selected: PageId;
  /** True below 860px: every widget full width, KPIs two to a row. */
  readonly narrow: boolean;
  /** Where the proof's numbers were measured, from the shop summary. Null while it is not known. */
  readonly source: string | null;
};

const PROOF_NOTE = "Tested on a real shop's history. Every bar is read live from Mend's database.";

// The four money figures are one table, so each figure's own filter picks its row. 5.5 tracks high rounds to 6 above and 5 below.
const MONEY_FIGURES = [
  { id: "claimed", state: "Claimed", at: place(12, 0, 6, 6) },
  { id: "waiting", state: "Waiting", at: place(18, 0, 6, 6) },
  { id: "returned", state: "Returned", at: place(12, 6, 6, 5) },
  { id: "fees", state: "Fees", at: place(18, 6, 6, 5) },
] as const;

function campaignPage(options: ReportOptions): PageSpec {
  const usd = field("campaign_money.usd", "sum");
  return {
    id: "campaign",
    entries: [
      {
        id: "verdict",
        kind: "verdict",
        wide: place(0, 0, 12, 11),
        widget: { type: VERDICT_WIDGET, dataMapping: VERDICT_MAPPING, format: { title: title("Did it work?"), crossFilter: "none" } },
      },
      ...MONEY_FIGURES.map((figure) => kpi(figure.id, figure.state, usd, figure.at, options.narrow)),
      {
        id: "thread",
        kind: "threads",
        wide: place(0, 11, 14, 11),
        widget: { type: THREADS_WIDGET, dataMapping: THREADS_MAPPING, format: { title: title("Every customer's thread"), crossFilter: "highlight" } },
      },
      {
        id: "money",
        kind: "chart",
        wide: place(14, 11, 10, 11),
        widget: {
          type: "donut-chart",
          dataMapping: { categoryKey: [field("campaign_money.state")], valueKey: [usd] },
          format: { title: title("Where the money is"), crossFilter: "none" },
        },
      },
      {
        id: "everyone",
        kind: "table",
        wide: place(0, 22, 24, 11),
        widget: {
          type: "grid",
          dataMapping: {
            cols: ["id", "name", "arm", "amount_usd", "status", "came_back", "simulated"].map((name) => field(`campaign_customers.${name}`)),
          },
          // A table takes one sort field. Paid sorts above Held back this way, and the rows keep their rank order within each.
          sort: [{ field: field("campaign_customers.arm"), direction: "desc" }],
          format: { title: title("Everyone in this campaign"), crossFilter: "filter" },
        },
      },
    ],
    filter: {
      widget: Object.fromEntries(
        MONEY_FIGURES.map((figure) => [
          figure.id,
          [{ field: { id: "campaign_money.state" }, view: { expanded: false }, model: { operator: "isIn" as const, value: [figure.state] } }],
        ]),
      ),
    },
  };
}

function shopPage(options: ReportOptions): PageSpec {
  return {
    id: "shop",
    entries: [
      kpi("customers", "Customers", field("shop_totals.customers", "sum"), place(0, 0, 6, 4), options.narrow),
      kpi("quiet", "Quiet regulars", field("shop_totals.quiet_regulars", "sum"), place(6, 0, 6, 4), options.narrow),
      kpi("nudge", "Worth a nudge", field("shop_totals.worth_a_nudge", "sum"), place(12, 0, 6, 4), options.narrow),
      kpi("spent", "Spent by quiet regulars last year", field("shop_totals.spent_quiet_usd", "sum"), place(18, 0, 6, 4), options.narrow),
      {
        id: "forecast",
        kind: "chart",
        wide: place(0, 4, 10, 10),
        widget: {
          type: "bar-chart-stacked",
          dataMapping: {
            categoryKey: [field("forecast_groups.sort_order")],
            valueKey: [field("forecast_groups.customers", "sum")],
            legendKey: [field("forecast_groups.sort_order")],
          },
          format: { title: title("Quiet regulars by forecast group"), crossFilter: "none" },
        },
      },
      {
        id: "payable",
        kind: "chart",
        wide: place(10, 4, 6, 10),
        widget: {
          type: "donut-chart",
          dataMapping: { categoryKey: [field("regulars.list_status")], valueKey: [field("regulars.id", "count")] },
          format: { title: title(`Who can be paid, top ${LIST_SIZE}`), crossFilter: "highlight", style: NAMED_SLICES },
        },
      },
      {
        id: "silent",
        kind: "chart",
        wide: place(16, 4, 8, 10),
        widget: {
          type: "scatter-chart",
          dataMapping: {
            groupByKey: [field("regulars.id")],
            categoryKey: [field("regulars.days_silent", "sum")],
            valueKey: [field("regulars.expected_orders", "sum")],
            legendKey: [field("regulars.list_status")],
          },
          format: { title: title(`Silent days against expected orders, top ${LIST_SIZE}`), crossFilter: "filter" },
        },
      },
      {
        id: "top",
        kind: "table",
        wide: place(0, 14, 24, 12),
        widget: {
          type: "grid",
          dataMapping: {
            cols: ["id", "name", "purchase_days", "days_silent", "expected_orders", "spent_usd", "list_status"].map((name) => field(`regulars.${name}`)),
          },
          sort: [{ field: field("regulars.id"), direction: "asc" }],
          format: { title: title(`Top ${LIST_SIZE} quiet regulars`), crossFilter: "filter" },
        },
      },
    ],
  };
}

function proofPage(options: ReportOptions): PageSpec {
  return {
    id: "proof",
    entries: [
      {
        id: "came-back",
        kind: "chart",
        wide: place(0, 0, 12, 13),
        widget: {
          type: "bar-chart-stacked",
          dataMapping: {
            categoryKey: [field("proof_groups.sort_order")],
            valueKey: [field("proof_groups.share", "sum")],
            legendKey: [field("proof_groups.sort_order")],
          },
          format: { title: title("Quiet regulars who came back on their own"), crossFilter: "none" },
        },
      },
      {
        id: "deciles",
        kind: "chart",
        wide: place(12, 0, 12, 13),
        widget: {
          type: "column-chart-grouped",
          dataMapping: { categoryKey: [field("proof_deciles.decile")], valueKey: [field("proof_deciles.returned_share", "sum")] },
          format: { title: title("Who came back, by forecast group"), crossFilter: "none" },
        },
      },
      textWidget("proof-note", PROOF_NOTE, place(0, 13, 24, 4), options.narrow ? 15 : 18, sourceLine(options.source)),
    ],
  };
}

// Empty until the summary says where the numbers were measured.
function sourceLine(source: string | null): string {
  return source === null ? "" : `Data: ${source}`;
}

function pageState(spec: PageSpec, narrow: boolean): AgPageState<MendRegistry> {
  const widgets: Record<string, Widget> = {};
  const widgetLayout: Record<string, Place> = {};
  let nextRow = 0;
  let half: "left" | "right" = "left";
  for (const entry of spec.entries) {
    widgets[entry.id] = entry.widget;
    if (!narrow) {
      widgetLayout[entry.id] = entry.wide;
      continue;
    }
    const rows = NARROW_ROWS[entry.kind];
    if (entry.kind === "kpi") {
      widgetLayout[entry.id] = place(half === "left" ? 0 : COLUMNS / 2, nextRow, COLUMNS / 2, rows);
      if (half === "right") nextRow += rows;
      half = half === "left" ? "right" : "left";
      continue;
    }
    if (half === "right") {
      nextRow += NARROW_ROWS.kpi;
      half = "left";
    }
    widgetLayout[entry.id] = place(0, nextRow, COLUMNS, rows);
    nextRow += rows;
  }
  return { id: spec.id, widgets, widgetLayout, ...(spec.filter === undefined ? {} : { filter: spec.filter }) };
}

/** The whole report. Studio reads it once when it starts; later changes go in through setState. */
export function dashboardReport(options: ReportOptions): AgReportState<MendRegistry> {
  const specs = [campaignPage(options), shopPage(options), proofPage(options)];
  return {
    pages: specs.map((spec) => pageState(spec, options.narrow)),
    selectedPageId: options.selected,
    panels: { ai: { collapsed: options.narrow } },
  };
}

/**
 * Studio's page settings for the dashboard. A widget border is off until a page asks for it, and Studio
 * draws it solid whatever style the theme names, so the stitch colour goes in here as a plain 1.5px line.
 */
export function dashboardLayout(narrow: boolean): Partial<AgPageLayoutState> {
  return {
    columns: COLUMNS,
    rowHeight: ROW_HEIGHT,
    widgetBorderEnabled: true,
    widgetBorderWidth: 1.5,
    widgetBorderColor: STITCH,
    ...(narrow ? { minWidth: PHONE_MIN_WIDTH } : {}),
  };
}

/** The words that change as data arrives, by widget id. Everything else on the pages is fixed. */
export type ReportTexts = { readonly source: string | null };

function withCaption(page: AgPageState<MendRegistry>, id: string, text: string): AgPageState<MendRegistry> {
  const widget = page.widgets?.[id];
  if (widget === undefined || widget.type !== "text") return page;
  const format = widget.format;
  if (format?.caption?.text === text) return page;
  return { ...page, widgets: { ...page.widgets, [id]: { ...widget, format: { ...format, caption: { ...format?.caption, enabled: true, text } } } } };
}

/** The same state with the proof note brought up to date, or the very same object when it already is. */
export function withTexts(state: AgReportState<MendRegistry>, texts: ReportTexts): AgReportState<MendRegistry> {
  let changed = false;
  const pages = state.pages.map((page) => {
    let next = page;
    if (page.id === "proof") next = withCaption(next, "proof-note", sourceLine(texts.source));
    if (next !== page) changed = true;
    return next;
  });
  return changed ? { ...state, pages } : state;
}
