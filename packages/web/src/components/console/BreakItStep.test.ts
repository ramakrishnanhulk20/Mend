// Covers the first paint of the "Try to break it" panel (header, eleven cards in three groups, a thread on
// each card), the waiting and held cards, the run-all summary, and saving and restoring results for a session.
// Does NOT cover running an attack, the animations or the layout at 375 px; those are checked by hand in the
// browser, and the attack outcomes are covered in breakit.test.ts.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConsoleApi } from "./api";
import { AttackCard, BreakItStep, loadSavedRun, runAllSummary, saveRun, tally } from "./BreakItStep";
import { ATTACKS, type Attack, type AttackId, type AttackResult, type Outcome } from "./breakit";

// This folder's vitest config has no "@/" alias, so the one component import that uses it is stood in for.
// On the server the real hook answers false too, so the first paint is the same.
vi.mock("@/components/motion/useStill", () => ({ useStill: () => false }));

function paint(sessionKey: string | null = null): string {
  const api = createConsoleApi((async () => new Response("{}")) as typeof fetch);
  return renderToString(createElement(BreakItStep, { api, campaignId: null, sessionKey, onBack: () => {} }));
}

function escaped(text: string): string {
  return text.replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

function count(html: string, pattern: RegExp): number {
  return html.match(pattern)?.length ?? 0;
}

function attack(id: AttackId): Attack {
  const found = ATTACKS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no attack ${id}`);
  return found;
}

function result(outcome: Outcome, status = 400, code: string | null = "invalid_input"): AttackResult {
  return { outcome, exchange: { sent: "POST /x", answer: `${status} ${code ?? ""}`.trim(), status, code } };
}

// The opening tag of the link to an address, whatever order its attributes came out in.
function anchorTo(html: string, href: string): string {
  const found = (html.match(/<a [^>]*>/g) ?? []).find((tag) => tag.includes(`href="${href}"`));
  if (found === undefined) throw new Error(`no link to ${href}`);
  return found;
}

function card(id: AttackId, over: Partial<Parameters<typeof AttackCard>[0]> = {}): string {
  return renderToString(
    createElement(AttackCard, { attack: attack(id), running: false, result: undefined, needMet: true, locked: false, onRun: () => {}, ...over }),
  );
}

const THREAD_GLYPH = 'viewBox="0 0 28 10"';
const OLD_RED_X = 'viewBox="0 0 10 10"';
const COST_LINE = escaped("Running them all uses at least 3 Claude calls and 2 of this session's 5 drafts a day. Nothing is paid.");

describe("BreakItStep first paint", () => {
  const html = paint();

  it("renders the header", () => {
    expect(html).toContain("Try to break it.");
    expect(html).toContain("Break it");
    expect(html).toContain("Each attack sends a real request from your browser to the live app");
    expect(html).toContain("Run every attack");
    expect(html).toContain("How each is tested");
    expect(html).toContain('href="/docs/security/try-to-break-it"');
  });

  it("opens the docs in a new tab so the demo tab keeps its results", () => {
    const link = anchorTo(html, "/docs/security/try-to-break-it");
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener"');
  });

  it("says what running them all costs, under the controls", () => {
    expect(html).toContain(COST_LINE);
    expect(html.indexOf(COST_LINE)).toBeGreaterThan(html.indexOf("Run every attack"));
    expect(html.indexOf(COST_LINE)).toBeLessThan(html.indexOf('id="money"'));
  });

  it("renders eleven cards, one per attack", () => {
    expect(ATTACKS).toHaveLength(11);
    expect(count(html, /<li /g)).toBe(11);
    expect(count(html, /<h3 /g)).toBe(11);
    for (const a of ATTACKS) expect(html).toContain(escaped(a.title));
  });

  it("groups them as Money, AI and Web, in that order", () => {
    const money = html.indexOf('id="money"');
    const ai = html.indexOf('id="ai"');
    const web = html.indexOf('id="web"');
    expect(money).toBeGreaterThan(-1);
    expect(ai).toBeGreaterThan(money);
    expect(web).toBeGreaterThan(ai);
    expect(count(html, /<h2 /g)).toBe(3);
    for (const group of ["Money", "AI", "Web"] as const) {
      const size = ATTACKS.filter((a) => a.group === group).length;
      expect(html).toContain(`${size} attacks`);
    }
  });

  it("draws a thread on every card and shows no result before a run", () => {
    expect(count(html, /viewBox="0 0 200 24"/g)).toBe(11);
    expect(html).not.toContain("Run again");
    expect(html).not.toContain("Sent</p>");
    expect(html).not.toContain("held &middot;");
    expect(html).not.toContain("waiting on an earlier step");
  });

  it("gives a Run button to the eight cards that need nothing and none to the three that wait", () => {
    expect(count(html, /Run it/g)).toBe(8);
    expect(html).toContain("Waiting: run &quot;Talk Claude into overspending&quot; first.");
    expect(count(html, /Waiting: run &quot;Talk Claude into overspending&quot; first\./g)).toBe(2);
    expect(html).toContain("Waiting: send a campaign in step 4, then come back to this card.");
    expect(html).not.toContain("first: it makes the test draft");
    expect(html).not.toContain("then come back and send it twice");
  });
});

describe("a card that waits on an earlier step", () => {
  it("shows the waiting line in place of a result, with no Run button", () => {
    const html = card("tamper", { needMet: false });

    expect(html).toContain("Waiting: run &quot;Talk Claude into overspending&quot; first.");
    expect(html).not.toContain("Run it");
    expect(html).not.toContain("Run again");
    expect(html).not.toContain("<button");
  });

  it("shows no result even when an older one is still held for it", () => {
    const html = card("twice", { needMet: false, result: result("held", 200, null) });

    expect(html).toContain("Waiting: send a campaign in step 4, then come back to this card.");
    expect(html).not.toContain("How this is tested");
    expect(html).not.toContain("What stopped it");
  });

  it("gets its Run button back once the need is met", () => {
    const html = card("tamper", { needMet: true });

    expect(html).toContain("Run it");
    expect(html).not.toContain("Waiting:");
  });
});

describe("a card with a result", () => {
  it("shows a held result with the stitched thread, what stopped it, and a docs link that opens a new tab", () => {
    const html = card("other-campaign", { result: result("held", 404, "not_found") });

    expect(html).toContain("Held: refused with 404 not_found");
    expect(html).toContain(THREAD_GLYPH);
    expect(html).not.toContain(OLD_RED_X);
    expect(html).toContain("What stopped it");
    expect(html.indexOf("What stopped it")).toBeLessThan(html.indexOf(escaped(attack("other-campaign").stoppedBy)));
    expect(html).toContain("Run again");
    const link = anchorTo(html, "/docs/security/try-to-break-it#web");
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener"');
  });

  it("shows no stitched thread and no stoppedBy line for a result that was not held", () => {
    const html = card("other-campaign", { result: result("not-held", 200, null) });

    expect(html).not.toContain(THREAD_GLYPH);
    expect(html).not.toContain("What stopped it");
    expect(html).toContain("This one was not refused.");
  });
});

describe("the run-all summary", () => {
  it("counts an attack that never ran as waiting, and leaves out could not run when there are none", () => {
    expect(runAllSummary(tally({}))).toBe("0 held · 0 not held · 0 stopped by the rate limit · 11 waiting on an earlier step");
  });

  it("counts an attack that ran and failed apart from one that waited", () => {
    const counts = tally({
      stranger: result("held"),
      "no-token": result("held"),
      "other-campaign": result("held"),
      "fake-webhook": result("held"),
      "ask-to-pay": result("held"),
      "engine-direct": result("not-held", 201, null),
      overspend: result("limited", 429, "rate_limited"),
      "email-to-claude": result("error", 0, null),
    });

    expect(counts).toEqual({ held: 5, notHeld: 1, limited: 1, waiting: 3, couldNotRun: 1 });
    expect(runAllSummary(counts)).toBe(
      "5 held · 1 not held · 1 stopped by the rate limit · 3 waiting on an earlier step · 1 could not run",
    );
  });
});

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
}

const RUN = { results: { stranger: result("held"), tamper: result("held", 409, "hash_mismatch") }, testDraftId: "draft-1", ranAll: true };

describe("saving and restoring a run", () => {
  it("brings back what was saved for the same session", () => {
    const storage = fakeStorage();

    saveRun("session-a", RUN, storage);

    expect(loadSavedRun("session-a", storage)).toEqual(RUN);
    expect(Object.keys(JSON.parse(storage.store.get("mend-breakit") ?? "{}"))).toEqual(["session", "results", "testDraftId", "ranAll"]);
  });

  it("brings back nothing for a different session", () => {
    const storage = fakeStorage();
    saveRun("session-a", RUN, storage);

    expect(loadSavedRun("session-b", storage)).toBeNull();
  });

  it("drops attacks it does not know and reads damaged or missing records as nothing saved", () => {
    const unknown = fakeStorage({ "mend-breakit": JSON.stringify({ session: "s", results: { bogus: result("held") }, testDraftId: null, ranAll: false }) });
    const broken = fakeStorage({ "mend-breakit": "{not json" });
    const wrongShape = fakeStorage({ "mend-breakit": JSON.stringify({ session: "s", results: { stranger: { outcome: "great" } }, testDraftId: null, ranAll: false }) });

    expect(loadSavedRun("s", unknown)).toEqual({ results: {}, testDraftId: null, ranAll: false });
    expect(loadSavedRun("s", broken)).toBeNull();
    expect(loadSavedRun("s", wrongShape)).toBeNull();
    expect(loadSavedRun("s", fakeStorage())).toBeNull();
  });

  it("does nothing, and does not throw, when there is no session or the storage refuses", () => {
    const refusing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    const untouched = fakeStorage();

    saveRun(null, RUN, untouched);

    expect(untouched.store.size).toBe(0);
    expect(loadSavedRun(null, untouched)).toBeNull();
    expect(loadSavedRun("s", refusing)).toBeNull();
    expect(() => saveRun("s", RUN, refusing)).not.toThrow();
    expect(loadSavedRun("s", null)).toBeNull();
  });
});

describe("BreakItStep with a saved run", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function paintWithSaved(record: unknown, sessionKey: string): string {
    const storage = fakeStorage(record === undefined ? {} : { "mend-breakit": JSON.stringify(record) });
    // Motion looks for a window on the server and wants listeners on it, so the stand-in has two that do nothing.
    vi.stubGlobal("window", {
      sessionStorage: storage,
      location: { href: "http://localhost/demo", origin: "http://localhost" },
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    return paint(sessionKey);
  }

  const saved = { session: "session-a", ...RUN };

  it("shows the saved results, the test draft they made, and the run-all summary", () => {
    const html = paintWithSaved(saved, "session-a");

    expect(html).toContain("Held: refused with 400 invalid_input");
    expect(html).toContain("Held: refused with 409 hash_mismatch");
    expect(count(html, /Run again/g)).toBe(2);
    // The test draft is back, so the two cards that use it are no longer waiting; only "twice" still is.
    expect(count(html, /Waiting:/g)).toBe(1);
    expect(html).toContain("2 held");
    expect(html).toContain("9 waiting on an earlier step");
  });

  it("shows a clean panel when the saved run belongs to another session", () => {
    const html = paintWithSaved(saved, "session-b");

    expect(html).not.toContain("Run again");
    expect(count(html, /Waiting:/g)).toBe(3);
    expect(html).not.toContain("waiting on an earlier step");
  });

  it("shows a clean panel when nothing was saved", () => {
    const html = paintWithSaved(undefined, "session-a");

    expect(html).not.toContain("Run again");
    expect(count(html, /Run it/g)).toBe(8);
  });
});
