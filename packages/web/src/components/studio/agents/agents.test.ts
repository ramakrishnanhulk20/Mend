// Covers how the team's prompts and tools are cut down: taking a section out of a prompt, what Claude
// is shown for the filter, chart and hand-off tools with Studio's own tool left to do the work, a hand-off
// with its fields in the wrong place reaching Studio in the right one, a used widget id being refused, and
// the rules each of Mend's two agents is held to. Does NOT cover Studio's harness, or how a real model
// follows these prompts (scratchpad/redesign/proof-a4.mjs drives those live).
import type { AgAiTool, AgAiToolInvocation } from "ag-studio";
import { describe, expect, it, vi } from "vitest";
import { ANALYST_DESCRIPTION, ANALYST_INSTRUCTIONS } from "./analyst";
import { PROMPT_STARTERS, TRIMS, withoutSection } from "./index";
import { LEAD_INSTRUCTIONS } from "./lead";
import { asListFilter, asPlainChart, asPlainDelegate, narrowed, withFreshIds } from "./tools";

const CONTEXT = {} as Parameters<NonNullable<AgAiTool["execute"]>>[1];
const OK = { success: true as const, response: "done" };

function tool(name: string, parameters: unknown): AgAiTool & { readonly ran: AgAiToolInvocation[] } {
  const ran: AgAiToolInvocation[] = [];
  return {
    name,
    description: "Long words.",
    kind: "client",
    ran,
    schema: () => ({ name, description: "Long words.", parameters, kind: "client" }) as ReturnType<AgAiTool["schema"]>,
    execute: vi.fn(async (call: AgAiToolInvocation) => {
      ran.push(call);
      return OK;
    }),
  };
}

const parametersOf = (subject: AgAiTool) => subject.schema()?.parameters as unknown as { properties: Record<string, Record<string, unknown>>; $defs?: Record<string, unknown> };
const call = (args: Record<string, unknown>): AgAiToolInvocation => ({ toolCallId: "toolu_1", name: "x", args });

const CHART = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["patch"] },
    widgetId: { type: "string", enum: ["money"] },
    value: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["bar-chart-grouped"] },
        dataMapping: { type: "object", properties: { valueKey: { type: "array", items: { $ref: "#/$defs/Field" } } } },
        format: {
          type: "object",
          properties: {
            title: { $ref: "#/$defs/Title" },
            crossFilter: { type: "string", enum: ["none"] },
            style: { type: "object", properties: { theme: { $ref: "#/$defs/Axis" } } },
          },
        },
      },
    },
  },
  $defs: { Field: { $ref: "#/$defs/FieldIds" }, FieldIds: { type: "string", enum: ["campaign_money.usd"] }, Title: { type: "object" }, Axis: { type: "object" } },
};

const DELEGATE = {
  type: "object",
  properties: {
    type: {
      anyOf: [
        { type: "object", properties: { id: { type: "string", enum: ["mend_analyst"] } }, required: ["id"], description: "Explains results." },
        { type: "object", properties: { id: { type: "string", enum: ["page"] }, pageId: { type: "string", enum: ["campaign", "shop"] } }, required: ["id"], description: "Places widgets." },
        { type: "object", properties: { id: { type: "string", enum: ["widget"] }, widgetType: { type: "string" }, widgetId: { type: "string" } }, required: ["id", "widgetType", "widgetId"], description: "Configures a widget." },
      ],
    },
    instructions: { type: "string" },
  },
  required: ["type", "instructions"],
};

describe("withoutSection", () => {
  const TEXT = "Intro\n## One\nfirst\n## Two\nsecond\n## Three\nthird";

  it("takes out everything from one heading up to the next one named", () => {
    expect(withoutSection(TEXT, "## One", "## Three")).toBe("Intro\n## Three\nthird");
  });

  it("leaves the text whole when either heading is missing", () => {
    expect(withoutSection(TEXT, "## Nope", "## Three")).toBe(TEXT);
    expect(withoutSection(TEXT, "## One", "## Nope")).toBe(TEXT);
  });
});

describe("what Claude is shown", () => {
  it("offers the isIn filter alone, and Studio's own tool still runs the call", async () => {
    const real = tool("add_widget_filter", { type: "object", properties: { op: { type: "string" }, value: { anyOf: [{ $ref: "#/$defs/Huge" }] }, widgetId: { type: "string" } }, $defs: { Huge: { type: "object" } } });
    const shown = asListFilter(real);
    expect(JSON.stringify(parametersOf(shown).properties.value)).toContain('"enum":["isIn"]');
    expect(parametersOf(shown).$defs).toBeUndefined();
    await shown.execute?.(call({ op: "append" }), CONTEXT);
    expect(real.ran).toHaveLength(1);
  });

  it("offers a chart's data and title without its look, keeping every definition still in use", () => {
    const format = parametersOf(asPlainChart(tool("configure_widget", CHART))).properties.value.properties as Record<string, { properties: object }>;
    const defs = parametersOf(asPlainChart(tool("configure_widget", CHART))).$defs;
    expect(Object.keys(format.format.properties)).toEqual(["title", "crossFilter"]);
    expect(Object.keys(defs ?? {}).sort()).toEqual(["Field", "FieldIds", "Title"]);
  });

  it("leaves a widget that is not a chart alone, because a text widget's words live in its style", () => {
    const text = { ...CHART, properties: { ...CHART.properties, value: { ...CHART.properties.value, properties: { ...CHART.properties.value.properties, type: { type: "string", enum: ["text"] } } } } };
    const real = tool("configure_widget", text);
    expect(narrowed(real, { getState: () => ({ pages: [] }) as never })).toBe(real);
  });

  it("offers one target object with every agent and field in it", () => {
    const type = parametersOf(asPlainDelegate(tool("delegate_to", DELEGATE))).properties.type as { properties: Record<string, { enum?: string[]; description?: string }>; required: string[]; anyOf?: unknown };
    expect(type.anyOf).toBeUndefined();
    expect(type.required).toEqual(["id"]);
    expect(type.properties.id.enum).toEqual(["mend_analyst", "page", "widget"]);
    expect(type.properties.id.description).toContain("page: Places widgets.");
    expect(Object.keys(type.properties).sort()).toEqual(["id", "pageId", "widgetId", "widgetType"]);
  });
});

describe("a hand-off", () => {
  const instructions = "Configure it.";

  it("passes a well-formed one to Studio unchanged", async () => {
    const real = tool("delegate_to", DELEGATE);
    const args = { type: { id: "page", pageId: "shop" }, instructions };
    await asPlainDelegate(real).execute?.(call(args), CONTEXT);
    expect(real.ran[0].args).toEqual(args);
  });

  it("gathers a target's fields left beside type, as a live run sent them", async () => {
    const real = tool("delegate_to", DELEGATE);
    await asPlainDelegate(real).execute?.(call({ type: { id: "widget" }, pageId: "campaign", widgetType: "column-chart-grouped", widgetId: "w-chart", instructions }), CONTEXT);
    expect(real.ran[0].args).toEqual({ type: { id: "widget", pageId: "campaign", widgetType: "column-chart-grouped", widgetId: "w-chart" }, instructions });
  });

  it("builds the target when type was left out, as a live run sent it", async () => {
    const real = tool("delegate_to", DELEGATE);
    await asPlainDelegate(real).execute?.(call({ id: "page", pageId: "shop", instructions }), CONTEXT);
    expect(real.ran[0].args).toEqual({ type: { id: "page", pageId: "shop" }, instructions });
  });

  it("carries nothing else across", async () => {
    const real = tool("delegate_to", DELEGATE);
    await asPlainDelegate(real).execute?.(call({ type: { id: "page" }, instructions, extra: "x" }), CONTEXT);
    expect(real.ran[0].args).toEqual({ type: { id: "page" }, instructions });
  });
});

describe("withFreshIds", () => {
  const api = { getState: () => ({ pages: [{ id: "shop", widgets: { top: {} } }, { id: "campaign", widgets: { claimed: {} } }] }) } as never;

  it("refuses an id already on any page, leaving that widget alone", async () => {
    const real = tool("add_widget", {});
    const answer = await withFreshIds(real, api).execute?.(call({ widgetId: "claimed" }), CONTEXT);
    expect(answer).toMatchObject({ success: false, issues: [{ message: expect.stringContaining("already on the dashboard") }] });
    expect(real.ran).toEqual([]);
  });

  it("lets a new id through to Studio", async () => {
    const real = tool("add_widget", {});
    expect(await withFreshIds(real, api).execute?.(call({ widgetId: "w-claimed-waiting" }), CONTEXT)).toBe(OK);
    expect(real.ran).toHaveLength(1);
  });
});

describe("the team's words", () => {
  it("tells the analyst to say plainly when no campaign has been sent", () => {
    expect(ANALYST_INSTRUCTIONS).toContain("say plainly that no campaign has been sent yet");
  });

  it("tells the analyst and the data agent the regulars table is the first 50", () => {
    expect(ANALYST_INSTRUCTIONS).toContain("first 50 of the worth-a-nudge list");
    expect(TRIMS.data.note).toContain("first 50 of the worth-a-nudge list");
  });

  it("gives the lead the analyst's hand-off description, word for word", () => {
    expect(ANALYST_DESCRIPTION).toBe("Explains whether a campaign worked and what to do next, from Mend's live numbers.");
  });

  it("holds the analyst to the honesty rules", () => {
    for (const rule of ["before you state a number", "word for word", "Never say a campaign worked unless", "too early to tell", "Never call one real", "no way to pay, approve, cancel or message anyone"]) {
      expect(ANALYST_INSTRUCTIONS).toContain(rule);
    }
  });

  it("names Mend's two widgets so the page agent can place them", () => {
    expect(LEAD_INSTRUCTIONS).toContain("mend-verdict");
    expect(LEAD_INSTRUCTIONS).toContain("mend-threads");
  });

  it("opens on the three starters", () => {
    expect(PROMPT_STARTERS.map((starter) => starter.prompt)).toEqual(["Did this campaign work?", "Who should I look at next?", "Add a chart of claimed against waiting"]);
  });
});
