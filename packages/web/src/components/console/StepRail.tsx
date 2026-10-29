"use client";

import { motion } from "motion/react";
import { useStill } from "@/components/motion/useStill";
import { EASE, StitchedThread } from "./ui";

// TopBar and ShopCard are outside this work order and still import these two from here.
export { FOCUS_RING, TextButton } from "./ui";

export type Step = "start" | "regulars" | "plan" | "approve" | "payout" | "results";

export const RAIL_STEPS = [
  { id: "regulars", label: "Regulars" },
  { id: "plan", label: "Plan" },
  { id: "approve", label: "Approve" },
  { id: "payout", label: "Payout" },
  { id: "results", label: "Results" },
] as const;

type RailState = "done" | "active" | "future";

const LABEL_COLOR: Record<RailState, string> = {
  done: "text-bone-dim",
  active: "text-bone",
  future: "text-bone-faint",
};

function railState(index: number, active: number): RailState {
  if (active === -1) return "future";
  if (index < active) return "done";
  return index === active ? "active" : "future";
}

export function StepRail({ step }: { step: Step }) {
  const still = useStill();
  const active = RAIL_STEPS.findIndex((item) => item.id === step);

  return (
    <nav aria-label="Campaign steps" className="hidden lg:block">
      <ol className="flex items-center">
        {RAIL_STEPS.map((item, i) => {
          const state = railState(i, active);
          return (
            <li
              key={item.id}
              aria-current={state === "active" ? "step" : undefined}
              className="flex items-center"
            >
              {i > 0 && <span aria-hidden="true" className="mx-3 h-px w-[28px] bg-bone/20" />}
              <span className={`flex items-center gap-2 ${LABEL_COLOR[state]}`}>
                <span className="flex min-w-[15px] justify-center font-mono text-[11px]">
                  {state === "done" ? (
                    <motion.span
                      className="flex"
                      initial={still ? false : { scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: "spring", stiffness: 500, damping: 22 }}
                    >
                      <StitchedThread />
                    </motion.span>
                  ) : (
                    `0${i + 1}`
                  )}
                </span>
                <span className="relative text-[13px]">
                  {state === "done" && <span className="sr-only">Done: </span>}
                  {item.label}
                  {state === "active" && (
                    <motion.span
                      aria-hidden="true"
                      layoutId="console-step-underline"
                      className="absolute inset-x-0 -bottom-1 h-px bg-bone"
                      transition={{ duration: still ? 0 : 0.3, ease: EASE }}
                    />
                  )}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The phone version of the rail: one line and a thin track. Nothing shows before step one. */
export function StepProgress({ step }: { step: Step }) {
  const still = useStill();
  const index = RAIL_STEPS.findIndex((item) => item.id === step);
  if (index === -1) return null;
  const number = index + 1;
  const total = RAIL_STEPS.length;

  return (
    <div className="mx-auto max-w-[1440px] px-4 pt-4 md:px-10 lg:hidden">
      <p className="font-mono text-[12px] text-bone-dim">
        Step {number} of {total} &middot; {RAIL_STEPS[index].label}
      </p>
      <div className="mt-2 h-[2px] bg-bone/10">
        <motion.div
          className="h-full bg-bone/60"
          initial={still ? false : { width: `${(index / total) * 100}%` }}
          animate={{ width: `${(number / total) * 100}%` }}
          transition={{ duration: still ? 0 : 0.3, ease: EASE }}
        />
      </div>
    </div>
  );
}
