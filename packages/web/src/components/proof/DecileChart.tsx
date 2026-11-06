"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { motion, type Variants } from "motion/react";
import { useStill } from "@/components/motion/useStill";
import { formatCount, formatDay, formatShare, type ShopSummary } from "@/components/live/summary";

export const EASE = [0.22, 1, 0.36, 1] as const;

// outline-solid is needed because rows and columns also carry outline-none, which would otherwise switch this ring off.
export const FOCUS_RING =
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ink";

// The three proof blocks share a frame, a hover card, a size reader and the numbers toggle.
// They live here, in the first block, so the other two import them without a cycle.
export type BlockProps = { state: "loading" | "ready"; summary: ShopSummary | null };

export function ChartFrame({
  titleId,
  title,
  caption,
  children,
}: {
  titleId: string;
  title: string;
  caption: string | null;
  children: ReactNode;
}) {
  return (
    <div className="patch h-full min-w-0 px-6 py-[30px] md:px-11 md:py-10">
      <h3 id={titleId} className="poster-title text-[26px] text-ink md:text-[30px]">
        {title}
      </h3>
      {caption !== null && (
        <p className="mt-3 max-w-[60ch] text-[15px] leading-[1.5] text-ink-dim">{caption}</p>
      )}
      <div className="mt-6">{children}</div>
    </div>
  );
}

export function ChartPlaceholder({ heightClass }: { heightClass: string }) {
  return <div aria-hidden="true" className={`w-full rounded-[12px] bg-pale-teal ${heightClass}`} />;
}

export function NotMeasured({ heightClass }: { heightClass: string }) {
  return (
    <div className={`flex w-full items-center text-[14px] text-ink-dim ${heightClass}`}>
      <p>Not measured yet.</p>
    </div>
  );
}

type Box = { w: number; h: number };

// A callback ref kept in state, so the observer starts once the element really exists.
export function useMeasuredBox() {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState<Box | null>(null);

  useEffect(() => {
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1].contentRect;
      const next = { w: Math.round(rect.width), h: Math.round(rect.height) };
      setBox((current) => (current !== null && current.w === next.w && current.h === next.h ? current : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return { ref: setElement, box };
}

const TOOLTIP_FLIP_EDGE = 160;
const TOOLTIP_SIDE_EDGE = 100;
const TOOLTIP_PADDING = 24;

// Centred over the mark, except near an edge: within 160 px of the right edge it opens
// to the left of the mark, and within 100 px of the left edge it opens to the right.
// Once measured, it is then held inside the chart so a narrow phone never cuts it off.
export function ChartTooltip({
  x,
  bottom,
  boxWidth,
  children,
}: {
  x: number;
  bottom: number;
  boxWidth: number;
  children: ReactNode;
}) {
  const { ref, box } = useMeasuredBox();
  const width = box === null ? 0 : box.w + TOOLTIP_PADDING;
  const wanted =
    boxWidth - x < TOOLTIP_FLIP_EDGE ? x + 12 - width : x < TOOLTIP_SIDE_EDGE ? x - 12 : x - width / 2;
  const left = Math.min(Math.max(wanted, 0), Math.max(0, boxWidth - width));
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute z-10 w-max max-w-[220px] rounded-[10px] bg-ink px-3 py-2 text-paper"
      style={{ left, top: bottom, transform: "translateY(-100%)", visibility: box === null ? "hidden" : "visible" }}
    >
      {children}
    </div>
  );
}

export function NumbersToggle({
  open,
  onToggle,
  controls,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={`mt-6 inline-flex h-10 items-center rounded-[10px] border-2 border-ink px-4 text-[15px] font-semibold text-ink transition-colors duration-[160ms] ease-out hover:bg-ink hover:text-paper ${FOCUS_RING}`}
    >
      {open ? "Hide the numbers" : "Show the numbers"}
    </button>
  );
}

export const HEAD_CELL =
  "py-2 pr-4 text-left font-mono text-[12px] font-medium uppercase tracking-[0.14em] text-ink-faint";

// A running stitch between table rows, with none under the last row.
export const ROW_RULE = "border-b-[1.5px] border-dashed border-stitch last:border-b-0";

// The one line that sits under the header row of every table.
export const HEAD_RULE = "border-b-[1.5px] border-dashed border-stitch";

const HEIGHT_CLASS = "h-[260px] md:h-[320px]";

const GUTTER = 40;
const TOP = 28;
const BOTTOM = 52;
const BANDS = 10;
const MAX_COLUMN = 24;

const PAPER_RAISED = "#FFFDF7";
const FELT_TEAL = "#3FBFAE";
const ACCENT = "#D72A16";
const GRID = "rgb(18 59 63 / 0.10)";

// Raised paper behind the letters keeps a label readable where it crosses a gridline.
const HALO = { paintOrder: "stroke", stroke: PAPER_RAISED, strokeWidth: 4, strokeLinejoin: "round" } as const;

const GROW: Variants = {
  hidden: { scaleY: 0 },
  shown: (index: number) => ({
    scaleY: 1,
    transition: { duration: 0.7, delay: index * 0.05, ease: EASE },
  }),
};

const LABEL_FADE: Variants = {
  hidden: { opacity: 0 },
  shown: (index: number) => ({
    opacity: 1,
    transition: { duration: 0.4, delay: index * 0.05 + 0.7, ease: EASE },
  }),
};

type Decile = { decile: number; customers: number; returnedShare: number };

function columnPath(left: number, top: number, width: number, base: number): string {
  const height = base - top;
  if (height < 0.5) return "";
  const r = Math.min(4, width / 2, height);
  return `M${left} ${base}V${top + r}A${r} ${r} 0 0 1 ${left + r} ${top}H${left + width - r}A${r} ${r} 0 0 1 ${left + width} ${top + r}V${base}Z`;
}

function DecilePlot({
  deciles,
  holdoutDays,
  titleId,
}: {
  deciles: readonly Decile[];
  holdoutDays: number;
  titleId: string;
}) {
  const still = useStill();
  const { ref, box } = useMeasuredBox();
  const [active, setActive] = useState<number | null>(null);
  const [showNumbers, setShowNumbers] = useState(false);
  const tableId = useId();

  let plot: ReactNode = null;
  let tooltip: ReactNode = null;

  // A box narrower than the gutter (0 while the page is not laid out) would give every column a negative width.
  if (box !== null && box.w > GUTTER) {
    const plotH = box.h - TOP - BOTTOM;
    const band = (box.w - GUTTER) / BANDS;
    const width = Math.min(MAX_COLUMN, band - 2);
    const base = TOP + plotH;
    const columns = deciles.map((d, index) => {
      const left = GUTTER + (d.decile - 1) * band + (band - width) / 2;
      return { ...d, index, left, top: base - plotH * d.returnedShare, center: left + width / 2 };
    });

    const first = columns.find((c) => c.decile === 1);
    const last = columns.find((c) => c.decile === 10);

    const hovered = columns.find((c) => c.decile === active);
    if (hovered !== undefined) {
      const bottom = hovered.decile === 1 ? hovered.top - 6 - 14 - 12 : hovered.top - 10;
      tooltip = (
        <ChartTooltip x={hovered.center} bottom={bottom} boxWidth={box.w}>
          <p className="font-sans text-[15px] font-semibold">{formatShare(hovered.returnedShare)}</p>
          <p className="text-[12px]">bought again within {holdoutDays} days</p>
          <p className="text-[12px]">
            group {hovered.decile}, {formatCount(hovered.customers)} customers
          </p>
        </ChartTooltip>
      );
    }

    const gridLines = [
      { share: 0, label: "0" },
      { share: 0.5, label: "50%" },
      { share: 1, label: "100%" },
    ];

    plot = (
      <motion.svg
        width={box.w}
        height={box.h}
        viewBox={`0 0 ${box.w} ${box.h}`}
        role="group"
        aria-labelledby={titleId}
        className="block overflow-visible"
        initial={still ? "shown" : "hidden"}
        whileInView={still ? undefined : "shown"}
        viewport={{ once: true, amount: 0.4 }}
      >
        {gridLines.map((line) => {
          const y = base - plotH * line.share;
          return (
            <g key={line.label}>
              <line x1={GUTTER} x2={box.w} y1={y} y2={y} stroke={GRID} strokeWidth={1} />
              <text x={GUTTER - 8} y={y + 4} textAnchor="end" className="fill-ink-faint font-mono text-[11px]">
                {line.label}
              </text>
            </g>
          );
        })}

        {columns.map((c) => {
          const lit = active === c.decile;
          const fill = lit ? ACCENT : FELT_TEAL;
          return (
            <motion.path
              key={c.decile}
              d={columnPath(c.left, c.top, width, base)}
              custom={c.index}
              variants={GROW}
              style={{ fill, transformBox: "fill-box", transformOrigin: "bottom", transition: "fill 150ms ease-out" }}
            />
          );
        })}

        {columns.map((c) => (
          <text key={c.decile} x={c.center} y={base + 18} textAnchor="middle" className="fill-ink-faint font-mono text-[11px]">
            {c.decile}
          </text>
        ))}
        <text x={GUTTER} y={base + 38} textAnchor="start" className="fill-ink-faint font-mono text-[11px]">
          least at risk
        </text>
        <text x={box.w} y={base + 38} textAnchor="end" className="fill-ink-faint font-mono text-[11px]">
          most at risk
        </text>

        {first !== undefined && (
          <motion.text
            x={first.center}
            y={first.top - 6}
            textAnchor="middle"
            custom={first.index}
            variants={LABEL_FADE}
            className="fill-ink font-sans text-[14px] font-semibold"
            style={HALO}
          >
            {formatShare(first.returnedShare)}
          </motion.text>
        )}
        {last !== undefined && (
          <motion.text
            x={last.left + width}
            y={last.top - 6}
            textAnchor="end"
            custom={last.index}
            variants={LABEL_FADE}
            className="fill-ink font-sans text-[14px] font-semibold"
            style={HALO}
          >
            {formatShare(last.returnedShare)}
          </motion.text>
        )}

        {columns.map((c) => {
          const bandLeft = GUTTER + (c.decile - 1) * band;
          return (
            <rect
              key={c.decile}
              x={bandLeft}
              y={TOP}
              width={band}
              height={plotH}
              fill="transparent"
              tabIndex={0}
              role="img"
              aria-label={`Group ${c.decile}: ${formatShare(c.returnedShare)} bought again, ${formatCount(c.customers)} customers`}
              className={`outline-none ${FOCUS_RING}`}
              onPointerEnter={() => setActive(c.decile)}
              onPointerLeave={(event) => {
                if (event.pointerType === "mouse") setActive((now) => (now === c.decile ? null : now));
              }}
              onFocus={() => setActive(c.decile)}
              onBlur={() => setActive((now) => (now === c.decile ? null : now))}
            />
          );
        })}
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
        <table className="mt-4 w-full max-w-[480px] text-[14px] tabular-nums">
          <caption className="sr-only">Share who bought again, by forecast group</caption>
          <thead>
            <tr className={HEAD_RULE}>
              <th scope="col" className={HEAD_CELL}>
                Group
              </th>
              <th scope="col" className={`${HEAD_CELL} text-right`}>
                Customers
              </th>
              <th scope="col" className={`${HEAD_CELL} pr-0 text-right`}>
                Bought again
              </th>
            </tr>
          </thead>
          <tbody>
            {deciles.map((d) => (
              <tr key={d.decile} className={ROW_RULE}>
                <th scope="row" className="py-2 pr-4 text-left font-normal text-ink-dim">
                  {d.decile}
                </th>
                <td className="py-2 pr-4 text-right text-ink">{formatCount(d.customers)}</td>
                <td className="py-2 text-right text-ink">{formatShare(d.returnedShare)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function DecileChart({ state, summary }: BlockProps) {
  const titleId = useId();
  const title = "Who came back, by forecast group";
  const backtest = summary?.backtest ?? null;

  if (state !== "ready" || summary === null) {
    return (
      <ChartFrame titleId={titleId} title={title} caption={null}>
        <ChartPlaceholder heightClass={HEIGHT_CLASS} />
      </ChartFrame>
    );
  }

  if (backtest === null || backtest.decileCutoff === null || backtest.deciles.length === 0) {
    return (
      <ChartFrame titleId={titleId} title={title} caption={null}>
        <NotMeasured heightClass={HEIGHT_CLASS} />
      </ChartFrame>
    );
  }

  const deciles = [...backtest.deciles].sort((a, b) => a.decile - b.decile);
  const total = deciles.reduce((sum, d) => sum + d.customers, 0);
  const caption = `All ${formatCount(total)} customers who had bought by ${formatDay(backtest.decileCutoff)}, ranked by Mend's forecast on that day and split into ten groups. Each bar is the share who bought again within ${backtest.holdoutDays} days.`;

  return (
    <ChartFrame titleId={titleId} title={title} caption={caption}>
      <DecilePlot deciles={deciles} holdoutDays={backtest.holdoutDays} titleId={titleId} />
    </ChartFrame>
  );
}
