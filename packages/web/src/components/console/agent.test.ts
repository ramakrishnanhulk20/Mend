// Covers the tool names shown as chips, how the chat history is trimmed before it is sent, the
// line shown for each refusal and the suggested questions. Does NOT cover how the panel looks or
// the real route; those are checked in the browser.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HISTORY_TEXT_LIMIT,
  TOOL_LABELS,
  askFailureText,
  suggestionsFor,
  toolLabel,
  trimHistory,
  type HistoryEntry,
} from "./agent";

describe("toolLabel", () => {
  it.each([
    ["shop_summary", "shop numbers"],
    ["quiet_regulars", "quiet regulars"],
    ["draft_campaign", "drafted a campaign"],
    ["view_campaign", "campaign plan"],
    ["campaign_results", "campaign results"],
    ["request_approval", "asked for approval"],
    ["get_order", "PayPal order"],
    ["list_disputes", "PayPal disputes"],
    ["get_dispute", "PayPal dispute"],
    ["show_product_details", "PayPal product"],
  ])("names %s as %j", (name, label) => {
    expect(toolLabel(name)).toBe(label);
  });

  it("shows a name it does not know as it came", () => {
    expect(toolLabel("some_new_tool")).toBe("some_new_tool");
    expect(toolLabel("")).toBe("");
  });

  it("does not treat a built-in object property as a known tool", () => {
    expect(toolLabel("constructor")).toBe("constructor");
    expect(toolLabel("toString")).toBe("toString");
    expect(toolLabel("__proto__")).toBe("__proto__");
  });

  it("has a label for every tool the server gives Claude", () => {
    const source = readFileSync(new URL("../../server/agent.ts", import.meta.url), "utf8");
    const names = [...source.matchAll(/^\s+name:\s*"([a-z_]+)",$/gm)].map((match) => match[1]);
    expect(names).toHaveLength(10);
    for (const name of names) expect(TOOL_LABELS).toHaveProperty(name);
  });
});

function chat(count: number): HistoryEntry[] {
  return Array.from({ length: count }, (_, i) => ({ role: i % 2 === 0 ? "owner" : "agent", text: `message ${i}` }));
}

describe("trimHistory", () => {
  it("sends nothing for an empty chat", () => {
    expect(trimHistory([])).toEqual([]);
  });

  it("keeps a short chat whole and in order", () => {
    expect(trimHistory(chat(3))).toEqual(chat(3));
    expect(trimHistory(chat(10))).toHaveLength(10);
  });

  it("keeps only the last 10 of a longer chat", () => {
    const trimmed = trimHistory(chat(14));
    expect(trimmed).toHaveLength(10);
    expect(trimmed[0].text).toBe("message 4");
    expect(trimmed[9].text).toBe("message 13");
  });

  it("cuts each text to 4000 characters and leaves shorter ones alone", () => {
    const [long, exact, short] = trimHistory([
      { role: "agent", text: "a".repeat(5000) },
      { role: "agent", text: "b".repeat(HISTORY_TEXT_LIMIT) },
      { role: "owner", text: "short" },
    ]);
    expect(long.text).toHaveLength(HISTORY_TEXT_LIMIT);
    expect(exact.text).toHaveLength(HISTORY_TEXT_LIMIT);
    expect(short.text).toBe("short");
  });

  it("does not leave half of an emoji at the cut", () => {
    const text = `${"a".repeat(HISTORY_TEXT_LIMIT - 1)}\u{1F600}tail`;
    const [cut] = trimHistory([{ role: "agent", text }]);
    expect(cut.text).toBe("a".repeat(HISTORY_TEXT_LIMIT - 1));
  });

  it("keeps only the role and the text of each message", () => {
    const messages = [{ role: "agent" as const, text: "hello", tools: ["get_order"], failed: false }];
    expect(trimHistory(messages)).toEqual([{ role: "agent", text: "hello" }]);
  });

  it("does not change the list it is given", () => {
    const messages = chat(12);
    trimHistory(messages);
    expect(messages).toHaveLength(12);
  });
});

describe("askFailureText", () => {
  it.each([
    [503, "no_key", "Claude isn't available on this server right now."],
    [429, "limit_reached", "This session has used its Claude questions for today."],
    [429, "claude_token_cap", "This session has used its Claude questions for today."],
    [400, "invalid_input", "That question is too long. Keep it under 2,000 characters."],
    [413, "invalid_input", "That question is too long. Keep it under 2,000 characters."],
    [429, "rate_limited", "Claude didn't answer. Try again."],
    [503, "unavailable", "Claude didn't answer. Try again."],
    [422, "declined", "Claude didn't answer. Try again."],
    [500, "unexpected", "Claude didn't answer. Try again."],
    [0, "network", "Claude didn't answer. Try again."],
    [502, "unexpected_answer", "Claude didn't answer. Try again."],
  ])("reads %i %s as %j", (status, code, line) => {
    expect(askFailureText(status, code)).toBe(line);
  });
});

describe("suggestionsFor", () => {
  it("asks about the last campaign when no PayPal order is known", () => {
    expect(suggestionsFor(null)).toEqual([
      "How many quiet regulars does the shop have?",
      "Which regulars are most at risk right now?",
      "Which of these customers can be paid?",
    ]);
  });

  it("asks about the session's own PayPal order once there is one", () => {
    expect(suggestionsFor("5O190127TN364715T")[2]).toBe("What happened with PayPal order 5O190127TN364715T?");
    expect(suggestionsFor("5O190127TN364715T")).toHaveLength(3);
  });
});
