"use client";

import { useId, useState } from "react";
import { motion } from "motion/react";
import { useStill } from "@/components/motion/useStill";
import type { CampaignRow } from "./api";
import { formatUsd } from "./money";
import { STATE_LABEL, type ThreadLook, type ThreadState } from "./status";
import { EASE } from "./ui";

export type ThreadMode = "review" | "sealed";

const WIDTH = 220;
const HEIGHT = 14;
const MIDDLE = HEIGHT / 2;
const CUT_FROM = 90;
const CUT_TO = 130;
const GAP = CUT_TO - CUT_FROM;
const GAP_MIDDLE = CUT_FROM + GAP / 2;
const BRIDGE_DOTS = [95, 101, 107, 113, 119, 125];
const FIBERS = [
  { length: 6, degrees: -22 },
  { length: 8, degrees: -8 },
  { length: 5, degrees: 10 },
];

const MEND_DRAW_SECONDS = 0.3;
const STITCH_AT = [0.25, 0.5, 0.75];
const STITCH_SIZE = 7;
const STITCH_APART_SECONDS = 0.08;
const GLOW_RADIUS = 40;
const GLOW_SECONDS = 0.6;
const KNOT_RADIUS = 4;
const KNOT_RING = 2;
const LIGHT_UP_SECONDS = 0.8;
const KNOT_AT = WIDTH - KNOT_RADIUS - KNOT_RING;

const STAND_IN_TITLE =
  "Joined by a script so the demo has people to pay. Their reward stays unclaimed until it is cancelled.";
const HOLDOUT_NOTE = "Held back on purpose. Never paid, so the results have something to compare with.";

const LABEL_COLOR: Record<ThreadState, string> = {
  waiting: "text-bone-faint",
  sending: "text-bone-faint",
  sent: "text-bone-dim",
  claimed: "text-bone",
  returned: "text-bone-dim",
  refused: "text-bone-faint",
  unclear: "text-bone-faint",
  held: "text-bone-faint",
};

function fibers(from: number, direction: 1 | -1): string {
  return FIBERS.map(({ length, degrees }) => {
    const radians = (degrees * Math.PI) / 180;
    const dx = Math.cos(radians) * length * direction;
    const dy = Math.sin(radians) * length;
    return `M${from} ${MIDDLE}l${dx.toFixed(2)} ${dy.toFixed(2)}`;
  }).join("");
}

const RIGHT_FIBERS = fibers(CUT_FROM, 1);
const LEFT_FIBERS = fibers(CUT_TO, -1);
const STITCH_PATH = `M${-STITCH_SIZE / 2} ${-STITCH_SIZE / 2}l${STITCH_SIZE} ${STITCH_SIZE}M${STITCH_SIZE / 2} ${-STITCH_SIZE / 2}l${-STITCH_SIZE} ${STITCH_SIZE}`;

function isMended(state: ThreadState | null): boolean {
  return state === "sent" || state === "claimed";
}

type ThreadProps = {
  role: CampaignRow["role"];
  mode: ThreadMode;
  look: ThreadLook | undefined;
  still: boolean;
};

/**
 * A thread cut in the middle. Before payout a reward is waiting to be stitched and a held-back
 * customer is bridged by dots. Once PayPal answers, the gap tells where the payment is: a dot
 * crossing it while PayPal works, a red mend when the payment is sent or claimed, a dotted line
 * where it came back. The mend and the light-up play only when the state changes while this
 * is on screen; a thread that loads already mended or already returned is drawn finished.
 */
function Thread({ role, mode, look, still }: ThreadProps) {
  const glowId = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const state = look?.state ?? null;
  const mended = isMended(state);
  const hasReturn = look?.returned != null;

  const [seen, setSeen] = useState({ mended, hasReturn, playMend: false, lightUp: false });
  if (seen.mended !== mended || seen.hasReturn !== hasReturn) {
    setSeen({ mended, hasReturn, playMend: !seen.mended && mended, lightUp: !seen.hasReturn && hasReturn });
  }
  const playMend = seen.playMend && !still;
  const lightUp = seen.lightUp && !still;

  const reward = role === "reward";
  const guide = reward && (state === "sending" || state === "unclear" || (state === null && mode === "sealed"));
  const bright = mended || hasReturn;
  const segmentClass = bright ? "stroke-bone/90" : "stroke-bone/70";
  const segments = `M0 ${MIDDLE}H${CUT_FROM}M${CUT_TO} ${MIDDLE}H${WIDTH}`;

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      fill="none"
      aria-hidden="true"
      className="block h-auto w-full overflow-visible md:h-[14px] md:w-[220px]"
    >
      {reward && mended && (
        <defs>
          <radialGradient id={glowId}>
            <stop offset="0" stopColor="#ff4d2e" stopOpacity="1" />
            <stop offset="1" stopColor="#ff4d2e" stopOpacity="0" />
          </radialGradient>
        </defs>
      )}

      <path
        d={segments}
        className={`${segmentClass} transition-[stroke] duration-300 ease-out motion-reduce:transition-none`}
        strokeWidth="2"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {lightUp && (
        <motion.path
          d={segments}
          className="stroke-bone"
          strokeWidth="2"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: LIGHT_UP_SECONDS, ease: "easeOut" }}
        />
      )}

      {!(reward && mended) && (
        <path
          d={`${RIGHT_FIBERS}${LEFT_FIBERS}`}
          className={segmentClass}
          strokeWidth="1.25"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}

      {role === "holdout" &&
        BRIDGE_DOTS.map((x) => (
          <circle key={x} cx={x} cy={MIDDLE} r="1.25" className={bright ? "fill-bone/90" : "fill-bone/70"} />
        ))}

      {guide && (
        <path
          d={`M${CUT_FROM} ${MIDDLE}H${CUT_TO}`}
          className="stroke-bone/40"
          strokeWidth="1"
          strokeDasharray="3 4"
          vectorEffect="non-scaling-stroke"
        />
      )}

      {reward && state === "sending" &&
        (still ? (
          <circle cx={GAP_MIDDLE} cy={MIDDLE} r="3" className="fill-bone" />
        ) : (
          <motion.circle
            cx={CUT_FROM}
            cy={MIDDLE}
            r="3"
            className="fill-bone"
            initial={{ x: 0 }}
            animate={{ x: GAP }}
            transition={{ duration: 1.4, ease: "easeInOut", repeat: Infinity }}
          />
        ))}

      {reward && state === "returned" && (
        <path
          d={`M${CUT_FROM} ${MIDDLE}H${CUT_TO}`}
          className="stroke-bone/40"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray="0.1 4.5"
          vectorEffect="non-scaling-stroke"
        />
      )}

      {reward && mended && (
        <>
          {playMend && (
            <motion.circle
              cx={GAP_MIDDLE}
              cy={MIDDLE}
              r={GLOW_RADIUS}
              fill={`url(#${glowId})`}
              initial={{ opacity: 0.35 }}
              animate={{ opacity: 0 }}
              transition={{ duration: GLOW_SECONDS, ease: "easeOut" }}
              style={{ pointerEvents: "none" }}
            />
          )}
          <motion.path
            d={`M${CUT_FROM} ${MIDDLE}H${CUT_TO}`}
            className="stroke-accent"
            strokeWidth="1.5"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            initial={playMend ? { scaleX: 0 } : false}
            animate={{ scaleX: 1 }}
            transition={{ duration: MEND_DRAW_SECONDS, ease: EASE }}
            style={{ originX: 0, originY: 0.5 }}
          />
          {STITCH_AT.map((share, i) => (
            <g key={share} transform={`translate(${CUT_FROM + GAP * share} ${MIDDLE})`}>
              <motion.path
                d={STITCH_PATH}
                className="stroke-accent"
                strokeWidth="1.5"
                strokeLinecap="round"
                initial={playMend ? { scale: 0 } : false}
                animate={{ scale: 1 }}
                transition={{
                  type: "spring",
                  stiffness: 500,
                  damping: 22,
                  delay: MEND_DRAW_SECONDS + i * STITCH_APART_SECONDS,
                }}
                style={{ originX: 0.5, originY: 0.5 }}
              />
            </g>
          ))}
        </>
      )}

      {hasReturn && (
        <g transform={`translate(${KNOT_AT} ${MIDDLE})`}>
          <motion.g
            initial={lightUp ? { scale: 0 } : false}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 500, damping: 22 }}
            style={{ originX: 0.5, originY: 0.5 }}
          >
            <circle r={KNOT_RADIUS + KNOT_RING} className="fill-ink" />
            <circle r={KNOT_RADIUS} className="fill-bone" />
          </motion.g>
        </g>
      )}
    </svg>
  );
}

function ThreadRow({
  row,
  mode,
  look,
  index,
  still,
}: {
  row: CampaignRow;
  mode: ThreadMode;
  look: ThreadLook | undefined;
  index: number;
  still: boolean;
}) {
  const reward = row.role === "reward";
  const returned = look?.returned ?? null;

  return (
    <motion.li
      role="listitem"
      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-3 border-b border-rule py-4 md:grid-cols-[48px_220px_minmax(0,1fr)_120px] md:gap-y-0"
      initial={still ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE, delay: index * 0.04 }}
    >
      <span className="font-mono text-[12px] leading-6 text-bone-faint md:col-start-1 md:row-start-1">
        #{row.rank}
      </span>

      <div className="col-span-2 row-start-2 md:col-span-1 md:col-start-2 md:row-start-1">
        <span className="block md:flex md:h-6 md:items-center">
          <Thread role={row.role} mode={mode} look={look} still={still} />
        </span>
        {returned !== null && (
          <p className="mt-1 text-right font-mono text-[11px] text-bone md:w-[220px]">
            {returned === "simulated" ? "came back (simulated)" : "came back"}
          </p>
        )}
      </div>

      <div className="col-span-2 row-start-3 min-w-0 md:col-span-1 md:col-start-3 md:row-start-1">
        {typeof row.displayName === "string" && row.displayName !== "" && (
          <p className="text-[15px] font-medium leading-[1.5] text-bone">{row.displayName}</p>
        )}
        {reward ? (
          row.note !== null && <p className="text-[15px] leading-[1.5] text-bone">{row.note}</p>
        ) : (
          <p className="text-[14px] leading-[1.5] text-bone-faint">{HOLDOUT_NOTE}</p>
        )}
        <p className="mt-2 font-mono text-[11px]">
          {row.standIn ? (
            <span title={STAND_IN_TITLE} className="text-bone-faint">
              demo stand-in
            </span>
          ) : (
            <span className="text-bone-dim">joined with PayPal</span>
          )}
          {reward && look !== undefined && (
            <span className={LABEL_COLOR[look.state]}> &middot; {STATE_LABEL[look.state]}</span>
          )}
        </p>
      </div>

      {reward && row.amountMinor !== null && (
        <span className="col-start-2 row-start-1 text-right text-[15px] font-semibold leading-6 tabular-nums text-bone md:col-start-4">
          {formatUsd(row.amountMinor)}
        </span>
      )}
    </motion.li>
  );
}

type GroupProps = {
  title: string;
  rows: readonly CampaignRow[];
  mode: ThreadMode;
  statuses: ReadonlyMap<string, ThreadLook> | undefined;
  still: boolean;
};

function Group({ title, rows, mode, statuses, still }: GroupProps) {
  const headingId = useId();
  if (rows.length === 0) return null;

  return (
    <section aria-labelledby={headingId} className="mt-10 first:mt-0">
      <div className="flex items-baseline justify-between border-b border-rule pb-3">
        <h2 id={headingId} className="font-mono text-[12px] uppercase tracking-[0.14em] text-bone-dim">
          {title}
        </h2>
        <span className="font-mono text-[12px] tabular-nums text-bone-faint">{rows.length}</span>
      </div>
      <ul role="list">
        {rows.map((row, i) => (
          <ThreadRow
            key={row.ref}
            row={row}
            mode={mode}
            look={statuses === undefined ? undefined : (statuses.get(row.ref) ?? { state: row.role === "reward" ? "waiting" : "held", returned: null })}
            index={i}
            still={still}
          />
        ))}
      </ul>
    </section>
  );
}

type CampaignThreadsProps = {
  rows: readonly CampaignRow[];
  mode: ThreadMode;
  /** The payout and results steps pass each customer's thread state by ref. Without it the threads show the plan only. */
  statuses?: ReadonlyMap<string, ThreadLook>;
};

export function CampaignThreads({ rows, mode, statuses }: CampaignThreadsProps) {
  const still = useStill();
  const byRank = (a: CampaignRow, b: CampaignRow) => a.rank - b.rank;
  const rewards = rows.filter((row) => row.role === "reward").sort(byRank);
  const heldBack = rows.filter((row) => row.role === "holdout").sort(byRank);

  return (
    <div>
      <Group title="Cashback" rows={rewards} mode={mode} statuses={statuses} still={still} />
      <Group title="Held back" rows={heldBack} mode={mode} statuses={statuses} still={still} />
    </div>
  );
}
