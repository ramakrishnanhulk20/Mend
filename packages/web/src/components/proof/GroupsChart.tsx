"use client";

import { useId, useState } from "react";
import { motion, type Variants } from "motion/react";
import { useStill } from "@/components/motion/useStill";
import { formatCount, formatDay, formatShare, type ForecastBands } from "@/components/live/summary";
import {
  EASE,
  FOCUS_RING,
  HEAD_CELL,
  ChartFrame,
  ChartPlaceholder,
  NotMeasured,
  NumbersToggle,
  type BlockProps,
} from "./DecileChart";
import { GROUPS, groupName, groupRule, groupShare, groupsCaption } from "./groups";

const HEIGHT_CLASS = "h-[340px] md:h-[264px]";

const GROW_X: Variants = {
  hidden: { scaleX: 0 },
  shown: (index: number) => ({
    scaleX: 1,
    transition: { duration: 0.8, delay: 0.15 + index * 0.15, ease: EASE },
  }),
};

const LABEL_FADE: Variants = {
  hidden: { opacity: 0 },
  shown: (index: number) => ({
    opacity: 1,
    transition: { duration: 0.4, delay: 0.95 + index * 0.15, ease: EASE },
  }),
};

const DOT_PULSE: Variants = {
  hidden: { scale: 1 },
  shown: { scale: [1, 1.8, 1], transition: { duration: 0.6, delay: 1.45, ease: EASE } },
};

type Count = { customers: number; returned: number };

// A date the model did not fit has no counts, so it reads "did not converge" and never a made-up share.
function cellText(count: Count | null): string {
  if (count === null) return "did not converge";
  const share = groupShare(count);
  if (share === null) return "none";
  return `${formatShare(share)} (${formatCount(count.returned)} of ${formatCount(count.customers)})`;
}

function GroupsPlot({ bands }: { bands: ForecastBands }) {
  const still = useStill();
  const [showNumbers, setShowNumbers] = useState(false);
  const tableId = useId();

  return (
    <div>
      <motion.ul
        role="list"
        className="flex max-w-[960px] flex-col gap-y-8"
        initial={still ? "shown" : "hidden"}
        whileInView={still ? undefined : "shown"}
        viewport={{ once: true, amount: 0.4 }}
      >
        {GROUPS.map((key, index) => {
          const count = bands.pooled[key];
          const share = groupShare(count);
          const name = groupName(key);
          const nudged = key === "worthANudge";
          const barColour = nudged
            ? "bg-accent group-hover:bg-accent-hi group-focus-visible:bg-accent-hi"
            : "bg-bone/[0.78] group-hover:bg-bone group-focus-visible:bg-bone";
          // A bar this long leaves no room on its right, so its number sits inside the end of it.
          const labelInside = share !== null && share > 0.85;

          return (
            <li
              key={key}
              tabIndex={0}
              aria-label={
                share === null
                  ? `${name}: not measured`
                  : `${name}: ${formatShare(share)} came back on their own, ${formatCount(count.returned)} of ${formatCount(count.customers)} quiet regulars`
              }
              className={`group grid grid-cols-1 gap-y-3 rounded-[4px] outline-none md:grid-cols-[240px_1fr] md:items-center md:gap-x-8 ${FOCUS_RING}`}
            >
              <div>
                <p className="font-sans text-[15px] font-semibold text-bone md:text-[16px]">{name}</p>
                <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-bone-faint">
                  {groupRule(key, bands)}
                </p>
                {nudged && (
                  <p className="mt-2 inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-bone-dim">
                    <motion.span className="block h-[6px] w-[6px] rounded-full bg-accent" variants={DOT_PULSE} />
                    who Mend nudges
                  </p>
                )}
              </div>

              <div>
                <div className="relative h-8 w-full rounded-[4px] bg-bone/[0.06] transition-colors duration-150 ease-out group-hover:bg-bone/[0.09] group-focus-visible:bg-bone/[0.09] md:h-9">
                  <span aria-hidden="true" className="absolute inset-y-0 left-1/2 w-px bg-bone/10" />
                  {share === null ? (
                    <p className="absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-bone-dim">Not measured</p>
                  ) : (
                    <>
                      <motion.div
                        aria-hidden="true"
                        className={`absolute inset-y-0 left-0 rounded-[4px] transition-colors duration-150 ease-out ${barColour}`}
                        style={{ width: `${share * 100}%`, transformOrigin: "left" }}
                        variants={GROW_X}
                        custom={index}
                      />
                      <motion.p
                        variants={LABEL_FADE}
                        custom={index}
                        className={`absolute top-1/2 -translate-y-1/2 font-sans text-[16px] font-semibold tabular-nums ${labelInside ? "text-ink" : "text-bone"}`}
                        style={
                          labelInside
                            ? { right: `calc(${(1 - share) * 100}% + 12px)` }
                            : { left: `calc(${share * 100}% + 12px)` }
                        }
                      >
                        {formatShare(share)}
                      </motion.p>
                    </>
                  )}
                </div>
                <motion.p
                  variants={LABEL_FADE}
                  custom={index}
                  className="mt-2 font-mono text-[11px] tabular-nums text-bone-faint"
                >
                  {count.customers === 0
                    ? "0 customers"
                    : `${formatCount(count.returned)} of ${formatCount(count.customers)} came back`}
                </motion.p>
              </div>
            </li>
          );
        })}
      </motion.ul>

      <div aria-hidden="true" className="mt-3 grid max-w-[960px] grid-cols-1 md:grid-cols-[240px_1fr] md:gap-x-8">
        <div className="hidden md:block" />
        <div className="relative h-4 font-mono text-[11px] text-bone-faint">
          <span className="absolute left-0 top-0">0</span>
          <span className="absolute left-1/2 top-0 -translate-x-1/2">50%</span>
          <span className="absolute right-0 top-0">100%</span>
        </div>
      </div>

      <NumbersToggle open={showNumbers} onToggle={() => setShowNumbers((open) => !open)} controls={tableId} />
      <div id={tableId} hidden={!showNumbers}>
        <div className="overflow-x-auto">
          <table className="mt-4 w-full max-w-[720px] text-[14px] tabular-nums">
            <caption className="sr-only">
              Share of quiet regulars who came back on their own, by date and forecast group
            </caption>
            <thead>
              <tr className="border-b border-bone/10">
                <th scope="col" className={`${HEAD_CELL} whitespace-nowrap`}>
                  Date
                </th>
                <th scope="col" className={`${HEAD_CELL} whitespace-nowrap text-right`}>
                  Likely gone
                </th>
                <th scope="col" className={`${HEAD_CELL} whitespace-nowrap text-right`}>
                  Worth a nudge
                </th>
                <th scope="col" className={`${HEAD_CELL} whitespace-nowrap pr-0 text-right`}>
                  Likely back anyway
                </th>
              </tr>
            </thead>
            <tbody>
              {bands.cutoffs.map((row) => (
                <tr key={row.cutoff} className="border-b border-bone/10">
                  <th scope="row" className="whitespace-nowrap py-2 pr-4 text-left font-normal text-bone-dim">
                    {formatDay(row.cutoff)}
                  </th>
                  {GROUPS.map((key, column) => (
                    <td key={key} className={`whitespace-nowrap py-2 text-right text-bone ${column < 2 ? "pr-4" : ""}`}>
                      {cellText(row.converged ? row[key] : null)}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-b border-bone/10">
                <th scope="row" className="whitespace-nowrap py-2 pr-4 text-left font-normal text-bone-dim">
                  All dates
                </th>
                {GROUPS.map((key, column) => (
                  <td key={key} className={`whitespace-nowrap py-2 text-right font-semibold text-bone ${column < 2 ? "pr-4" : ""}`}>
                    {cellText(bands.pooled[key])}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function GroupsChart({ state, summary }: BlockProps) {
  const titleId = useId();
  const title = "Quiet regulars who came back on their own";
  const backtest = summary?.backtest ?? null;
  const bands = backtest?.bands;

  if (state !== "ready" || summary === null) {
    return (
      <ChartFrame titleId={titleId} title={title} caption={null}>
        <ChartPlaceholder heightClass={HEIGHT_CLASS} />
      </ChartFrame>
    );
  }

  if (backtest === null || bands === null || bands === undefined) {
    return (
      <ChartFrame titleId={titleId} title={title} caption={null}>
        <NotMeasured heightClass={HEIGHT_CLASS} />
      </ChartFrame>
    );
  }

  return (
    <ChartFrame titleId={titleId} title={title} caption={groupsCaption(bands, backtest.holdoutDays)}>
      <GroupsPlot bands={bands} />
    </ChartFrame>
  );
}
