"use client";

import { createContext, useContext } from "react";
import { motion } from "motion/react";
import { useStill } from "@/components/motion/useStill";
import { EASE, FOCUS_RING, StitchedThread, TextButton } from "./ui";

// TopBar and ShopCard are outside this work order and still import these two from here.
export { FOCUS_RING, TextButton } from "./ui";

export type Step = "start" | "regulars" | "plan" | "approve" | "payout" | "results" | "breakit" | "dashboard";

/**
 * Opens the Dashboard step. It comes through a context because TopBar renders the rail and passes it
 * only the Break it click. Without a value the Dashboard item is plain text, for when there is no session.
 */
export const OpenDashboardContext = createContext<(() => void) | undefined>(undefined);

export const RAIL_STEPS = [
  { id: "regulars", label: "Regulars" },
  { id: "plan", label: "Plan" },
  { id: "approve", label: "Approve" },
  { id: "payout", label: "Payout" },
  { id: "results", label: "Results" },
] as const;

type RailState = "done" | "active" | "future";

const LABEL_COLOR: Record<RailState, string> = {
  done: "text-ink-dim",
  active: "text-ink",
  future: "text-ink-faint",
};

function railState(index: number, active: number): RailState {
  if (active === -1) return "future";
  if (index < active) return "done";
  return index === active ? "active" : "future";
}

// The inside of one rail item, shared by the five journey steps, Break it and Dashboard so they stay identical.
function RailEntry({
  state,
  numeral,
  label,
  still,
}: {
  state: RailState;
  numeral: string;
  label: string;
  still: boolean;
}) {
  return (
    <>
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
          numeral
        )}
      </span>
      <span className="relative text-[13px]">
        {state === "done" && <span className="sr-only">Done: </span>}
        {label}
        {state === "active" && (
          <motion.span
            aria-hidden="true"
            layoutId="console-step-underline"
            className="absolute inset-x-0 -bottom-[5px] h-[3px] rounded-[2px] bg-[repeating-linear-gradient(90deg,var(--color-accent)_0_9px,transparent_9px_15px)]"
            transition={{ duration: still ? 0 : 0.3, ease: EASE }}
          />
        )}
      </span>
    </>
  );
}

type StepRailProps = {
  step: Step;
  /** Opens the Break it step. Without it the item is plain text, for when there is no session to open it in. */
  onBreakIt?: () => void;
};

export function StepRail({ step, onBreakIt }: StepRailProps) {
  const still = useStill();
  const onDashboard = useContext(OpenDashboardContext);
  // Break it and Dashboard are not journey steps, so on either of them none of the five reads as done.
  const active = RAIL_STEPS.findIndex((item) => item.id === step);
  const breakItState: RailState = step === "breakit" ? "active" : "future";
  const dashboardState: RailState = step === "dashboard" ? "active" : "future";

  // The rail's seven items fill the bar below xl, so the links between them shorten there and a margin keeps it off its neighbours.
  return (
    <nav aria-label="Campaign steps" className="hidden lg:mx-4 lg:block">
      <ol className="flex items-center">
        {RAIL_STEPS.map((item, i) => {
          const state = railState(i, active);
          return (
            <li
              key={item.id}
              aria-current={state === "active" ? "step" : undefined}
              className="flex items-center"
            >
              {i > 0 && <span aria-hidden="true" className="mx-1 h-0 w-3 border-t-[1.5px] border-dashed border-stitch xl:mx-3 xl:w-[28px]" />}
              <span className={`flex items-center gap-1.5 xl:gap-2 ${LABEL_COLOR[state]}`}>
                <RailEntry state={state} numeral={`0${i + 1}`} label={item.label} still={still} />
              </span>
            </li>
          );
        })}
        <li aria-current={breakItState === "active" ? "step" : undefined} className="flex items-center">
          <span aria-hidden="true" className="mx-1.5 h-3 w-0 border-l-[1.5px] border-dashed border-stitch xl:mx-3" />
          {onBreakIt ? (
            <button
              type="button"
              onClick={onBreakIt}
              className={`flex items-center gap-1.5 transition-colors duration-150 ease-out hover:text-ink xl:gap-2 ${LABEL_COLOR[breakItState]} ${FOCUS_RING}`}
            >
              <RailEntry state={breakItState} numeral="06" label="Break it" still={still} />
            </button>
          ) : (
            <span className={`flex items-center gap-1.5 xl:gap-2 ${LABEL_COLOR[breakItState]}`}>
              <RailEntry state={breakItState} numeral="06" label="Break it" still={still} />
            </span>
          )}
        </li>
        <li aria-current={dashboardState === "active" ? "step" : undefined} className="flex items-center">
          <span aria-hidden="true" className="mx-1.5 h-3 w-0 border-l-[1.5px] border-dashed border-stitch xl:mx-3" />
          {onDashboard ? (
            <button
              type="button"
              onClick={onDashboard}
              className={`flex items-center gap-1.5 transition-colors duration-150 ease-out hover:text-ink xl:gap-2 ${LABEL_COLOR[dashboardState]} ${FOCUS_RING}`}
            >
              <RailEntry state={dashboardState} numeral="07" label="Dashboard" still={still} />
            </button>
          ) : (
            <span className={`flex items-center gap-1.5 xl:gap-2 ${LABEL_COLOR[dashboardState]}`}>
              <RailEntry state={dashboardState} numeral="07" label="Dashboard" still={still} />
            </span>
          )}
        </li>
      </ol>
    </nav>
  );
}

/**
 * The phone version of the rail: one line and a thin track. Nothing shows before step one.
 * With onBreakIt and onDashboard it also carries their buttons, since the rail itself is hidden below lg.
 */
export function StepProgress({ step, onBreakIt, onDashboard }: { step: Step; onBreakIt?: () => void; onDashboard?: () => void }) {
  const still = useStill();
  if (step === "breakit" || step === "dashboard") {
    return (
      <div className="mx-auto max-w-[1440px] px-4 pt-4 md:px-10 lg:hidden">
        <p className="font-mono text-[12px] text-ink-dim">{step === "breakit" ? "Break it" : "Dashboard"}</p>
      </div>
    );
  }
  const index = RAIL_STEPS.findIndex((item) => item.id === step);
  if (index === -1) return null;
  const number = index + 1;
  const total = RAIL_STEPS.length;

  return (
    <div className="mx-auto max-w-[1440px] px-4 pt-4 md:px-10 lg:hidden">
      <div className="flex items-center">
        <p className="font-mono text-[12px] text-ink-dim">
          Step {number} of {total} &middot; {RAIL_STEPS[index].label}
        </p>
        {(onBreakIt || onDashboard) && (
          <div className="ml-auto flex items-center gap-4">
            {onBreakIt && (
              <TextButton mono onClick={onBreakIt}>
                06 Break it
              </TextButton>
            )}
            {onDashboard && (
              <TextButton mono onClick={onDashboard}>
                07 Dashboard
              </TextButton>
            )}
          </div>
        )}
      </div>
      <div className="mt-2 h-1 rounded-[2px] bg-pale-teal">
        <motion.div
          className="h-full rounded-[2px] bg-accent"
          initial={still ? false : { width: `${(index / total) * 100}%` }}
          animate={{ width: `${(number / total) * 100}%` }}
          transition={{ duration: still ? 0 : 0.3, ease: EASE }}
        />
      </div>
    </div>
  );
}
