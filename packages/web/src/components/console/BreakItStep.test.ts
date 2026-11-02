// Covers the first paint of the "Try to break it" panel: the header, the eleven cards in three groups,
// and a thread on each card. Does NOT cover running an attack, the animations or the layout at 375 px;
// those are checked by hand in the browser, and the attack outcomes are covered in breakit.test.ts.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createConsoleApi } from "./api";
import { BreakItStep } from "./BreakItStep";
import { ATTACKS } from "./breakit";

// This folder's vitest config has no "@/" alias, so the one component import that uses it is stood in for.
// On the server the real hook answers false too, so the first paint is the same.
vi.mock("@/components/motion/useStill", () => ({ useStill: () => false }));

function firstPaint(): string {
  const api = createConsoleApi((async () => new Response("{}")) as typeof fetch);
  return renderToString(createElement(BreakItStep, { api, campaignId: null, onBack: () => {} }));
}

function escaped(text: string): string {
  return text.replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

function count(html: string, pattern: RegExp): number {
  return html.match(pattern)?.length ?? 0;
}

describe("BreakItStep first paint", () => {
  const html = firstPaint();

  it("renders the header", () => {
    expect(html).toContain("Try to break it.");
    expect(html).toContain("Break it");
    expect(html).toContain("Each attack sends a real request from your browser to the live app");
    expect(html).toContain("Run every attack");
    expect(html).toContain("How each is tested");
    expect(html).toContain('href="/docs/security/try-to-break-it"');
  });

  it("renders eleven cards, one per attack", () => {
    expect(ATTACKS).toHaveLength(11);
    expect(count(html, /<li /g)).toBe(11);
    expect(count(html, /<h3 /g)).toBe(11);
    for (const attack of ATTACKS) expect(html).toContain(escaped(attack.title));
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
      const size = ATTACKS.filter((attack) => attack.group === group).length;
      expect(html).toContain(`${size} attacks`);
    }
  });

  it("draws a thread on every card and shows no result before a run", () => {
    expect(count(html, /viewBox="0 0 200 24"/g)).toBe(11);
    expect(count(html, /Run it/g)).toBe(11);
    expect(html).not.toContain("Run again");
    expect(html).not.toContain("Sent</p>");
    expect(html).not.toContain("held &middot;");
  });

  it("tells the visitor which cards wait on an earlier step", () => {
    expect(html).toContain("Run &quot;Talk Claude into overspending&quot; first");
    expect(html).toContain("Send a campaign in step 4 first, then come back and send it twice.");
  });
});
