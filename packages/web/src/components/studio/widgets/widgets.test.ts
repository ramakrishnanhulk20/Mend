// Covers what Studio is told about Mend's two widgets and how the dashboard report places them: ids, field slots,
// AI notes, the menu group, that every mapped field exists in the data, and that a widget on the regulars table says
// it counts the top 50. Does NOT cover how they draw or click; that is checked in the browser.
import { describe, expect, it } from "vitest";
import { dashboardData } from "../dashboard-data";
import { dashboardReport, THREADS_MAPPING, THREADS_WIDGET, VERDICT_MAPPING, VERDICT_WIDGET } from "../dashboard-report";
import { MEND_MENU_GROUP, MEND_WIDGET_DEFINITIONS, mendWidgets } from "./index";

const NOTHING = { summary: null, regulars: null, view: null, results: null };
// Only the menu of Studio's own widgets is read from what Studio passes in.
const defaults = { widgets: [], menu: [{ label: "Everything else", widgetIds: ["grid"] }], defaultType: "grid" } as unknown as Parameters<typeof mendWidgets>[0];

function fieldExists(reference: { readonly id: string }): boolean {
  const [table, field] = reference.id.split(".");
  const source = dashboardData(NOTHING).sources.find((item) => item.id === table);
  return (source?.fields ?? []).some((item) => item.id === field);
}

describe("the shop page", () => {
  it("says top 50 on every widget that reads the regulars table", () => {
    const shop = dashboardReport({ selected: "shop", narrow: false, source: null }).pages.find((page) => page.id === "shop");
    const titleOf = (id: string) => (shop?.widgets?.[id] as { format?: { title?: { text?: string } } } | undefined)?.format?.title?.text;
    expect(titleOf("top")).toBe("Top 50 quiet regulars");
    expect(titleOf("payable")).toBe("Who can be paid, top 50");
    expect(titleOf("silent")).toBe("Silent days against expected orders, top 50");
  });
});

describe("the two Mend widget definitions", () => {
  const [verdict, threads] = MEND_WIDGET_DEFINITIONS;

  it("carry everything Studio and its agents need", () => {
    for (const definition of MEND_WIDGET_DEFINITIONS) {
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.icon).toContain("<svg");
      expect(typeof definition.form).toBe("function");
      expect(typeof definition.formatShape).toBe("function");
      expect(definition.comp).toBeTypeOf("function");
      expect(definition.defaultSize.width).toBeGreaterThan(definition.minSize.width);
      expect(definition.defaultSize.height).toBeGreaterThan(definition.minSize.height);
      expect(definition.ai?.description?.length).toBeGreaterThan(20);
      expect(definition.ai?.usage?.length).toBeGreaterThan(20);
      expect(definition.ai?.configuration?.length).toBeGreaterThan(20);
      expect(definition.defaultState?.format?.title?.enabled).toBe(true);
    }
  });

  it("use the ids the dashboard report places", () => {
    expect(verdict.id).toBe(VERDICT_WIDGET);
    expect(threads.id).toBe(THREADS_WIDGET);
    expect(verdict.defaultState?.format?.title?.text).toBe("Did it work?");
    expect(threads.defaultState?.format?.title?.text).toBe("Every customer's thread");
  });

  it("map every slot to a field the data has, so a widget added from the menu shows data at once", () => {
    for (const definition of MEND_WIDGET_DEFINITIONS) {
      const slots = Object.keys(definition.dataMapping ?? {}).sort();
      expect(Object.keys(definition.defaultState?.dataMapping ?? {}).sort()).toEqual(slots);
    }
    for (const reference of [...Object.values(VERDICT_MAPPING), ...Object.values(THREADS_MAPPING)].flat()) {
      expect(fieldExists(reference), reference.id).toBe(true);
    }
  });

  it("ask for a sum only on the number slots and never on a word slot", () => {
    for (const definition of MEND_WIDGET_DEFINITIONS) {
      for (const [slot, rule] of Object.entries(definition.dataMapping ?? {})) {
        const wantsSum = rule.supportedRoles.length === 1 && rule.supportedRoles[0] === "numeric";
        expect(rule.requires?.cardinality, slot).toBe(wantsSum ? "one" : "many");
      }
    }
  });

  it("leave the verdict widget's simulated counts and window line optional and the rest required", () => {
    const rules = verdict.dataMapping;
    if (rules === undefined) throw new Error("the verdict widget has no data mapping");
    expect(rules.paidSimulated.required).toBe(false);
    expect(rules.heldSimulated.required).toBe(false);
    expect(rules.windowNote.required).toBe(false);
    expect(rules.title.required).toBe(true);
    expect(rules.paidCameBack.required).toBe(true);
  });

  it("write no em-dash anywhere a reader or an agent sees", () => {
    const dash = String.fromCharCode(0x2014);
    for (const definition of MEND_WIDGET_DEFINITIONS) {
      expect(JSON.stringify({ label: definition.label, ai: definition.ai, state: definition.defaultState, icon: definition.icon })).not.toContain(dash);
    }
  });
});

describe("mendWidgets", () => {
  it("adds both definitions and puts the Mend group first in the menu", () => {
    const config = mendWidgets(defaults);
    expect(config.menu[0]).toEqual({ label: MEND_MENU_GROUP, widgetIds: [VERDICT_WIDGET, THREADS_WIDGET] });
    expect(config.menu[1].label).toBe("Everything else");
    const ids = config.widgets.map((definition) => definition.id);
    expect(ids).toContain(VERDICT_WIDGET);
    expect(ids).toContain(THREADS_WIDGET);
    expect(ids).toContain("grid");
  });
});

describe("the campaign page", () => {
  const campaign = (narrow: boolean) => {
    const report = dashboardReport({ selected: "campaign", narrow, source: null });
    const page = report.pages.find((item) => item.id === "campaign");
    if (page === undefined) throw new Error("no campaign page");
    return page;
  };

  it("places the two widgets where the verdict and the thread chart were", () => {
    const page = campaign(false);
    expect(page.widgets?.verdict?.type).toBe(VERDICT_WIDGET);
    expect(page.widgets?.thread?.type).toBe(THREADS_WIDGET);
    expect(page.widgetLayout?.verdict).toEqual({ xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 11 });
    expect(page.widgetLayout?.thread).toEqual({ xTrack: 0, yTrack: 11, xSpan: 14, ySpan: 11 });
  });

  it("gives the same two widgets the page's full width, one under the other, on a phone", () => {
    const page = campaign(true);
    expect(page.widgetLayout?.verdict).toMatchObject({ xTrack: 0, xSpan: 24 });
    expect(page.widgetLayout?.thread).toMatchObject({ xTrack: 0, xSpan: 24 });
    expect(page.widgets?.verdict?.type).toBe(VERDICT_WIDGET);
    expect(page.widgets?.thread?.type).toBe(THREADS_WIDGET);
  });

  it("leaves the verdict widget unfiltered by other selections and the threads highlighted by them", () => {
    const page = campaign(false);
    expect(page.widgets?.verdict?.format?.crossFilter).toBe("none");
    expect(page.widgets?.thread?.format?.crossFilter).toBe("highlight");
  });
});
