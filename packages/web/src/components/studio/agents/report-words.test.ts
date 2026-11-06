import { describe, expect, it } from "vitest";
import { dashboardPanels, TOOL_NAMES, toolWords } from "../dashboard-report";

describe("what the chat panel shows", () => {
  it("names each hand-off in plain words", () => {
    expect(toolWords("delegate_to", { type: "mend_analyst" })).toBe("Asking the Mend analyst");
    expect(toolWords("delegate_to", { type: "page" })).toBe("Placing a widget");
  });

  it("never shows a raw tool name", () => {
    for (const name of TOOL_NAMES) {
      expect(toolWords(name, {})).not.toMatch(/_/);
    }
  });

  it("has no analyst panel on a phone", () => {
    expect(JSON.stringify(dashboardPanels(true))).not.toContain("ai");
    expect(JSON.stringify(dashboardPanels(false))).toContain("ai");
  });
});
