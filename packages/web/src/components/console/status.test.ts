// Covers how a payout status becomes a thread state, its label, and when a batch counts as
// settled. Does NOT cover how a thread is drawn; that is checked in the browser.
import { describe, expect, it } from "vitest";
import { STATE_LABEL, isSettled, looksFromRows, threadState, type ThreadState } from "./status";

describe("threadState", () => {
  it.each<[string | null, ThreadState]>([
    [null, "waiting"],
    ["PENDING", "sending"],
    ["UNCLAIMED", "sent"],
    ["SUCCESS", "claimed"],
    ["RETURNED", "returned"],
    ["REFUNDED", "returned"],
    ["REVERSED", "returned"],
    ["FAILED", "refused"],
    ["BLOCKED", "refused"],
    ["UNKNOWN", "unclear"],
    ["ONHOLD", "unclear"],
    ["SOMETHING_NEW", "unclear"],
  ])("reads a reward with status %j as %j", (status, expected) => {
    expect(threadState("reward", status)).toBe(expected);
  });

  it("holds a held-back customer whatever status it is handed", () => {
    expect(threadState("holdout", null)).toBe("held");
    expect(threadState("holdout", "SUCCESS")).toBe("held");
  });
});

describe("looksFromRows", () => {
  const row = { ref: "R1", role: "reward" as const, payoutStatus: "UNCLAIMED", simulatedReturn: false, realReturn: false };

  it("keys each customer by ref with the state of their payment", () => {
    const looks = looksFromRows([row, { ...row, ref: "R6", role: "holdout", payoutStatus: null }]);

    expect(looks.get("R1")).toEqual({ state: "sent", returned: null });
    expect(looks.get("R6")).toEqual({ state: "held", returned: null });
  });

  it("marks a simulated return, a real one, and lets the real one win", () => {
    const looks = looksFromRows([
      { ...row, ref: "R1", simulatedReturn: true },
      { ...row, ref: "R2", realReturn: true },
      { ...row, ref: "R3", simulatedReturn: true, realReturn: true },
    ]);

    expect(looks.get("R1")?.returned).toBe("simulated");
    expect(looks.get("R2")?.returned).toBe("real");
    expect(looks.get("R3")?.returned).toBe("real");
  });
});

describe("STATE_LABEL", () => {
  it("has the exact line for every state", () => {
    expect(STATE_LABEL).toEqual({
      waiting: "not sent yet",
      sending: "PayPal is processing",
      sent: "sent, waiting to be claimed",
      claimed: "claimed by the customer",
      returned: "returned to the shop",
      refused: "PayPal could not pay",
      unclear: "status unclear, Mend will check again",
      held: "held back, never paid",
    });
  });
});

describe("isSettled", () => {
  it("is false while any thread is waiting or sending", () => {
    expect(isSettled(["claimed", "waiting"])).toBe(false);
    expect(isSettled(["sent", "sending", "held"])).toBe(false);
  });

  it("is true once every thread has an answer, even a refusal or an unclear one", () => {
    expect(isSettled(["sent", "claimed", "returned", "refused", "unclear", "held"])).toBe(true);
  });

  it("is true for no threads at all", () => {
    expect(isSettled([])).toBe(true);
  });
});
