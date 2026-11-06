import type { AgDefaultWidgetDefinition, AgExternalShape, AgFormatShapeParams, AgSortConfig, AgWidgetData, AgWidgetDataFormat, AgWidgetFieldReference, AgWidgetsConfig } from "ag-studio";
import { createWidgets, type AgRegistry, type AgWidgetDefinition } from "ag-studio-react";
import { THREADS_MAPPING, THREADS_WIDGET, VERDICT_MAPPING, VERDICT_WIDGET } from "../dashboard-report";
import { ThreadsWidget } from "./ThreadsWidget";
import { VerdictWidget } from "./VerdictWidget";

// Mend's two own widgets, built on Studio's custom widget API so the edit panel and the AI agents handle them like any built-in one.

export const MEND_MENU_GROUP = "Mend";

type Fields = AgWidgetFieldReference[];

export interface VerdictWidgetState extends AgWidgetData<Record<"title" | "paidCustomers" | "paidCameBack" | "paidSimulated" | "heldCustomers" | "heldCameBack" | "heldSimulated" | "windowNote", Fields>, AgWidgetDataFormat<unknown>> {
  type: typeof VERDICT_WIDGET;
  sort?: AgSortConfig[];
}

export interface ThreadsWidgetState extends AgWidgetData<Record<"rank" | "name" | "status" | "cameBack" | "simulated" | "amount", Fields>, AgWidgetDataFormat<unknown>> {
  type: typeof THREADS_WIDGET;
  sort?: AgSortConfig[];
}

type VerdictDefinition = AgWidgetDefinition<typeof VERDICT_WIDGET, VerdictWidgetState>;
type ThreadsDefinition = AgWidgetDefinition<typeof THREADS_WIDGET, ThreadsWidgetState>;

export interface MendRegistry extends AgRegistry {
  widgets: readonly (AgDefaultWidgetDefinition | VerdictDefinition | ThreadsDefinition)[];
}

type FormatShape = AgExternalShape<AgWidgetDataFormat<unknown>>;

/**
 * What Studio keeps and what the AI may set in a Mend widget's format: the three titles and how the
 * widget answers other widgets' selections. Studio's own shape builder is not handed to a custom widget,
 * so the shape comes from a command's input, which is built by that same builder.
 */
function mendFormatShape(params: AgFormatShapeParams): FormatShape {
  const command = params.api.defineAiCommand((s) => {
    const typography = s.object({
      fontFamily: s.string().optional(),
      fontSize: s.number().optional(),
      fontWeight: s.enum(["normal", "bold"]).optional(),
      fontStyle: s.enum(["normal", "italic"]).optional(),
    });
    const title = s.object({
      enabled: s.boolean().optional(),
      text: s.string().optional(),
      typography: typography.optional(),
      color: s.string().optional(),
      textAlign: s.enum(["left", "center", "right"]).optional(),
      wrapping: s.boolean().optional(),
    });
    const widget = s.object({
      backgroundColor: s.string().optional(),
      borderRadius: s.number().optional(),
      borderEnabled: s.boolean().optional(),
      borderWidth: s.number().optional(),
      borderColor: s.string().optional(),
    });
    return {
      input: s.object({
        title: title.optional(),
        subtitle: title.optional(),
        caption: title.optional(),
        widget: widget.optional(),
        crossFilter: s.enum(["highlight", "filter", "none"]).optional(),
      }),
      execute: () => ({ success: true as const, value: undefined }),
    };
  });
  return command.shape as unknown as FormatShape;
}

const category = (aiDescription: string, required = true) => ({ type: "field" as const, supportedRoles: ["category" as const], requires: { cardinality: "many" as const }, required, aiDescription });
const count = (aiDescription: string, required = true) => ({ type: "field" as const, supportedRoles: ["numeric" as const], requires: { cardinality: "one" as const }, required, aiDescription });

const ICON_INK = "var(--ag-foreground-color, #123B3F)";

const VERDICT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="none" viewBox="0 0 32 32"><path d="M3 11h26" stroke="#D72A16" stroke-width="3" stroke-linecap="round"/><path d="M13 8l6 6M19 8l-6 6" stroke="#D72A16" stroke-width="2" stroke-linecap="round"/><path d="M3 23h9M20 23h9" stroke="${ICON_INK}" stroke-opacity=".55" stroke-width="2" stroke-linecap="round"/><circle cx="14.5" cy="23" r="1" fill="${ICON_INK}"/><circle cx="16" cy="23" r="1" fill="${ICON_INK}"/><circle cx="17.5" cy="23" r="1" fill="${ICON_INK}"/></svg>`;

const THREADS_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="none" viewBox="0 0 32 32"><path d="M3 7h26" stroke="#D72A16" stroke-width="2" stroke-linecap="round"/><path d="M14 4.5l5 5M19 4.5l-5 5" stroke="#D72A16" stroke-width="1.6" stroke-linecap="round"/><path d="M3 16h26" stroke="${ICON_INK}" stroke-opacity=".55" stroke-width="2" stroke-linecap="round"/><path d="M14 13.5l5 5M19 13.5l-5 5" stroke="${ICON_INK}" stroke-width="1.6" stroke-linecap="round"/><path d="M3 25h8M21 25h8" stroke="${ICON_INK}" stroke-opacity=".55" stroke-width="2" stroke-linecap="round"/></svg>`;

const VERDICT_DEFINITION: VerdictDefinition = {
  id: VERDICT_WIDGET,
  label: "Did it work?",
  icon: VERDICT_ICON,
  dataMapping: {
    title: category("The verdict in words, for example Too early to tell."),
    paidCustomers: count("How many customers were paid."),
    paidCameBack: count("How many of the paid customers really came back."),
    paidSimulated: count("How many paid customers came back by a simulated purchase. Shown apart from real returns.", false),
    heldCustomers: count("How many customers were held back and never paid."),
    heldCameBack: count("How many of the held-back customers really came back."),
    heldSimulated: count("How many held-back customers came back by a simulated purchase. Shown apart from real returns.", false),
    windowNote: category("The line about the counting window, for example the days it covers and whether it is open.", false),
  },
  formatShape: mendFormatShape,
  form: (params) =>
    params.createDefaults({
      dataMappingItems: [
        { key: "title", label: "Verdict words" },
        { key: "paidCustomers", label: "Paid customers" },
        { key: "paidCameBack", label: "Paid who came back" },
        { key: "paidSimulated", label: "Paid simulated returns" },
        { key: "heldCustomers", label: "Held-back customers" },
        { key: "heldCameBack", label: "Held back who came back" },
        { key: "heldSimulated", label: "Held-back simulated returns" },
        { key: "windowNote", label: "Window line" },
      ],
    }),
  defaultState: {
    dataMapping: VERDICT_MAPPING,
    format: { title: { enabled: true, text: "Did it work?", wrapping: true }, crossFilter: "none" },
  },
  comp: VerdictWidget,
  defaultSize: { width: 640, height: 320 },
  minSize: { width: 280, height: 240 },
  ai: {
    label: "Did it work?",
    description: "The verdict on a cashback campaign in words, then one thread for the paid group and one for the held-back group, each with how many customers came back.",
    usage:
      "Use it on the campaign page to answer whether the cashback worked. It reads one row, the campaign_verdict table. It shows a share of customers only when Mend has a verdict, so it never suggests a result while the verdict says too early to tell.",
    configuration:
      "Map each slot to the field of the same name in campaign_verdict. Counts use the sum. Leave cross filtering off so the widget always covers the whole campaign.",
  },
};

const THREADS_DEFINITION: ThreadsDefinition = {
  id: THREADS_WIDGET,
  label: "Every customer's thread",
  icon: THREADS_ICON,
  dataMapping: {
    rank: { type: "field", supportedRoles: ["category", "numeric"], requires: { cardinality: "many" }, required: true, sort: true, aiDescription: "The customer's rank. Orders the threads and tells one customer from another." },
    name: category("The customer's name."),
    status: category("Where the customer's payment stands, in words. A click on a thread filters the page by this field."),
    cameBack: category("Yes when the customer really came back, otherwise No."),
    simulated: category("Yes when the customer came back by a simulated purchase, otherwise No."),
    amount: count("What the customer was paid. Empty for a held-back customer."),
  },
  formatShape: mendFormatShape,
  form: (params) =>
    params.createDefaults({
      supportsCrossHighlight: true,
      dataMappingItems: [
        { key: "rank", label: "Rank" },
        { key: "name", label: "Name" },
        { key: "status", label: "Payment" },
        { key: "cameBack", label: "Came back" },
        { key: "simulated", label: "Simulated return" },
        { key: "amount", label: "Amount" },
      ],
    }),
  defaultState: {
    dataMapping: THREADS_MAPPING,
    format: { title: { enabled: true, text: "Every customer's thread", wrapping: true }, crossFilter: "highlight" },
  },
  comp: ThreadsWidget,
  featureConfig: { crossFilter: { supportsHighlight: true } },
  defaultSize: { width: 760, height: 320 },
  minSize: { width: 280, height: 160 },
  ai: {
    label: "Every customer's thread",
    description: "One thread for each customer in a campaign: the name, a thread that shows where the payment stands, and the amount. A thread dotted all the way is a customer held back.",
    usage:
      "Use it to see every customer in the latest campaign at once. Clicking a thread filters the page by that payment status, so the table and charts on the same table follow.",
    configuration:
      "Map each slot to the field of the same name in campaign_customers. Amount uses the sum. Highlight is the right cross filter setting: it dims the customers a selection leaves out instead of hiding them.",
  },
};

export const MEND_WIDGET_DEFINITIONS = [VERDICT_DEFINITION, THREADS_DEFINITION] as const;

/** The widgets Studio is given: its own set plus the Mend group, first in the menu. Built once so Studio is never handed a new one. */
export const mendWidgets = (defaults: AgWidgetsConfig): AgWidgetsConfig<MendRegistry> =>
  createWidgets<MendRegistry>({
    additionalTypes: [VERDICT_DEFINITION, THREADS_DEFINITION],
    menu: [{ label: MEND_MENU_GROUP, widgetIds: [VERDICT_WIDGET, THREADS_WIDGET] }, ...defaults.menu],
  });
