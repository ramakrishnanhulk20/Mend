"use client";

import { useId } from "react";
import { motion } from "motion/react";
import { useStill } from "@/components/motion/useStill";
import type { ShopSummary } from "@/components/live/summary";
import { BenchmarkTable } from "./BenchmarkTable";
import { DecileChart, EASE, FOCUS_RING } from "./DecileChart";
import { GroupsChart } from "./GroupsChart";
import { IntervalChart } from "./IntervalChart";

function enter(still: boolean, delayMs: number) {
  return {
    initial: still ? (false as const) : { opacity: 0, y: 24 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true, amount: 0.4 },
    transition: { duration: 0.6, delay: delayMs / 1000, ease: EASE },
  };
}

export function ProofSection({
  state,
  summary,
  slow,
  retry,
}: {
  state: "loading" | "ready" | "unavailable";
  summary: ShopSummary | null;
  slow: boolean;
  retry: () => void;
}) {
  const still = useStill();
  const titleId = useId();
  const source = summary?.backtest?.source ?? null;
  const blockState = state === "ready" ? "ready" : "loading";

  return (
    <section
      id="results"
      aria-labelledby={titleId}
      className="border-t border-rule bg-ink px-4 py-28 md:px-10 md:py-40"
    >
      <motion.p
        className="font-mono text-[12px] uppercase tracking-[0.14em] text-bone-faint"
        {...enter(still, 0)}
      >
        The proof
      </motion.p>
      {/* Inline line height, because .poster-title sits outside Tailwind's layers and would beat a leading class. */}
      <motion.h2
        id={titleId}
        className="poster-title mt-6 text-[44px] text-bone md:text-[length:clamp(3.5rem,7vw,7.5rem)]"
        style={{ lineHeight: 0.9 }}
        {...enter(still, 90)}
      >
        Tested on a real shop&apos;s history.
      </motion.h2>
      <motion.p
        className="mt-6 max-w-[56ch] text-[16px] leading-[1.55] text-bone-dim md:text-[18px]"
        {...enter(still, 180)}
      >
        Mend&apos;s forecast was scored on the same two years of orders the demo shop replays. Every
        number on this screen is read live from Mend&apos;s database, and it says so when the forecast
        does not win.
      </motion.p>
      {source !== null && (
        <motion.p className="mt-4 font-mono text-[12px] text-bone-faint" {...enter(still, 270)}>
          Data: {source}
        </motion.p>
      )}

      {slow && (
        <p className="mt-8 font-mono text-[12px] text-bone-faint">
          Reading the live numbers from Mend&apos;s database
        </p>
      )}

      {state === "unavailable" ? (
        <div className="mt-20 rounded-[8px] border border-rule p-8">
          <p className="max-w-[56ch] text-[16px] leading-[1.55] text-bone-dim">
            The live numbers are not available right now. Mend&apos;s engine may be starting up; this
            usually takes under a minute.
          </p>
          <button
            type="button"
            onClick={retry}
            className={`mt-6 inline-flex h-11 items-center rounded-[8px] border border-rule px-5 text-[15px] text-bone transition-colors duration-150 ease-out hover:border-bone-faint ${FOCUS_RING}`}
          >
            Try again
          </button>
        </div>
      ) : (
        <div className="mt-20 flex flex-col gap-y-20 lg:grid lg:grid-cols-12 lg:gap-x-16 lg:gap-y-0">
          <div className="min-w-0 lg:col-span-12">
            <GroupsChart state={blockState} summary={summary} />
          </div>
          <div className="min-w-0 lg:col-span-7 lg:mt-24">
            <DecileChart state={blockState} summary={summary} />
          </div>
          <div className="min-w-0 lg:col-span-5 lg:mt-24">
            <IntervalChart state={blockState} summary={summary} />
          </div>
          <div className="min-w-0 lg:col-span-12 lg:mt-24">
            <BenchmarkTable state={blockState} summary={summary} />
          </div>
        </div>
      )}
    </section>
  );
}
