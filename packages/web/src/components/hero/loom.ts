export type BreakKind = "mended" | "held";

/** A break as fractions of the canvas: y of its height, x of its width. */
export type BreakSpot = { y: number; x: number; kind: BreakKind };

/** A break placed on a real canvas. `order` counts 0..4 separately for each kind. */
export type LoomBreak = { row: number; x: number; kind: BreakKind; order: number };

export type LoomLayout = {
  width: number;
  height: number;
  rows: number[];
  breaks: LoomBreak[];
  gap: number;
  amplitude: number;
  glowRadius: number;
};

export const WIDE_BREAKS: readonly BreakSpot[] = [
  { y: 0.18, x: 0.62, kind: "mended" },
  { y: 0.22, x: 0.43, kind: "held" },
  { y: 0.26, x: 0.8, kind: "mended" },
  { y: 0.3, x: 0.69, kind: "held" },
  { y: 0.34, x: 0.47, kind: "mended" },
  { y: 0.39, x: 0.88, kind: "held" },
  { y: 0.43, x: 0.71, kind: "mended" },
  { y: 0.47, x: 0.55, kind: "held" },
  { y: 0.52, x: 0.86, kind: "mended" },
  { y: 0.56, x: 0.76, kind: "held" },
];

export const COMPACT_BREAKS: readonly BreakSpot[] = [
  { y: 0.18, x: 0.62, kind: "mended" },
  { y: 0.2, x: 0.36, kind: "held" },
  { y: 0.29, x: 0.24, kind: "mended" },
  { y: 0.24, x: 0.84, kind: "held" },
  { y: 0.26, x: 0.78, kind: "mended" },
  { y: 0.28, x: 0.56, kind: "held" },
  { y: 0.31, x: 0.44, kind: "mended" },
  { y: 0.33, x: 0.2, kind: "held" },
  { y: 0.36, x: 0.7, kind: "mended" },
  { y: 0.38, x: 0.88, kind: "held" },
];

/** Every timing of the opening sequence, in milliseconds from page load. */
export const INTRO = {
  threads: { start: 0, duration: 900, stagger: 10 },
  title: { start: 700, duration: 900, stagger: 70 },
  copy: { start: 1200, duration: 600, stagger: 90 },
  mend: {
    start: 1900,
    each: 200,
    bridge: 300,
    stitchGap: 80,
    stitch: 160,
    glowRise: 120,
    glowFall: 700,
    rest: 0.18,
  },
  held: { start: 3100, each: 120, draw: 400 },
  legend: [600, 1900, 3100],
  light: { start: 1900, duration: 1400 },
} as const;

export const LOOM_RGB = { bone: "237,230,218", accent: "255,77,46" } as const;

const WAVE_WAVELENGTH = 900;
const WAVE_PERIOD_MS = 9000;
const PUSH_STRENGTH = 18;
const PUSH_SPREAD = 70;

function clamp(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function threadCount(width: number): number {
  if (width >= 1280) return 56;
  // A phone has a short band between the legend and the title; ten breaks need ten free
  // rows inside it, which fewer threads cannot give, so the rest get pushed onto the copy.
  return 44;
}

/**
 * Gives each target the nearest row nobody has taken yet. When the nearest row is
 * taken it looks one step down, one step up, two steps down, and so on.
 */
export function snapRows(targets: readonly number[], rows: readonly number[]): number[] {
  const taken = new Set<number>();
  return targets.map((target) => {
    let nearest = 0;
    let nearestDistance = Infinity;
    rows.forEach((row, index) => {
      const distance = Math.abs(row - target);
      if (distance < nearestDistance) {
        nearest = index;
        nearestDistance = distance;
      }
    });

    for (let step = 0; step < rows.length; step += 1) {
      for (const candidate of step === 0 ? [nearest] : [nearest + step, nearest - step]) {
        if (candidate >= 0 && candidate < rows.length && !taken.has(candidate)) {
          taken.add(candidate);
          return candidate;
        }
      }
    }
    throw new RangeError("snapRows: there are more targets than rows");
  });
}

export function layoutLoom(width: number, height: number): LoomLayout {
  const count = threadCount(width);
  const top = 0.1 * height;
  const bottom = 0.97 * height;
  const rows = Array.from({ length: count }, (_, i) => top + (i * (bottom - top)) / (count - 1));

  const spots = width >= 1280 ? WIDE_BREAKS : COMPACT_BREAKS;
  const snapped = snapRows(
    spots.map((spot) => spot.y * height),
    rows,
  );
  const seen: Record<BreakKind, number> = { mended: 0, held: 0 };
  const breaks = spots.map((spot, i) => {
    const order = seen[spot.kind];
    seen[spot.kind] += 1;
    return { row: snapped[i], x: spot.x * width, kind: spot.kind, order };
  });

  const roomy = width >= 768;
  return {
    width,
    height,
    rows,
    breaks,
    gap: Math.max(roomy ? 44 : 28, 0.05 * width),
    amplitude: roomy ? 3 : 2,
    glowRadius: roomy ? 90 : 64,
  };
}

export function easeOutQuart(p: number): number {
  return 1 - (1 - p) ** 4;
}

export function easeOutBack(p: number): number {
  // A stitch that has not started must read exactly 0, not a rounding crumb.
  if (p <= 0) return 0;
  return 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2;
}

export function threadReveal(t: number, index: number): number {
  const { start, duration, stagger } = INTRO.threads;
  return easeOutQuart(clamp((t - start - index * stagger) / duration));
}

export function mendProgress(
  t: number,
  order: number,
): { bridge: number; stitches: [number, number, number]; glow: number; tint: number } {
  const { start, each, bridge, stitchGap, stitch, glowRise, glowFall, rest } = INTRO.mend;
  const local = t - (start + order * each);

  const bridgeProgress = easeOutQuart(clamp(local / bridge));
  const stitchAt = (k: number) =>
    easeOutBack(clamp((local - 0.6 * bridge - k * stitchGap) / stitch));

  const landed = local - (0.6 * bridge + 2 * stitchGap + stitch);
  let glow: number;
  if (landed < 0) glow = 0;
  else if (landed < glowRise) glow = landed / glowRise;
  else glow = rest + (1 - rest) * Math.max(0, 1 - (landed - glowRise) / glowFall);

  return {
    bridge: bridgeProgress,
    stitches: [stitchAt(0), stitchAt(1), stitchAt(2)],
    glow,
    tint: easeOutQuart(clamp(local / (bridge + 2 * stitchGap + stitch))),
  };
}

export function heldProgress(t: number, order: number): number {
  const { start, each, draw } = INTRO.held;
  return easeOutQuart(clamp((t - (start + order * each)) / draw));
}

export function waveOffset(x: number, index: number, t: number, amplitude: number): number {
  // With t = Infinity (the still frame) the sine would be NaN, so a flat thread returns early.
  if (amplitude === 0) return 0;
  const phase =
    (x * 2 * Math.PI) / WAVE_WAVELENGTH + (t * 2 * Math.PI) / WAVE_PERIOD_MS + index * 0.55;
  return amplitude * Math.sin(phase);
}

export function pushOffset(
  x: number,
  y: number,
  cx: number,
  cy: number,
  influence: number,
): number {
  // Most frames have no pointer nearby, and skipping the exponential keeps them cheap.
  if (influence === 0) return 0;
  const dx = x - cx;
  const dy = y - cy;
  const falloff = Math.exp(-(dx * dx + dy * dy) / (2 * PUSH_SPREAD * PUSH_SPREAD));
  return PUSH_STRENGTH * influence * falloff * (dy < 0 ? -1 : 1);
}
