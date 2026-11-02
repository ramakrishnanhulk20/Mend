// Covers reading the step out of the address bar's query string. Does NOT cover what the console
// does with the answer (session or no session); that is checked by hand in the browser.
import { describe, expect, it } from "vitest";
import { stepFromQuery } from "./steps";

describe("stepFromQuery", () => {
  it("reads ?step=break-it as the Break it step", () => {
    expect(stepFromQuery("?step=break-it")).toBe("breakit");
  });

  it("finds the param among other params", () => {
    expect(stepFromQuery("?utm_source=landing&step=break-it&x=1")).toBe("breakit");
    expect(stepFromQuery("?step=break-it&x=1")).toBe("breakit");
  });

  it("answers null for anything else", () => {
    expect(stepFromQuery("")).toBeNull();
    expect(stepFromQuery("?")).toBeNull();
    expect(stepFromQuery("?step=")).toBeNull();
    expect(stepFromQuery("?step=regulars")).toBeNull();
    expect(stepFromQuery("?step=breakit")).toBeNull();
    expect(stepFromQuery("?step=Break-It")).toBeNull();
    expect(stepFromQuery("?step=break-it-now")).toBeNull();
    expect(stepFromQuery("?other=break-it")).toBeNull();
  });
});
