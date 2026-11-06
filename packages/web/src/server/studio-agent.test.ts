// Covers the one Claude call behind AG Studio's chat panel: the fixed model, output cap,
// thinking and effort, Studio's history and tool schemas as Claude reads them, emails
// removed before sending with Studio's field, table and widget references left whole, the
// allow-list of tool names, what the body schema refuses, text and tool calls as Studio's
// events and final response, a refusal, a cut-off answer and an empty answer running
// no tools, and the queue of one call at a time per demo session. Claude's answers come from
// a stubbed fetch playing back scripted turns, the
// token store from an in-memory stand-in for claude_usage. Does NOT cover: the route's
// guards and caps (app/api/studio/turn/route.test.ts), Studio's own loop or tools, or how
// the real model behaves (scratchpad/redesign/proof-a4.mjs drives those live).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  claude: [] as Record<string, unknown>[],
  turns: [] as { content: unknown[]; stop: string; status?: number }[],
  usage: new Map<string, number>(),
}));

vi.mock("./db", () => ({
  database: () => ({
    query: vi.fn(async (sql: string, params: unknown[]) => {
      const subjects = params[0] as string[];
      if (/insert into claude_usage/.test(sql)) {
        for (const subject of subjects) state.usage.set(subject, (state.usage.get(subject) ?? 0) + Number(params[1]) + Number(params[2]));
        return { rows: [] };
      }
      if (/from claude_usage/.test(sql)) return { rows: subjects.filter((subject) => state.usage.has(subject)).map((subject) => ({ subject, used: String(state.usage.get(subject)) })) };
      throw new Error("these tests have no database for that query");
    }),
  }),
}));

vi.mock("./ratelimit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ratelimit")>()),
  takeHit: vi.fn(async () => ({ allowed: true })),
}));

const { claudeMessages, runStudioTurn, STUDIO_MAX_TOKENS, STUDIO_TOOLS, STUDIO_WALL_MS, TURN_BODY } = await import("./studio-agent");
const { FAILURE_MESSAGES, MODEL, outboundProblem } = await import("./claude");

const DEMO = { role: "demo" as const, sessionId: "d".repeat(64), expiresAt: new Date(Date.now() + 60_000) };
const OWNER = { role: "owner" as const, sessionId: "e".repeat(64), expiresAt: new Date(Date.now() + 60_000) };
const REF = "6f1c1d3e-2b9a-4f0e-9a51-3c1d2e4f5a6b";
const ADDRESS = "198.51.100.7";
const ASK = { id: "msg-1", kind: "input", type: "message", role: "user", content: [{ type: "text", text: "Add a chart" }], status: "completed" } as const;
const VIEW_SCHEMA = { name: "view_schema", description: "See the data.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, kind: "client" } as const;
// A piece of the real execute_query schema's shape: $defs, $ref, anyOf and the { not: {} } marker Studio uses for optional.
const EXECUTE_QUERY = {
  name: "execute_query",
  description: "Run a query.",
  parameters: { type: "object", properties: { limit: { anyOf: [{ type: "number" }, { not: {} }] }, field: { $ref: "#/$defs/field" } }, required: ["field"], additionalProperties: false, $defs: { field: { type: "string" } } },
  kind: "client",
} as const;

function body(extra: Record<string, unknown> = {}) {
  return TURN_BODY.parse({ input: [ASK], responseFormat: { type: "text" }, ...extra });
}

beforeEach(() => {
  state.claude = [];
  state.turns = [];
  state.usage = new Map();
  vi.stubEnv("ANTHROPIC_API_KEY", "fake-claude-key-for-tests-0123456789");
  vi.stubEnv("MEND_DEV", "1");
  vi.stubEnv("MEND_BASE_URL", "http://127.0.0.1:3000");
  vi.stubEnv("MEND_CSRF_SECRET", "csrf-secret-for-studio-tests-0123456789");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      state.claude.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const next = state.turns.shift();
      if (next === undefined) throw new Error("no scripted turn left");
      if (next.status !== undefined) return Response.json({ type: "error", error: { type: "overloaded_error", message: "busy" } }, { status: next.status });
      return Response.json({
        id: `msg_${state.claude.length}`,
        type: "message",
        role: "assistant",
        model: MODEL,
        content: next.content,
        stop_reason: next.stop,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 },
      });
    }),
  );
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("claudeMessages", () => {
  it("joins runs of one role, so the results of parallel tool calls arrive together right after the calls", () => {
    const parsed = body({
      input: [
        ASK,
        { id: "m", kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: "Looking.", annotations: [] }] },
        { id: "a", kind: "output", type: "function_call", callId: "toolu_a", name: "view_schema", arguments: "{}", status: "completed" },
        { id: "b", kind: "output", type: "function_call", callId: "toolu_b", name: "view_page", arguments: '{"x":1}', status: "completed" },
        { type: "function_call_output", callId: "toolu_a", output: "tables", status: "completed" },
        { type: "function_call_output", callId: "toolu_b", output: "widgets", status: "completed" },
      ],
    });
    expect(claudeMessages(parsed.input)).toEqual([
      { role: "user", content: [{ type: "text", text: "Add a chart" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking." },
          { type: "tool_use", id: "toolu_a", name: "view_schema", input: {} },
          { type: "tool_use", id: "toolu_b", name: "view_page", input: { x: 1 } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: "tables" },
          { type: "tool_result", tool_use_id: "toolu_b", content: "widgets" },
        ],
      },
    ]);
  });

  it("takes email addresses out of what a person typed and out of tool results", () => {
    const parsed = body({
      input: [
        { ...ASK, content: [{ type: "text", text: "Mail ann@example.com" }] },
        { id: "a", kind: "output", type: "function_call", callId: "toolu_a", name: "execute_query", arguments: "{}" },
        { type: "function_call_output", callId: "toolu_a", output: "bob@example.com bought", status: "completed" },
      ],
    });
    expect(JSON.stringify(claudeMessages(parsed.input))).not.toContain("example.com");
  });
});

describe("field references and the email rule", () => {
  const FIELD = "@field[campaign_money.usd]";
  const textOf = (text: string) => claudeMessages(body({ input: [{ ...ASK, content: [{ type: "text", text }] }] }).input)[0].content;

  it("leaves a field reference whole wherever Studio writes one, and the request passes the outbound check", () => {
    const view = JSON.stringify({ success: true, data: { tables: [{ id: "campaign_money", fields: [{ fieldId: "usd", reference: FIELD, name: "Amount" }, { fieldId: "state", reference: "@field[campaign_money.state]", name: "State" }] }] } });
    const messages = claudeMessages(
      body({
        input: [
          { ...ASK, content: [{ type: "text", text: `Sum (${FIELD}), and\n${FIELD}` }] },
          { id: "a", kind: "output", type: "function_call", callId: "toolu_a", name: "complete_task", arguments: JSON.stringify({ summary: `Mapped (${FIELD}).`, artifacts: [] }) },
          { type: "function_call_output", callId: "toolu_a", output: view, status: "completed" },
        ],
      }).input,
    );
    const sent = JSON.stringify(messages);
    expect(sent).not.toContain("[email removed]");
    expect(sent.match(/@field\[campaign_money\.usd\]/g)).toHaveLength(4);
    expect(JSON.parse((messages[2].content as { content: string }[])[0].content)).toEqual(JSON.parse(view.replaceAll('"@field', '" @field')));
    expect(outboundProblem(sent)).toBeNull();
  });

  it("leaves table and widget references whole the same way, with a dot later in the text", () => {
    const view = JSON.stringify({ reference: "@table[campaign_money]", widgets: [{ reference: "@widget[w-revenue]", version: "1.2" }], note: "v1.2" });
    const messages = claudeMessages(
      body({
        input: [
          { ...ASK, content: [{ type: "text", text: "Do not put (`@table[...]`, `@widget[...]`) in a title, v1.2" }] },
          { id: "a", kind: "output", type: "function_call", callId: "toolu_a", name: "view_report", arguments: "{}" },
          { type: "function_call_output", callId: "toolu_a", output: view, status: "completed" },
        ],
      }).input,
    );
    const sent = JSON.stringify(messages);
    expect(sent).not.toContain("[email removed]");
    for (const reference of ["@table[...]", "@widget[...]", "@table[campaign_money]", "@widget[w-revenue]"]) expect(sent).toContain(reference);
    expect(outboundProblem(sent)).toBeNull();
  });

  it("still removes real addresses, beside a reference, inside tool arguments and shaped to look like one", () => {
    for (const address of ["ann@example.com", "ann@field.example.com", "ann@field[a.b]", "ann.lee@field[example.com]", "a\u200bnn@field[a.b]", "ann@table[a.b]", "ann@widget[a.b]"]) {
      const sent = JSON.stringify([textOf(`(${FIELD}) mail ${address} now`), textOf(address)]);
      expect(sent).not.toContain(address.replaceAll("\u200b", ""));
      expect(sent).toContain("[email removed]");
      expect(outboundProblem(sent)).toBeNull();
    }
    const parsed = body({
      input: [ASK, { id: "a", kind: "output", type: "function_call", callId: "toolu_a", name: "delegate_to", arguments: JSON.stringify({ instructions: "Mail bob@example.com", type: { id: "data", note: ["cara@example.com"] } }) }, { type: "function_call_output", callId: "toolu_a", output: "ok", status: "completed" }],
    });
    expect(JSON.stringify(claudeMessages(parsed.input))).not.toContain("example.com");
  });

  it("sends instructions and a reply with their references whole and their addresses gone", async () => {
    state.turns.push({ content: [{ type: "text", text: `Summed (${FIELD}) for ann@example.com` }], stop: "end_turn" });
    const turn = await runStudioTurn(DEMO, body({ instructions: "Do not put (`@field[...]`) in titles. Mail ann@example.com." }), REF, ADDRESS);
    const system = (state.claude[0].system as { text: string }[])[0].text;
    expect(system).toContain("@field[...]");
    expect(system).not.toContain("ann@example.com");
    if (turn.kind !== "answered") throw new Error("expected an answer");
    expect(turn.events[1]).toMatchObject({ delta: `Summed ( ${FIELD}) for [email removed]` });
  });
});

describe("the queue for one demo session", () => {
  const DONE = { content: [{ type: "text", text: "Done." }], stop: "end_turn" };
  const REFUSED = { kind: "failed", failure: "limit_reached", aiCalls: 0 };
  let held: (() => void)[] = [];

  // Each Claude call waits here until the test lets it go.
  function holdCalls(): void {
    held = [];
    const scripted = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        await new Promise<void>((go) => held.push(go));
        return scripted(input, init);
      }),
    );
  }

  async function letNextCallGo(): Promise<void> {
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
    expect(held).toHaveLength(1);
    held.shift()?.();
  }

  it("lets 3 wait behind the one running, refuses the next at once with no call, and runs them one at a time", async () => {
    holdCalls();
    state.turns.push(DONE, DONE, DONE, DONE);
    const lined = [1, 2, 3, 4].map(() => runStudioTurn(DEMO, body(), REF, ADDRESS));
    expect(await runStudioTurn(DEMO, body(), REF, ADDRESS)).toEqual(REFUSED);
    for (let n = 0; n < 4; n += 1) await letNextCallGo();
    expect((await Promise.all(lined)).map((turn) => turn.kind)).toEqual(["answered", "answered", "answered", "answered"]);
    expect(state.claude).toHaveLength(4);
  });

  it("gives another session its own queue", async () => {
    holdCalls();
    state.turns.push(DONE, DONE);
    const lined = [runStudioTurn(DEMO, body(), REF, ADDRESS), runStudioTurn({ ...DEMO, sessionId: "f".repeat(64) }, body(), REF, ADDRESS)];
    await vi.waitFor(() => expect(held).toHaveLength(2));
    for (const go of held) go();
    expect((await Promise.all(lined)).map((turn) => turn.kind)).toEqual(["answered", "answered"]);
  });

  it("does not queue the owner", async () => {
    holdCalls();
    state.turns.push(DONE, DONE);
    const lined = [runStudioTurn(OWNER, body(), REF, ADDRESS), runStudioTurn(OWNER, body(), REF, ADDRESS)];
    await vi.waitFor(() => expect(held).toHaveLength(2));
    for (const go of held) go();
    await Promise.all(lined);
  });

  it("hands the slot on after a failed call", async () => {
    state.turns.push({ content: [], stop: "", status: 529 }, { content: [], stop: "", status: 529 }, DONE);
    const [failed, next] = await Promise.all([runStudioTurn(DEMO, body(), REF, ADDRESS), runStudioTurn(DEMO, body(), REF, ADDRESS)]);
    expect(failed).toMatchObject({ kind: "failed", failure: "unavailable" });
    expect(next.kind).toBe("answered");
  });

  it("takes a waiter whose browser has gone out of the line, with no call, and keeps its place free", async () => {
    holdCalls();
    state.turns.push(DONE, DONE, DONE, DONE);
    const running = runStudioTurn(DEMO, body(), REF, ADDRESS);
    const left = new AbortController();
    const gone = runStudioTurn(DEMO, body(), REF, ADDRESS, left.signal);
    const others = [1, 2].map(() => runStudioTurn(DEMO, body(), REF, ADDRESS));
    left.abort();
    expect(await gone).toEqual(REFUSED);
    const late = new AbortController();
    late.abort();
    expect(await runStudioTurn(DEMO, body(), REF, ADDRESS, late.signal)).toEqual(REFUSED);
    others.push(runStudioTurn(DEMO, body(), REF, ADDRESS));
    for (let n = 0; n < 4; n += 1) await letNextCallGo();
    expect((await Promise.all([running, ...others])).map((turn) => turn.kind)).toEqual(["answered", "answered", "answered", "answered"]);
    expect(state.claude).toHaveLength(4);
  });

  it("frees the slot when a call is stopped at its deadline, and gives up on a waiter after STUDIO_WALL_MS", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))),
      );
      const running = runStudioTurn(DEMO, body(), REF, ADDRESS);
      await vi.advanceTimersByTimeAsync(1);
      const next = runStudioTurn(DEMO, body(), REF, ADDRESS);
      await vi.advanceTimersByTimeAsync(1);
      const last = runStudioTurn(DEMO, body(), REF, ADDRESS);
      await vi.advanceTimersByTimeAsync(STUDIO_WALL_MS);
      expect(await running).toMatchObject({ kind: "failed", failure: "timed_out" });
      expect(await last).toEqual(REFUSED);
      await vi.advanceTimersByTimeAsync(STUDIO_WALL_MS);
      expect(await next).toMatchObject({ kind: "failed", failure: "timed_out" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TURN_BODY", () => {
  const refused = (extra: Record<string, unknown>) => TURN_BODY.safeParse({ input: [ASK], responseFormat: { type: "text" }, ...extra }).success === false;

  it("refuses a tool outside the list, whether offered, forced or found in the history", () => {
    expect(refused({ tools: [{ ...VIEW_SCHEMA, name: "add_page_filter" }] })).toBe(true);
    expect(refused({ tools: [{ ...VIEW_SCHEMA, name: "send_payout" }] })).toBe(true);
    expect(refused({ toolChoice: { name: "send_payout" } })).toBe(true);
    expect(refused({ input: [{ id: "a", kind: "output", type: "function_call", callId: "toolu_a", name: "send_payout", arguments: "{}" }] })).toBe(true);
  });

  it("refuses a browser setting the output cap or the temperature, a system message, a reasoning item and arguments that are not a JSON object", () => {
    expect(refused({ max_tokens: 64000 })).toBe(true);
    expect(refused({ temperature: 1 })).toBe(true);
    expect(refused({ input: [{ ...ASK, role: "system" }] })).toBe(true);
    expect(refused({ input: [{ id: "r", kind: "output", type: "reasoning", summary: [] }] })).toBe(true);
    expect(refused({ input: [{ id: "a", kind: "output", type: "function_call", callId: "toolu_a", name: "view_page", arguments: "[1]" }] })).toBe(true);
    expect(refused({ input: [{ id: "a", kind: "output", type: "function_call", callId: "toolu_a", name: "view_page", arguments: "{" }] })).toBe(true);
  });

  it("names no tool that could reach money", () => {
    for (const word of ["pay", "send", "approve", "cancel", "refund", "transfer", "payout"]) {
      expect(STUDIO_TOOLS.filter((name) => name.includes(word))).toEqual([]);
    }
  });

  it("allows Mend's three reads and the two tools that pass work between agents, in tools, tool choice and history", () => {
    for (const name of ["read_campaign_result", "read_forecast_groups", "read_money", "delegate_to", "complete_task"]) {
      expect(refused({ tools: [{ ...VIEW_SCHEMA, name }], toolChoice: { name }, input: [ASK, { id: "a", kind: "output", type: "function_call", callId: "toolu_a", name, arguments: "{}" }] })).toBe(false);
    }
  });

  it("takes instructions up to 20,000 characters and no more", () => {
    expect(refused({ instructions: "x".repeat(20_000) })).toBe(false);
    expect(refused({ instructions: "x".repeat(20_001) })).toBe(true);
  });

  it("takes a request shaped as Studio really sends it", () => {
    expect(refused({ instructions: "Look after the dashboard.", tools: [VIEW_SCHEMA, EXECUTE_QUERY] })).toBe(false);
  });
});

describe("runStudioTurn", () => {
  it("ends on a user's turn when Studio's loop asks a delegate to finish after its own words", async () => {
    state.turns.push({ content: [{ type: "tool_use", id: "toolu_1", name: "complete_task", input: { summary: "Done.", artifacts: [] } }], stop: "tool_use" });
    const said = { id: "m", kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: "All done.", annotations: [] }] };
    await runStudioTurn(DEMO, body({ input: [ASK, said], tools: [{ ...VIEW_SCHEMA, name: "complete_task" }], toolChoice: { name: "complete_task" } }), REF, ADDRESS);
    expect(state.claude[0]).toMatchObject({ tool_choice: { type: "tool", name: "complete_task" } });
    expect((state.claude[0].messages as { role: string }[]).at(-1)?.role).toBe("user");
  });

  it("sends the fixed model, output cap, effort and thinking off, with Studio's tool schemas unchanged", async () => {
    state.turns.push({ content: [{ type: "text", text: "Done." }], stop: "end_turn" });
    await runStudioTurn(DEMO, body({ instructions: "Look after the dashboard.", tools: [VIEW_SCHEMA, EXECUTE_QUERY], toolChoice: { name: "view_schema" } }), REF, ADDRESS);
    const sent = state.claude[0];
    expect(sent).toMatchObject({ model: MODEL, max_tokens: STUDIO_MAX_TOKENS, thinking: { type: "disabled" }, output_config: { effort: "medium" }, tool_choice: { type: "tool", name: "view_schema" } });
    expect(sent.stream).toBeUndefined();
    expect(sent.tools).toEqual([
      { name: "view_schema", description: VIEW_SCHEMA.description, input_schema: VIEW_SCHEMA.parameters },
      { name: "execute_query", description: EXECUTE_QUERY.description, input_schema: EXECUTE_QUERY.parameters },
    ]);
    const system = (sent.system as { text: string }[])[0].text;
    expect(system.startsWith("You work on the dashboard inside Mend")).toBe(true);
    expect(system.endsWith("Look after the dashboard.")).toBe(true);
  });

  it("maps every tool choice Studio can send and leaves it out when no tool is offered", async () => {
    for (const [choice, expected] of [[undefined, { type: "auto" }], ["auto", { type: "auto" }], ["none", { type: "none" }], ["required", { type: "any" }]] as const) {
      state.turns.push({ content: [{ type: "text", text: "Done." }], stop: "end_turn" });
      await runStudioTurn(DEMO, body({ tools: [VIEW_SCHEMA], toolChoice: choice }), REF, ADDRESS);
      expect(state.claude.at(-1)?.tool_choice).toEqual(expected);
    }
    state.turns.push({ content: [{ type: "text", text: "Done." }], stop: "end_turn" });
    await runStudioTurn(DEMO, body(), REF, ADDRESS);
    expect(state.claude.at(-1)?.tools).toBeUndefined();
    expect(state.claude.at(-1)?.tool_choice).toBeUndefined();
  });

  it("answers a tool call as Studio's events and final response, keeps the working note from the owner, and counts every token", async () => {
    state.turns.push({
      content: [
        { type: "text", text: "Adding it." },
        { type: "tool_use", id: "toolu_1", name: "add_widget", input: { widgetId: "w", type: "bar-chart-grouped" } },
      ],
      stop: "tool_use",
    });
    const turn = await runStudioTurn(DEMO, body({ tools: [VIEW_SCHEMA] }), REF, ADDRESS);
    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    const args = '{"widgetId":"w","type":"bar-chart-grouped"}';
    expect(turn.events).toEqual([
      { type: "TOOL_CALL_START", toolCallId: "toolu_1", toolCallName: "add_widget" },
      { type: "TOOL_CALL_ARGS", toolCallId: "toolu_1", delta: args },
      { type: "TOOL_CALL_END", toolCallId: "toolu_1" },
    ]);
    expect(turn.response).toMatchObject({
      id: "msg_1",
      status: "completed",
      model: MODEL,
      usage: { inputTokens: 1150, outputTokens: 20, totalTokens: 1170, cachedInputTokens: 1000, cacheWriteTokens: 50 },
      output: [
        { id: "toolu_1", kind: "output", type: "function_call", callId: "toolu_1", name: "add_widget", arguments: args, status: "completed" },
      ],
    });
    expect(turn.tools).toEqual(["add_widget"]);
    expect(turn.aiCalls).toBe(1);
  });

  it("hands back a tool round with no text as tool events alone", async () => {
    state.turns.push({ content: [{ type: "tool_use", id: "toolu_1", name: "view_schema", input: {} }], stop: "tool_use" });
    const turn = await runStudioTurn(DEMO, body({ tools: [VIEW_SCHEMA] }), REF, ADDRESS);
    if (turn.kind !== "answered") throw new Error("expected an answer");
    expect(turn.events.map((event) => event.type)).toEqual(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]);
    expect(turn.response.output.map((item) => item.type)).toEqual(["function_call"]);
  });

  it("strips HTML, images and addresses from model text", async () => {
    state.turns.push({ content: [{ type: "text", text: "<b>Hi</b> ![x](http://a.example/p.png) mail ann@example.com" }], stop: "end_turn" });
    const turn = await runStudioTurn(DEMO, body(), REF, ADDRESS);
    if (turn.kind !== "answered") throw new Error("expected an answer");
    expect(turn.events[1]).toMatchObject({ delta: "Hi  mail [email removed]" });
  });

  it("runs no tool from a refused turn and says so in the fixed sentence", async () => {
    state.turns.push({ content: [{ type: "tool_use", id: "toolu_1", name: "add_widget", input: {} }], stop: "refusal" });
    const turn = await runStudioTurn(DEMO, body({ tools: [VIEW_SCHEMA] }), REF, ADDRESS);
    if (turn.kind !== "answered") throw new Error("expected an answer");
    expect(turn.tools).toEqual([]);
    expect(turn.response.output).toHaveLength(1);
    expect(turn.response.output[0]).toMatchObject({ type: "message", content: [{ text: FAILURE_MESSAGES.declined }] });
  });

  it("marks a cut-off answer incomplete and drops its half-written tool call", async () => {
    state.turns.push({ content: [{ type: "tool_use", id: "toolu_1", name: "add_widget", input: { wid: "" } }], stop: "max_tokens" });
    const turn = await runStudioTurn(DEMO, body({ tools: [VIEW_SCHEMA] }), REF, ADDRESS);
    if (turn.kind !== "answered") throw new Error("expected an answer");
    expect(turn.response).toMatchObject({ status: "incomplete", incompleteDetails: { reason: "max_output_tokens" } });
    expect(turn.tools).toEqual([]);
  });

  it("says plainly when the model answered with nothing", async () => {
    state.turns.push({ content: [], stop: "end_turn" });
    const turn = await runStudioTurn(DEMO, body(), REF, ADDRESS);
    if (turn.kind !== "answered") throw new Error("expected an answer");
    expect(turn.response.output[0]).toMatchObject({ content: [{ text: "I could not put an answer together. Try asking another way." }] });
  });

  it("comes back with a failure code, never a throw, when Claude stays overloaded through the retry", async () => {
    state.turns.push({ content: [], stop: "", status: 529 }, { content: [], stop: "", status: 529 });
    const turn = await runStudioTurn(DEMO, body(), REF, ADDRESS);
    expect(turn).toEqual({ kind: "failed", failure: "unavailable", aiCalls: 2 });
  });
});
