import type { AgAiTool, AgStudioApi } from "ag-studio";
import { groupName, groupRule, GROUPS } from "../../proof/groups";
import type { ForecastBands } from "../../live/summary";
import type { CampaignMoneyRow, CampaignVerdictRow, DashboardData, ForecastGroupRow, ProofGroupRow } from "../dashboard-data";

// The analyst's three tools. Each one hands back rows the page already holds and nothing else: no fetch,
// no write, no parameters. That is the whole safety line for them, so a new tool here must keep to it.

export const READ_TOOLS = ["read_campaign_result", "read_forecast_groups", "read_money"] as const;

export const NO_CAMPAIGN = "No campaign has been sent yet, so there is nothing to judge.";

/** What the page holds at the moment a tool runs. bands is null until the shop summary has said where the groups split. */
export type PageFacts = { readonly data: DashboardData; readonly bands: ForecastBands | null };

function rows<Row>(data: DashboardData, table: string): readonly Row[] {
  const source = data.sources.find((candidate) => candidate.id === table);
  return Array.isArray(source?.data) ? (source.data as Row[]) : [];
}

/** The rule that puts a customer in each forecast group, in the words the Proof step uses, by group name. */
function ruleWords(bands: ForecastBands | null): Readonly<Record<string, string>> {
  if (bands === null) return {};
  return Object.fromEntries(GROUPS.map((key) => [groupName(key), groupRule(key, bands)]));
}

export type ToolAnswer<Data> = { readonly response: string; readonly data: Data };

export function campaignResult({ data }: PageFacts): ToolAnswer<CampaignVerdictRow | null> {
  const verdict = rows<CampaignVerdictRow>(data, "campaign_verdict")[0];
  if (verdict === undefined) return { response: NO_CAMPAIGN, data: null };
  return { response: "The latest campaign's verdict. Real and simulated returns are separate columns.", data: verdict };
}

export type ForecastGroups = {
  readonly forecast_groups: readonly (ForecastGroupRow & { readonly rule: string | null })[];
  readonly proof_groups: readonly ProofGroupRow[];
};

export function forecastGroups({ data, bands }: PageFacts): ToolAnswer<ForecastGroups> {
  const rules = ruleWords(bands);
  return {
    response: "Today's quiet regulars by forecast group, and the share of each group who came back on their own in past orders.",
    data: {
      forecast_groups: rows<ForecastGroupRow>(data, "forecast_groups").map((row) => ({ ...row, rule: rules[row.group] ?? null })),
      proof_groups: rows<ProofGroupRow>(data, "proof_groups"),
    },
  };
}

export function money({ data }: PageFacts): ToolAnswer<readonly CampaignMoneyRow[]> {
  const figures = rows<CampaignMoneyRow>(data, "campaign_money");
  return { response: figures.length === 0 ? NO_CAMPAIGN : "Where the latest campaign's money is, in US dollars.", data: figures };
}

const DESCRIPTIONS: Readonly<Record<(typeof READ_TOOLS)[number], string>> = {
  read_campaign_result: "Read the latest campaign's verdict: the verdict words, how many customers each group holds, how many of each came back, and the counting window. Says so when no campaign is open.",
  read_forecast_groups: "Read how many quiet regulars sit in each forecast group today, the rule for each group, and how each group behaved in past orders.",
  read_money: "Read where the latest campaign's money is: claimed, waiting, returned to the shop, and PayPal fees.",
};

/** The three tools for one Studio. facts is called each time a tool runs, so an answer is never older than the page. */
export function analystTools(api: Pick<AgStudioApi, "defineAiTool">, facts: () => PageFacts): readonly AgAiTool[] {
  const answers = { read_campaign_result: campaignResult, read_forecast_groups: forecastGroups, read_money: money };
  return READ_TOOLS.map((name) =>
    api.defineAiTool({
      name,
      description: DESCRIPTIONS[name],
      params: (s) => s.object({}),
      execute: (_args, ctx) => {
        const { response, data } = answers[name](facts());
        return Promise.resolve(ctx.success(response, data));
      },
    }),
  );
}

type Parameters = Record<string, unknown> & { readonly properties: Record<string, Parameters>; readonly $defs?: Readonly<Record<string, unknown>> };

/** parameters with only the $defs something in it still points to. */
function withDefsInUse({ $defs = {}, ...rest }: Parameters): Parameters {
  const kept: Record<string, unknown> = {};
  const pending = [JSON.stringify(rest)];
  for (let text = pending.pop(); text !== undefined; text = pending.pop()) {
    for (const [, name] of text.matchAll(/"#\/\$defs\/([^"]+)"/g)) {
      if (name in kept || !(name in $defs)) continue;
      kept[name] = $defs[name];
      pending.push(JSON.stringify($defs[name]));
    }
  }
  return (Object.keys(kept).length === 0 ? rest : { ...rest, $defs: kept }) as Parameters;
}

/** tool as Claude sees it, with what it advertises changed. The tool itself is untouched, so Studio still checks each call against its full schema when it runs. */
function advertised(tool: AgAiTool, change: (parameters: Parameters) => Parameters, description?: string): AgAiTool {
  const words = description === undefined ? {} : { description };
  return {
    ...tool,
    ...words,
    schema: () => {
      const schema = tool.schema();
      if (schema === undefined) return undefined;
      return { ...schema, ...words, parameters: withDefsInUse(change(schema.parameters as unknown as Parameters)) } as ReturnType<AgAiTool["schema"]>;
    },
  };
}

const LIST_FILTER = {
  type: "object",
  properties: {
    field: { type: "object", properties: { id: { type: "string", description: "Field id, for example campaign_money.state." } }, required: ["id"], additionalProperties: false },
    model: { type: "object", properties: { operator: { type: "string", enum: ["isIn"] }, value: { type: "array", items: { type: "string" } } }, required: ["operator", "value"], additionalProperties: false },
  },
  required: ["field", "model"],
  additionalProperties: false,
} as unknown as Parameters;

// Studio's schema for this tool spells out every filter on every kind of field, about 10,000 tokens on every round. Claude is shown the one kind this team needs.
export function asListFilter(tool: AgAiTool): AgAiTool {
  return advertised(tool, (parameters) => ({ ...parameters, properties: { ...parameters.properties, value: LIST_FILTER } }), "Keep only the rows of a widget whose field holds one of the listed values.");
}

// About 5,000 tokens on every round describe a chart's look. Claude sets what a chart shows and its title, and the look stays the dashboard's theme.
export function asPlainChart(tool: AgAiTool): AgAiTool {
  return advertised(tool, (parameters) => {
    const value = parameters.properties.value;
    const { title, crossFilter } = value.properties.format.properties;
    const format = { ...value.properties.format, properties: { title, crossFilter } };
    return { ...parameters, properties: { ...parameters.properties, value: { ...value, properties: { ...value.properties, format } } } };
  });
}

const TARGET_FIELDS = ["id", "pageId", "widgetType", "widgetId"];

// In live runs Claude put a target's fields beside "type", or left "type" out, and Studio refused each one as no target. Moving them in leaves Studio's own check of the target as it was.
function targetInOnePlace({ type, instructions, ...rest }: Record<string, unknown>): Record<string, unknown> {
  const beside = Object.fromEntries(Object.entries(rest).filter(([key]) => TARGET_FIELDS.includes(key)));
  return { type: { ...beside, ...(typeof type === "object" && type !== null ? type : {}) }, instructions };
}

type Target = { readonly properties: Record<string, { readonly enum?: readonly string[] }>; readonly description?: string };

function oneTarget(parameters: Parameters): Parameters {
  const type = parameters.properties.type as unknown as Target & { readonly anyOf?: readonly Target[] };
  const targets = type.anyOf ?? [type];
  const ids = targets.flatMap((target) => target.properties.id.enum ?? []);
  const fields = Object.fromEntries(targets.flatMap((target) => Object.entries(target.properties)).filter(([key]) => key !== "id"));
  const description = targets.map((target, index) => `${ids[index]}: ${target.description}`).join(" ");
  const target = { type: "object", description: "Who gets the task. Every field about the target goes inside this object.", properties: { id: { type: "string", enum: ids, description }, ...fields }, required: ["id"], additionalProperties: false };
  return { ...parameters, properties: { ...parameters.properties, type: target as unknown as Parameters } };
}

/** The hand-off tool with its one awkward field as a plain object, and a target's fields gathered up before Studio reads them. */
export function asPlainDelegate(tool: AgAiTool): AgAiTool {
  return { ...advertised(tool, oneTarget), execute: (call, context) => (tool.execute as NonNullable<AgAiTool["execute"]>)({ ...call, args: targetInOnePlace(call.args) }, context) };
}

/** add_widget replaces whatever already has the id it is given, so a used id is refused instead. */
export function withFreshIds(tool: AgAiTool, api: Pick<AgStudioApi, "getState">): AgAiTool {
  return {
    ...tool,
    execute: (call, context) => {
      const id = String(call.args.widgetId);
      if (api.getState().pages.some((page) => page.widgets?.[id] !== undefined)) return Promise.resolve({ success: false, issues: [{ message: `A widget called ${id} is already on the dashboard. Use a new id that starts with w-.` }] });
      return (tool.execute as NonNullable<AgAiTool["execute"]>)(call, context);
    },
  };
}

/** One of Studio's tools as this team uses it. */
export function narrowed(tool: AgAiTool, api: Pick<AgStudioApi, "getState">): AgAiTool {
  if (tool.name === "add_widget_filter") return asListFilter(tool);
  if (tool.name === "add_widget") return withFreshIds(tool, api);
  if (tool.name !== "configure_widget") return tool;
  const type = (tool.schema()?.parameters as unknown as Parameters | undefined)?.properties.value?.properties?.type;
  return JSON.stringify(type).includes("chart") ? asPlainChart(tool) : tool;
}


