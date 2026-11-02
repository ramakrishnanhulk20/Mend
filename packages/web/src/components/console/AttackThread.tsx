"use client";

import { motion } from "motion/react";
import { useStill } from "@/components/motion/useStill";
import { EASE } from "./ui";

export type ThreadState = "idle" | "running" | "held" | "not-held" | "limited" | "error";

const MIDDLE = 12;
const GUARD_X = 128;
const FAR_START_X = 132;
const FAR_END_X = 184;
const RUNNER_LENGTH = 24;
const RUNNER_TRAVEL = 96;

const VIEW_WIDTH = 200;
const VIEW_HEIGHT = 24;

// Motion measures an SVG shape's turning point from the shape's own box unless told otherwise. These two points
// are spots on the thread, so they are measured from the whole drawing instead (transformBox view-box). Motion
// ignores a plain transformOrigin string on SVG shapes, so the point goes in as originX and originY, as fractions
// of the drawing: 132 of 200 across and 12 of 24 down for the far piece, 128 of 200 and the same height for the knot.
const FAR_ORIGIN = { originX: FAR_START_X / VIEW_WIDTH, originY: MIDDLE / VIEW_HEIGHT, transformBox: "view-box" } as const;
const KNOT_ORIGIN = { originX: GUARD_X / VIEW_WIDTH, originY: MIDDLE / VIEW_HEIGHT, transformBox: "view-box" } as const;

function DashedRoad() {
  return (
    <line
      x1="8"
      y1={MIDDLE}
      x2={FAR_END_X}
      y2={MIDDLE}
      className="stroke-bone/30"
      strokeWidth="1.5"
      strokeDasharray="2 6"
    />
  );
}

function Runner({ still }: { still: boolean }) {
  if (still) {
    // Reduced motion: the bright piece rests in the middle of the road to the guard.
    const left = 8 + (GUARD_X - 8 - RUNNER_LENGTH) / 2;
    return <line x1={left} y1={MIDDLE} x2={left + RUNNER_LENGTH} y2={MIDDLE} className="stroke-bone/80" strokeWidth="1.5" />;
  }
  return (
    <motion.line
      x1="8"
      y1={MIDDLE}
      x2={8 + RUNNER_LENGTH}
      y2={MIDDLE}
      className="stroke-bone/80"
      strokeWidth="1.5"
      initial={{ x: 0 }}
      animate={{ x: RUNNER_TRAVEL }}
      transition={{ duration: 1.2, ease: "easeInOut", repeat: Infinity, repeatType: "reverse" }}
    />
  );
}

function Knot({ still }: { still: boolean }) {
  const strokes = ["M124 8L132 16", "M132 8L124 16"];
  return strokes.map((d) =>
    still ? (
      <path key={d} d={d} className="stroke-accent" strokeWidth="1.75" strokeLinecap="round" />
    ) : (
      <motion.path
        key={d}
        d={d}
        className="stroke-accent"
        strokeWidth="1.75"
        strokeLinecap="round"
        style={KNOT_ORIGIN}
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ duration: 0.25, delay: 0.5, ease: EASE }}
      />
    ),
  );
}

function Held({ still }: { still: boolean }) {
  if (still) {
    return (
      <>
        <path d={`M8 ${MIDDLE}H124`} className="stroke-bone/70" strokeWidth="1.5" />
        <Knot still />
      </>
    );
  }
  return (
    <>
      <motion.path
        d={`M8 ${MIDDLE}H124`}
        className="stroke-bone/70"
        strokeWidth="1.5"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.5, ease: EASE }}
      />
      <motion.path
        d={`M${FAR_START_X} ${MIDDLE}H${FAR_END_X}`}
        className="stroke-bone/40"
        style={FAR_ORIGIN}
        initial={{ opacity: 1, y: 0, rotate: 0 }}
        animate={{ opacity: 0, y: 6, rotate: 8 }}
        transition={{ duration: 0.35, delay: 0.5 }}
      />
      <Knot still={false} />
    </>
  );
}

function NotHeld({ still }: { still: boolean }) {
  if (still) return <path d={`M8 ${MIDDLE}H${FAR_END_X}`} className="stroke-bone" strokeWidth="1.5" />;
  return (
    <motion.path
      d={`M8 ${MIDDLE}H${FAR_END_X}`}
      className="stroke-bone"
      strokeWidth="1.5"
      initial={{ pathLength: 0 }}
      animate={{ pathLength: 1 }}
      transition={{ duration: 0.6, ease: EASE }}
    />
  );
}

/** One attack drawn as a thread from the visitor toward PayPal. It snaps at the guard post when the guard holds. */
export function AttackThread({ state }: { state: ThreadState }) {
  const still = useStill();
  const dashed = state === "idle" || state === "running" || state === "limited" || state === "error";

  return (
    <svg viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} fill="none" aria-hidden="true" className="block h-6 w-full max-w-[200px]">
      <circle cx="4" cy={MIDDLE} r="3" className="fill-bone-dim" />
      <line x1={GUARD_X} y1="4" x2={GUARD_X} y2="20" className="stroke-bone-faint" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="186" y="6" width="12" height="12" rx="3" className="stroke-bone-faint" strokeWidth="1.5" />

      {dashed && <DashedRoad />}
      {/* Keyed by state so a second run of the same attack plays its drawing again. */}
      <g key={state}>
        {state === "running" && <Runner still={still} />}
        {state === "held" && <Held still={still} />}
        {state === "not-held" && <NotHeld still={still} />}
      </g>
    </svg>
  );
}
