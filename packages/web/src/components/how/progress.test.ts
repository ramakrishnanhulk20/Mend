import { describe, expect, it } from "vitest";
import { PANEL_COUNT, activePanel, sectionProgress } from "./progress";

describe("sectionProgress", () => {
  it("is 0 when the section top is at the top of the screen", () => {
    expect(sectionProgress(0, 4000, 1000)).toBe(0);
  });

  it("is halfway after scrolling half of the travel", () => {
    expect(sectionProgress(-1500, 4000, 1000)).toBe(0.5);
  });

  it("stops at 1 once the section has scrolled past", () => {
    expect(sectionProgress(-9999, 4000, 1000)).toBe(1);
  });

  it("stays at 0 while the section is still below the top of the screen", () => {
    expect(sectionProgress(100, 4000, 1000)).toBe(0);
  });

  it("is 0 when the section is no taller than the screen", () => {
    expect(sectionProgress(0, 800, 1000)).toBe(0);
    expect(sectionProgress(-200, 1000, 1000)).toBe(0);
  });

  it("never lets NaN out", () => {
    expect(sectionProgress(NaN, 4000, 1000)).toBe(0);
    expect(sectionProgress(-100, NaN, 1000)).toBe(0);
  });
});

describe("activePanel", () => {
  it("has four panels", () => {
    expect(PANEL_COUNT).toBe(4);
  });

  it("picks the nearest panel and rounds halves up", () => {
    expect(activePanel(0)).toBe(0);
    expect(activePanel(0.16)).toBe(0);
    expect(activePanel(0.17)).toBe(1);
    expect(activePanel(0.5)).toBe(2);
    expect(activePanel(1)).toBe(3);
  });

  it("falls back to the first panel for NaN", () => {
    expect(activePanel(NaN)).toBe(0);
  });
});
