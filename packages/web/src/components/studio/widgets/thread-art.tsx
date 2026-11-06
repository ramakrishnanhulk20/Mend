"use client";

import { motion } from "motion/react";
import { useEffect, useState, type RefObject } from "react";

// The thread drawing both Mend widgets share, in the same language as the campaign threads on the Results step.

/** The accent red and the ink at the strengths the campaign threads use. */
export const YARN = "#D72A16";
export const INK = "#123B3F";
export const INK_THREAD = "rgb(18 59 63 / 0.55)";

// The Results step's easing, written out here because its file reaches the app through an alias the tests cannot resolve.
const EASE = [0.22, 1, 0.36, 1] as const;
const DRAW_SECONDS = 0.7;
const STITCH_SIZE = 14;
const STITCH_SPRING = { type: "spring", stiffness: 500, damping: 22, delay: DRAW_SECONDS } as const;
const DOT_STEP = 7;

export type ThreadLook = {
  /** A whole line, a line with a clean gap, a gap bridged by dots, or a dotted line. */
  readonly line: "solid" | "cut" | "bridged" | "dotted";
  readonly color: string;
  /** The stitched X at the centre, or null for none. */
  readonly stitch: string | null;
  readonly weight: number;
  /** The gap in a cut or bridged line, in pixels. */
  readonly gap: number;
};

const dots = (color: string, size: number) => `radial-gradient(circle at 50% 50%, ${color} ${size / 2}px, transparent ${size / 2 + 0.6}px)`;

function Segments({ look }: { readonly look: ThreadLook }) {
  const { line, color, weight, gap } = look;
  const base = { position: "absolute", top: `calc(50% - ${weight / 2}px)`, height: weight } as const;
  if (line === "solid") return <div style={{ ...base, left: 0, right: 0, borderRadius: weight, background: color }} />;
  if (line === "dotted") {
    const size = weight + 1;
    return <div style={{ ...base, top: `calc(50% - ${size / 2}px)`, height: size, left: 0, right: 0, backgroundImage: dots(color, size), backgroundSize: `${DOT_STEP}px 100%`, backgroundRepeat: "repeat-x" }} />;
  }
  const side = `calc(50% - ${gap / 2}px)`;
  return (
    <>
      <div style={{ ...base, left: 0, width: side, borderRadius: weight, background: color }} />
      <div style={{ ...base, right: 0, width: side, borderRadius: weight, background: color }} />
    </>
  );
}

function Stitch({ color, still }: { readonly color: string; readonly still: boolean }) {
  const reach = STITCH_SIZE / 4;
  return (
    <motion.svg
      aria-hidden="true"
      data-part="stitch"
      viewBox={`${-STITCH_SIZE / 2} ${-STITCH_SIZE / 2} ${STITCH_SIZE} ${STITCH_SIZE}`}
      width={STITCH_SIZE}
      height={STITCH_SIZE}
      fill="none"
      style={{ position: "absolute", left: `calc(50% - ${STITCH_SIZE / 2}px)`, top: `calc(50% - ${STITCH_SIZE / 2}px)`, originX: 0.5, originY: 0.5 }}
      initial={still ? false : { scale: 0 }}
      animate={{ scale: 1 }}
      transition={STITCH_SPRING}
    >
      <path d={`M${-reach} ${-reach}l${reach * 2} ${reach * 2}M${reach} ${-reach}l${-reach * 2} ${reach * 2}`} stroke={color} strokeWidth="2" strokeLinecap="round" />
    </motion.svg>
  );
}

function BridgeDots({ look, still }: { readonly look: ThreadLook; readonly still: boolean }) {
  const size = look.weight + 0.5;
  return (
    <motion.div
      aria-hidden="true"
      data-part="bridge"
      style={{ position: "absolute", left: `calc(50% - ${look.gap / 2}px)`, width: look.gap, top: `calc(50% - ${size / 2}px)`, height: size, backgroundImage: dots(look.color, size), backgroundSize: `${DOT_STEP}px 100%`, backgroundRepeat: "repeat-x", originX: 0.5, originY: 0.5 }}
      initial={still ? false : { scale: 0 }}
      animate={{ scale: 1 }}
      transition={STITCH_SPRING}
    />
  );
}

/**
 * One thread across its box, centred on the box's middle. It draws left to right once when it first
 * appears, then the stitch pops in with a spring. A later render of the same thread never replays it,
 * because the motion only runs when the element is created. Still users see it finished.
 */
export function Thread({ look, still }: { readonly look: ThreadLook; readonly still: boolean }) {
  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }} aria-hidden="true">
      <motion.div
        data-part="draw"
        style={{ position: "absolute", inset: 0 }}
        initial={still ? false : { clipPath: "inset(0 100% 0 0)" }}
        animate={{ clipPath: "inset(0 0% 0 0)" }}
        transition={{ duration: DRAW_SECONDS, ease: EASE }}
      >
        <Segments look={look} />
      </motion.div>
      {look.line === "bridged" && <BridgeDots look={look} still={still} />}
      {look.stitch !== null && <Stitch color={look.stitch} still={still} />}
    </div>
  );
}

/** The width of a box in pixels, kept current as it is resized. Zero until the first measurement. */
export function useBoxWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const box = ref.current;
    if (box === null) return;
    const watcher = new ResizeObserver((entries) => setWidth(Math.round(entries[0].contentRect.width)));
    watcher.observe(box);
    return () => watcher.disconnect();
  }, [ref]);
  return width;
}
