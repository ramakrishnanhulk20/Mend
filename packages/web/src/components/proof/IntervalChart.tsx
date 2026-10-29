"use client";

import { useId, useState, type ReactNode } from "react";
import { motion, useReducedMotion, type Variants } from "motion/react";
import {
  formatDifference,
  verdict,
  type ShopSummary,
} from "@/components/live/summary";
import {
  EASE,
  FOCUS_RING,
  HEAD_CELL,
  ChartFrame,
  ChartPlaceholder,
  ChartTooltip,
  NotMeasured,
  NumbersToggle,
  useMeasuredBox,
  type BlockProps,
} from "./DecileChart";

const HEIGHT = 220;
const HEIGHT_CLASS = "h-[220px]";
const ROW_HEIGHT = 84;
const AXIS_Y = 172;
const PAD_LEFT = 6;
const PAD_RIGHT = 64;

const BONE = "#ede6da";
const INK = "#0b0a0a";
const LINE = "rgb(237 230 218 / 0.6)";
const HOVER_BAND = "rgb(237 230 218 / 0.04)";
const ZERO_LINE = "rgb(237 230 218 / 0.35)";
const AXIS = "rgb(237 230 218 / 0.10)";

const HALO = { paintOrder: "stroke", stroke: INK, strokeWidth: 4, strokeLinejoin: "round" } as const;
const DOT_ORIGIN = { transformBox: "fill-box", transformOrigin: "center" } as const;

const VERDICT_WORD = { better: "Better", tie: "A tie", worse: "Worse", unknown: "Not measured" } as const;

// A line draws outward from the dot. The opacity step hides the round cap that some
// browsers paint as a dot when the drawn length is zero.
const DRAW: Variants = {
  hidden: { pathLength: 0, opacity: 0 },
  shown: {
    pathLength: 1,
    opacity: 1,
    transition: { pathLength: { duration: 0.7, ease: EASE }, opacity: { duration: 0.01 } },
  },
};

const POP: Variants = {
  hidden: { scale: 0 },
  shown: { scale: 1, transition: { type: "spring", stiffness: 500, damping: 22 } },
};

const LABEL_FADE: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.4, delay: 0.7, ease: EASE } },
};

type Group = NonNullable<NonNullable<ShopSummary["backtest"]>["headline"]>;

type Row = {
  key: string;
  label: string;
  group: Group | null;
  measured: { mean: number; low: number; high: number } | null;
};

function toRow(key: string, label: string, group: Group | null): Row {
  const { meanAucDifference: mean, intervalLow: low, intervalHigh: high } = group ?? {
    meanAucDifference: null,
    intervalLow: null,
    intervalHigh: null,
  };
  const measured = mean !== null && low !== null && high !== null ? { mean, low, high } : null;
  return { key, label, group, measured };
}

function verdictWord(row: Row): string {
  return VERDICT_WORD[verdict(row.measured?.low ?? null, row.measured?.high ?? null)];
}

function rangeText(row: Row): string {
  return row.measured === null ? "" : `${formatDifference(row.measured.low)} to ${formatDifference(row.measured.high)}`;
}

function IntervalPlot({ rows, titleId }: { rows: readonly Row[]; titleId: string }) {
  const still = Boolean(useReducedMotion());
  const { ref, box } = useMeasuredBox();
  const [active, setActive] = useState<number | null>(null);
  const [showNumbers, setShowNumbers] = useState(false);
  const tableId = useId();

  let plot: ReactNode = null;
  let tooltip: ReactNode = null;

  if (box !== null) {
    const measured = rows.flatMap((row) => (row.measured === null ? [] : [row.measured]));
    // Zero is always on the scale, so "no better" is never drawn off the chart.
    const lowest = Math.floor(Math.min(0, ...measured.map((m) => m.low)) * 100 - 1) / 100;
    const highest = Math.ceil(Math.max(0, ...measured.map((m) => m.high)) * 100 + 1) / 100;
    const left = PAD_LEFT;
    const right = box.w - PAD_RIGHT;
    const x = (value: number) => left + ((value - lowest) / (highest - lowest)) * (right - left);
    const zeroX = x(0);

    const hovered = active === null ? undefined : rows[active];
    if (active !== null && hovered?.measured) {
      const lineY = active * ROW_HEIGHT + 40;
      tooltip = (
        <ChartTooltip x={x(hovered.measured.mean)} bottom={lineY - 10} boxWidth={box.w}>
          <p className="font-sans text-[15px] font-semibold text-bone">{formatDifference(hovered.measured.mean)}</p>
          <p className="text-[12px] text-bone-dim">95 percent range {rangeText(hovered)}</p>
          <p className="text-[12px] text-bone-dim">
            won {hovered.group?.modelWins} of {hovered.group?.validCutoffs}
          </p>
        </ChartTooltip>
      );
    }

    plot = (
      <motion.svg
        width={box.w}
        height={HEIGHT}
        viewBox={`0 0 ${box.w} ${HEIGHT}`}
        role="group"
        aria-labelledby={titleId}
        className="block"
        initial={still ? "shown" : "hidden"}
        whileInView={still ? undefined : "shown"}
        viewport={{ once: true, amount: 0.4 }}
      >
        <line x1={left} x2={right} y1={AXIS_Y} y2={AXIS_Y} stroke={AXIS} strokeWidth={1} />
        {/* Drawn only beside each measured line and at the axis, so it never runs through a label. */}
        {[0, 1].map((index) => (
          <line key={index} x1={zeroX} x2={zeroX} y1={index * ROW_HEIGHT + 28} y2={index * ROW_HEIGHT + 52} stroke={ZERO_LINE} strokeWidth={1} />
        ))}
        <line x1={zeroX} x2={zeroX} y1={AXIS_Y - 6} y2={AXIS_Y + 5} stroke={ZERO_LINE} strokeWidth={1} />
        {[
          { at: left, anchor: "start" as const, value: lowest },
          { at: right, anchor: "end" as const, value: highest },
          { at: zeroX, anchor: "middle" as const, value: 0 },
        ].map((tick) => (
          <g key={tick.anchor}>
            <line x1={x(tick.value)} x2={x(tick.value)} y1={AXIS_Y} y2={AXIS_Y + 5} stroke={ZERO_LINE} strokeWidth={1} />
            <text x={tick.at} y={AXIS_Y + 22} textAnchor={tick.anchor} className="fill-bone-faint font-mono text-[11px]">
              {formatDifference(tick.value)}
            </text>
          </g>
        ))}
        <text x={zeroX} y={AXIS_Y + 40} textAnchor="middle" className="fill-bone-faint font-mono text-[11px]">
          no better
        </text>

        {rows.map((row, index) => {
          const top = index * ROW_HEIGHT;
          const lineY = top + 40;
          const lit = active === index;
          return (
            <g key={row.key}>
              {lit && <rect x={0} y={top} width={box.w} height={ROW_HEIGHT - 8} rx={4} fill={HOVER_BAND} />}
              <text x={0} y={top + 16} className="fill-bone font-sans text-[14px]" style={HALO}>
                {row.label}
              </text>
              {row.measured !== null && row.group !== null ? (
                <>
                  <motion.path
                    d={`M${x(row.measured.mean)} ${lineY}L${x(row.measured.low)} ${lineY}`}
                    variants={DRAW}
                    fill="none"
                    stroke={lit ? BONE : LINE}
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                  <motion.path
                    d={`M${x(row.measured.mean)} ${lineY}L${x(row.measured.high)} ${lineY}`}
                    variants={DRAW}
                    fill="none"
                    stroke={lit ? BONE : LINE}
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                  <motion.circle
                    cx={x(row.measured.mean)}
                    cy={lineY}
                    r={4.5}
                    fill={BONE}
                    stroke={INK}
                    strokeWidth={4}
                    variants={POP}
                    style={{ ...DOT_ORIGIN, paintOrder: "stroke" }}
                  />
                  <motion.text
                    x={x(row.measured.high) + 10}
                    y={lineY + 5}
                    variants={LABEL_FADE}
                    className="fill-bone font-sans text-[14px] font-semibold"
                    style={HALO}
                  >
                    {formatDifference(row.measured.mean)}
                  </motion.text>
                  <motion.text
                    x={0}
                    y={top + 64}
                    variants={LABEL_FADE}
                    className="fill-bone-dim font-mono text-[12px]"
                    style={HALO}
                  >
                    {`${verdictWord(row)}: won ${row.group.modelWins} of ${row.group.validCutoffs} test dates`}
                  </motion.text>
                </>
              ) : (
                <text x={0} y={top + 40} className="fill-bone-dim font-sans text-[14px]">
                  Not measured yet.
                </text>
              )}
            </g>
          );
        })}

        {rows.map((row, index) =>
          row.measured === null || row.group === null ? null : (
            <rect
              key={row.key}
              x={0}
              y={index * ROW_HEIGHT}
              width={box.w}
              height={ROW_HEIGHT - 8}
              fill="transparent"
              tabIndex={0}
              role="img"
              aria-label={`${row.label}: difference ${formatDifference(row.measured.mean)}, 95 percent range ${rangeText(row)}, won ${row.group.modelWins} of ${row.group.validCutoffs} test dates`}
              className={`outline-none ${FOCUS_RING}`}
              onPointerEnter={() => setActive(index)}
              onPointerLeave={(event) => {
                if (event.pointerType === "mouse") setActive((now) => (now === index ? null : now));
              }}
              onFocus={() => setActive(index)}
              onBlur={() => setActive((now) => (now === index ? null : now))}
            />
          ),
        )}
      </motion.svg>
    );
  }

  return (
    <div>
      <div ref={ref} className={`relative w-full ${HEIGHT_CLASS}`}>
        {plot}
        {tooltip}
      </div>
      <NumbersToggle open={showNumbers} onToggle={() => setShowNumbers((open) => !open)} controls={tableId} />
      <div id={tableId} hidden={!showNumbers}>
        <table className="mt-4 w-full text-[14px] tabular-nums">
          <caption className="sr-only">Difference in ranking quality against sorting by last order</caption>
          <thead>
            <tr className="border-b border-bone/10">
              <th scope="col" className={HEAD_CELL}>
                Group
              </th>
              <th scope="col" className={`${HEAD_CELL} text-right`}>
                Difference
              </th>
              <th scope="col" className={`${HEAD_CELL} text-right`}>
                95% range
              </th>
              <th scope="col" className={`${HEAD_CELL} pr-0 text-right`}>
                Wins
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-bone/10">
                <th scope="row" className="py-2 pr-4 text-left font-normal text-bone-dim">
                  {row.label}
                </th>
                {row.measured !== null && row.group !== null ? (
                  <>
                    <td className="py-2 pr-4 text-right text-bone">{formatDifference(row.measured.mean)}</td>
                    <td className="py-2 pr-4 text-right text-bone">{rangeText(row)}</td>
                    <td className="py-2 text-right text-bone">
                      {row.group.modelWins} of {row.group.validCutoffs}
                    </td>
                  </>
                ) : (
                  <td colSpan={3} className="py-2 text-right text-bone-dim">
                    Not measured yet.
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function IntervalChart({ state, summary }: BlockProps) {
  const titleId = useId();
  const title = "Better than 'most recent order'?";
  const caption =
    "How much better Mend ranks who comes back than simply sorting by each customer's last order. Each line is the measured difference with its 95 percent range; right of zero means Mend ranks better.";

  if (state !== "ready" || summary === null) {
    return (
      <ChartFrame titleId={titleId} title={title} caption={caption}>
        <ChartPlaceholder heightClass={HEIGHT_CLASS} />
      </ChartFrame>
    );
  }

  const backtest = summary.backtest;
  const rows = [
    toRow("headline", "Quiet regulars, the customers campaigns target", backtest?.headline ?? null),
    toRow("all", "All customers", backtest?.allCustomers ?? null),
  ];

  if (rows.every((row) => row.measured === null)) {
    return (
      <ChartFrame titleId={titleId} title={title} caption={caption}>
        <NotMeasured heightClass={HEIGHT_CLASS} />
      </ChartFrame>
    );
  }

  return (
    <ChartFrame titleId={titleId} title={title} caption={caption}>
      <IntervalPlot rows={rows} titleId={titleId} />
    </ChartFrame>
  );
}
