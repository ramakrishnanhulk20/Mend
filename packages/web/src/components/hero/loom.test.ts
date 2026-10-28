import { describe, expect, it } from "vitest";
import {
  COMPACT_BREAKS,
  WIDE_BREAKS,
  heldProgress,
  layoutLoom,
  mendProgress,
  pushOffset,
  snapRows,
  threadReveal,
  waveOffset,
} from "./loom";

describe("layoutLoom", () => {
  it("lays out the wide desktop loom", () => {
    const layout = layoutLoom(1440, 900);
    expect(layout.rows).toHaveLength(56);
    expect(layout.rows[0]).toBeCloseTo(90, 6);
    expect(layout.rows[55]).toBeCloseTo(873, 6);
    expect(layout.gap).toBe(72);
    expect(layout.breaks).toHaveLength(10);
    expect(new Set(layout.breaks.map((b) => b.row)).size).toBe(10);

    const mended = layout.breaks.filter((b) => b.kind === "mended");
    const held = layout.breaks.filter((b) => b.kind === "held");
    expect(mended.map((b) => b.order)).toEqual([0, 1, 2, 3, 4]);
    expect(held.map((b) => b.order)).toEqual([0, 1, 2, 3, 4]);
    expect(layout.breaks.map((b) => b.x)).toEqual(WIDE_BREAKS.map((spot) => spot.x * 1440));
  });

  it("lays out the phone loom with every break on screen", () => {
    const layout = layoutLoom(375, 812);
    expect(layout.rows).toHaveLength(44);
    for (const b of layout.breaks) expect(layout.rows[b.row]).toBeLessThanOrEqual(0.4 * 812);
    expect(layout.gap).toBe(28);
    for (const b of layout.breaks) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x).toBeLessThanOrEqual(375);
    }
    expect(new Set(layout.breaks.map((b) => b.row)).size).toBe(10);
  });

  it("uses the compact break list below 1280 wide", () => {
    const layout = layoutLoom(1024, 768);
    expect(layout.rows).toHaveLength(44);
    expect(layout.breaks.map((b) => b.x)).toEqual(COMPACT_BREAKS.map((spot) => spot.x * 1024));
  });
});

describe("snapRows", () => {
  it("moves a taken row one step down, then one step up", () => {
    expect(snapRows([10, 10, 10], [0, 10, 20])).toEqual([1, 2, 0]);
  });
});

describe("mendProgress", () => {
  it("is all zeros before the mend starts", () => {
    expect(mendProgress(0, 0)).toEqual({ bridge: 0, stitches: [0, 0, 0], glow: 0, tint: 0 });
  });

  it("settles on the resting glow when time runs out", () => {
    expect(mendProgress(Infinity, 4)).toEqual({
      bridge: 1,
      stitches: [1, 1, 1],
      glow: 0.18,
      tint: 1,
    });
  });
});

describe("heldProgress", () => {
  it("draws nothing until the held phase starts and everything at the end", () => {
    expect(heldProgress(Infinity, 4)).toBe(1);
    expect(heldProgress(3099, 0)).toBe(0);
  });
});

describe("threadReveal", () => {
  it("never goes backwards", () => {
    for (const index of [0, 1, 27, 55]) {
      let last = 0;
      for (let t = 0; t <= 2000; t += 10) {
        const value = threadReveal(t, index);
        expect(value).toBeGreaterThanOrEqual(last);
        last = value;
      }
    }
  });

  it("finishes the last thread of the wide loom at 1450 ms", () => {
    expect(threadReveal(900 + 55 * 10, 55)).toBe(1);
  });
});

describe("waveOffset", () => {
  it("is flat when the amplitude is zero, even at the end of time", () => {
    expect(waveOffset(123, 4, Infinity, 0)).toBe(0);
  });
});

describe("pushOffset", () => {
  it("does nothing without a pointer", () => {
    expect(pushOffset(100, 100, 100, 110, 0)).toBe(0);
  });

  it("pushes a thread above the cursor upwards", () => {
    expect(pushOffset(100, 80, 100, 110, 1)).toBeLessThan(0);
  });
});
