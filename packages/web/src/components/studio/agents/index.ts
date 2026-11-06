import { createAiHarness, directLlmRunner, type AgAiHarnessSetup, type AgAiPromptStarter, type AgAnyAiAgentDefinition, type AgAnyAiAgentRunner } from "ag-studio";
import { studioAdapter } from "../studio-adapter";
import { analystAgent } from "./analyst";
import { leadAgent, MEND_LEAD } from "./lead";
import { analystTools, narrowed, READ_TOOL_DISPLAY, type PageFacts } from "./tools";

export { READ_TOOL_DISPLAY, type PageFacts };

export const PROMPT_STARTERS: readonly AgAiPromptStarter[] = [
  { label: "Did this campaign work?", prompt: "Did this campaign work?" },
  { label: "Who should I look at next?", prompt: "Who should I look at next?" },
  { label: "Add a chart of claimed against waiting", prompt: "Add a chart of claimed against waiting" },
];

/** text with everything from the heading from up to the heading to taken out. If either is missing the text stays whole, which costs tokens and nothing else. */
export function withoutSection(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + 1);
  return start === -1 || end === -1 ? text : `${text.slice(0, start)}${text.slice(end)}`;
}

type Trim = {
  /** A hard stop. Each turn resends the agent's whole prompt, so these also bound what one request can cost. */
  readonly maxTurns: number;
  readonly cut: readonly (readonly [from: string, to: string])[];
  readonly note: string;
  readonly drop?: readonly string[];
};

// The dashboard's agents stop at 150,000 of a demo session's tokens a day, and each round resends an agent's whole prompt
// and tool list, so each specialist loses the parts these jobs do not use: filters on the page, calculated columns, date
// grains, the size tables and the data notes the lead's hand-off already covers. It also gets a note that it can
// skip the checking rounds, which cost the most.
export const TRIMS = {
  planning: { maxTurns: 4, cut: [], note: "" },
  data: {
    maxTurns: 3,
    cut: [["## Iteration Budget", "## Guidelines"]],
    note: "Run one query, then call complete_task with the rows as they came back. Do not run another query to check them or to look for something else. The regulars table holds the first 50 of the worth-a-nudge list, so say so when you count from it. execute_query's schema lists the exact field ids, so skip view_schema when they are enough. You cannot add calculated columns here.",
    drop: ["create_expression", "update_expression", "delete_expression"],
  },
  page: {
    maxTurns: 4,
    cut: [
      ["## Data Overview", "## Loading Page State"],
      ["## Widget Sizing", "## Grid System"],
      ["## Page-Level Filters", "## Rules"],
    ],
    note: "Sizes: a chart is about 10 columns wide and 10 rows high, mend-verdict 12 by 11, mend-threads 14 by 11. The page already shown to you by view_page tells you where the last row ends: place new widgets below it. Call add_widget and complete_task together in one response, with the widget's id and type in the summary. Do not call view_page again unless add_widget failed. You cannot add page filters here.",
    drop: ["add_page_filter", "remove_page_filter"],
  },
  widget: {
    maxTurns: 4,
    cut: [
      ["## Data Overview", "## Widget Guidance"],
      ["## Time-Based Charts", "## Measures vs Dimensions"],
      ["## Widget Filters", "## CRITICAL"],
    ],
    note: "Go straight to configure_widget: its schema lists the exact field ids, so skip view_schema when they are enough. To show only some rows, call add_widget_filter with the isIn operator in the same response. Then call complete_task. A warning that required fields are not mapped, straight after a mapping that names them, is the check running before the widget redraws: do not configure again for it. Do not call view_widget after configuring unless configure_widget reported another problem.",
  },
} as const satisfies Record<string, Trim>;

function specialist(definition: AgAnyAiAgentDefinition, { maxTurns, cut, note, drop = [] }: Trim): AgAnyAiAgentRunner {
  return directLlmRunner<unknown>({
    ...definition,
    adapter: studioAdapter,
    maxTurns,
    instructions: (context, params) => {
      const text = cut.reduce((current, [from, to]) => withoutSection(current, from, to), definition.instructions?.(context, params) ?? "");
      return note === "" ? text : `${text}\n\n## On this dashboard\n${note}`;
    },
    tools: (context, params) => (definition.tools?.(context, params) ?? []).filter((tool) => !drop.includes(tool.name)).map((tool) => narrowed(tool, context.api)),
  });
}

/**
 * The team behind the chat panel: Mend's lead, Mend's analyst and Studio's four specialists, every one
 * running through the same adapter to POST /api/studio/turn. What an agent can do is the tool list it is
 * given here, and the route refuses any name outside its own list, so no agent can reach money.
 * update hands the analyst's tools the page's latest numbers.
 */
export function mendTeam(first: PageFacts): { readonly setup: AgAiHarnessSetup; readonly update: (facts: PageFacts) => void } {
  let facts = first;
  return {
    update: (next) => {
      facts = next;
    },
    setup: ({ api }) => {
      const reads = analystTools(api, () => facts);
      return createAiHarness(api, ({ builtIn }) => ({
        agents: [leadAgent(studioAdapter), analystAgent(studioAdapter, reads), specialist(builtIn.planning, TRIMS.planning), specialist(builtIn.data, TRIMS.data), specialist(builtIn.page, TRIMS.page), specialist(builtIn.widget, TRIMS.widget)],
        primary: MEND_LEAD,
        promptStarters: [...PROMPT_STARTERS],
      }));
    },
  };
}
