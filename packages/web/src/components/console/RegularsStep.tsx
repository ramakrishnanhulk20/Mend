"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { useStill } from "@/components/motion/useStill";
import { formatDay } from "@/components/live/summary";
import { ApiError, type ConsoleApi, type QuietRegular, type QuietRegulars } from "./api";
import { formatUsd, plural } from "./money";
import { EASE, FOCUS_RING, PRIMARY_BUTTON, TextButton } from "./ui";

const FIRST_ROWS = 12;
const LIST_SIZE = 50;
const SLOW_AFTER_MS = 2000;
const BUSY_RETRY_DEFAULT_SECONDS = 5;
const BUSY_RETRY_MAX_SECONDS = 30;
const PLACEHOLDER_ROWS = 8;

const THREAD_WIDTH = 220;
const THREAD_HEIGHT = 14;
const THREAD_MIDDLE = THREAD_HEIGHT / 2;
const THREAD_BREAKS_AT = 60;
const THREAD_LONGEST_GAP = 140;
const FIBERS = [
  { length: 6, degrees: -22 },
  { length: 8, degrees: -8 },
  { length: 5, degrees: 10 },
];

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function isBusy(error: ApiError): boolean {
  return error.status === 503 || error.code === "still_running";
}

// A busy engine gets one more try after the wait it asked for, then the person decides.
async function loadList(api: ConsoleApi, signal: AbortSignal): Promise<QuietRegulars> {
  try {
    return await api.quietRegulars(LIST_SIZE, { signal });
  } catch (error) {
    if (!(error instanceof ApiError) || !isBusy(error)) throw error;
    const seconds = Math.min(error.retryAfterSeconds ?? BUSY_RETRY_DEFAULT_SECONDS, BUSY_RETRY_MAX_SECONDS);
    await wait(seconds * 1000, signal);
    return await api.quietRegulars(LIST_SIZE, { signal });
  }
}

type Failure =
  | { kind: "not_converged" }
  | { kind: "busy" }
  | { kind: "limit"; minutes: number | null }
  | { kind: "other" };

function failureFor(error: unknown): Failure {
  if (error instanceof ApiError) {
    if (error.code === "model_not_converged") return { kind: "not_converged" };
    if (isBusy(error)) return { kind: "busy" };
    if (error.status === 429) {
      const seconds = error.retryAfterSeconds;
      return { kind: "limit", minutes: seconds === null ? null : Math.max(1, Math.ceil(seconds / 60)) };
    }
  }
  return { kind: "other" };
}

type Load =
  | { kind: "loading" }
  | { kind: "ready"; data: QuietRegulars }
  | { kind: "failed"; failure: Failure };

function SilenceThread({ daysSilent, longest }: { daysSilent: number; longest: number }) {
  const gap = longest > 0 ? (daysSilent / longest) * THREAD_LONGEST_GAP : 0;
  const resumesAt = THREAD_BREAKS_AT + gap;
  const fibers = (from: number, direction: 1 | -1) =>
    FIBERS.map(({ length, degrees }) => {
      const radians = (degrees * Math.PI) / 180;
      const dx = Math.cos(radians) * length * direction;
      const dy = Math.sin(radians) * length;
      return `M${from} ${THREAD_MIDDLE}l${dx.toFixed(2)} ${dy.toFixed(2)}`;
    }).join("");

  return (
    <svg
      viewBox={`0 0 ${THREAD_WIDTH} ${THREAD_HEIGHT}`}
      fill="none"
      aria-hidden="true"
      className="block h-auto w-full md:h-[14px] md:w-[220px]"
    >
      <path
        d={`M0 ${THREAD_MIDDLE}H${THREAD_BREAKS_AT}`}
        className="stroke-bone/70"
        strokeWidth="2"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={`M${resumesAt.toFixed(2)} ${THREAD_MIDDLE}H${THREAD_WIDTH}`}
        className="stroke-bone/30"
        strokeWidth="2"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={fibers(THREAD_BREAKS_AT, 1)}
        className="stroke-bone/70"
        strokeWidth="1.25"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={fibers(resumesAt, -1)}
        className="stroke-bone/30"
        strokeWidth="1.25"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

const ROW_GRID =
  "grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 md:grid-cols-[56px_minmax(0,1fr)_220px_140px] md:gap-x-6 md:gap-y-0";

// A score under half a cent of an order would round to 0.00, which reads as "never", so it says so in words.
function forecast(score: number): string {
  return score < 0.005 ? "under 0.01 orders" : `${score.toFixed(2)} orders`;
}

function RegularRow({ row, longest, index, still }: { row: QuietRegular; longest: number; index: number; still: boolean }) {
  const paid = formatUsd(row.paidNetMinor);
  const rank = String(row.position).padStart(2, "0");

  return (
    <motion.li
      role="listitem"
      tabIndex={0}
      title={`Paid ${paid} in total`}
      className={`group border-b border-rule px-3 py-4 transition-colors duration-200 ease-out hover:bg-ink-raised focus:bg-ink-raised ${FOCUS_RING}`}
      initial={still ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE, delay: index < FIRST_ROWS ? index * 0.03 : 0 }}
    >
      <div className={ROW_GRID}>
        <span className="col-start-1 row-start-1 font-mono text-[12px] text-bone-faint md:row-span-2">{rank}</span>
        <span className="col-start-2 row-start-1 min-w-0 truncate text-[16px] text-bone md:self-end">
          {row.displayName}
        </span>
        <span className="col-span-3 col-start-1 row-start-3 font-mono text-[12px] text-bone-faint md:col-span-1 md:col-start-2 md:row-start-2 md:self-start">
          {plural(row.purchaseDays, "purchase day", "purchase days")} &middot; silent {plural(row.daysSilent, "day", "days")}
        </span>
        <span className="col-span-3 col-start-1 row-start-2 md:col-span-1 md:col-start-3 md:row-span-2 md:row-start-1">
          <SilenceThread daysSilent={row.daysSilent} longest={longest} />
        </span>
        <span className="col-start-3 row-start-1 text-right md:col-start-4 md:row-span-2 md:text-left">
          <span className="block text-[14px] tabular-nums text-bone">{forecast(row.score)}</span>
          <span className="block font-mono text-[11px] text-bone-faint">expected in 13 weeks</span>
          {row.standIn ? (
            <span className="mt-1 block font-mono text-[11px] text-bone-faint">demo stand-in</span>
          ) : row.member ? (
            <span className="mt-1 flex items-center justify-end gap-[6px] md:justify-start">
              {/* The red stitch means "paid" elsewhere in the console, so joining gets a plain bone dot. */}
              <span aria-hidden="true" className="h-[6px] w-[6px] rounded-full bg-bone" />
              <span className="font-mono text-[11px] text-bone-dim">joined</span>
            </span>
          ) : (
            <span className="mt-1 block font-mono text-[11px] text-bone-faint">not on the list</span>
          )}
        </span>
      </div>

      <div className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:grid-rows-[1fr] group-focus:grid-rows-[1fr] motion-reduce:transition-none">
        <div className="min-h-0 overflow-hidden">
          <p className="pt-3 text-[13px] leading-[1.5] text-bone-dim">
            Paid {paid} in total &middot; forecast {row.score.toFixed(4)} orders in the next 13 weeks &middot;{" "}
            {row.standIn ? "demo stand-in, joined by a script" : row.member ? "can be paid" : "cannot be paid until they join"}
          </p>
        </div>
      </div>
    </motion.li>
  );
}

function PlaceholderRows({ still }: { still: boolean }) {
  return (
    <ul role="list" aria-hidden="true" className="-mx-3 mt-10 border-t border-rule">
      {Array.from({ length: PLACEHOLDER_ROWS }, (_, i) => (
        <li key={i} className="border-b border-rule px-3 py-4">
          <motion.div
            className={ROW_GRID}
            initial={{ opacity: still ? 0.6 : 0.4 }}
            animate={still ? { opacity: 0.6 } : { opacity: [0.4, 0.8, 0.4] }}
            transition={still ? { duration: 0 } : { duration: 1.2, ease: "easeInOut", repeat: Infinity, delay: i * 0.08 }}
          >
            <span className="col-start-1 row-start-1 h-[10px] w-[18px] rounded-[2px] bg-bone/8 md:row-span-2" />
            <span className="col-start-2 row-start-1 h-[14px] w-32 max-w-full rounded-[2px] bg-bone/8 md:self-end" />
            <span className="col-span-3 col-start-1 row-start-2 md:col-span-1 md:col-start-3 md:row-span-2 md:row-start-1">
              <svg viewBox="0 0 220 14" fill="none" className="block h-auto w-full md:h-[14px] md:w-[220px]">
                <path d="M0 7H220" className="stroke-bone/8" strokeWidth="1.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              </svg>
            </span>
            <span className="col-start-3 row-start-1 h-[14px] w-16 rounded-[2px] bg-bone/8 md:col-start-4 md:row-span-2" />
          </motion.div>
        </li>
      ))}
    </ul>
  );
}

const LABEL = "font-mono text-[12px] uppercase tracking-[0.14em] text-bone-faint";

function FailurePanel({ failure, onRetry }: { failure: Failure; onRetry: () => void }) {
  let text: string;
  let canRetry = true;
  switch (failure.kind) {
    case "not_converged":
      text = "Mend's forecast could not rank this shop right now.";
      break;
    case "busy":
      text = "The engine is busy. Try again in a moment.";
      break;
    case "limit":
      text =
        failure.minutes === null
          ? "You have looked at this list many times this hour. Try again later."
          : `You have looked at this list many times this hour. Try again in ${failure.minutes} min.`;
      canRetry = false;
      break;
    case "other":
      text = "The list didn't load.";
      break;
  }

  return (
    <div role="alert" className="mt-10 flex flex-wrap items-center justify-between gap-4 rounded-[8px] border border-rule bg-ink-raised p-6">
      <p className="flex max-w-[56ch] items-start gap-3 text-[16px] leading-[1.5] text-bone">
        <span aria-hidden="true" className="mt-[9px] block h-[6px] w-[6px] shrink-0 rounded-full bg-accent" />
        {text}
      </p>
      {canRetry && <TextButton onClick={onRetry}>Try again</TextButton>}
    </div>
  );
}

type RegularsStepProps = {
  api: ConsoleApi;
  onPlan: () => void;
};

export function RegularsStep({ api, onPlan }: RegularsStepProps) {
  const still = useStill();
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [slow, setSlow] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const slowTimer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);

    loadList(api, controller.signal)
      .then((data) => {
        clearTimeout(slowTimer);
        if (!controller.signal.aborted) setLoad({ kind: "ready", data });
      })
      .catch((error: unknown) => {
        clearTimeout(slowTimer);
        if (controller.signal.aborted) return;
        setLoad({ kind: "failed", failure: failureFor(error) });
      });

    return () => {
      controller.abort();
      clearTimeout(slowTimer);
    };
  }, [api, attempt]);

  const retry = useCallback(() => {
    setLoad({ kind: "loading" });
    setSlow(false);
    setAttempt((current) => current + 1);
  }, []);

  const data = load.kind === "ready" ? load.data : null;
  const rows = data?.rows ?? [];
  const longest = rows.reduce((most, row) => Math.max(most, row.daysSilent), 0);
  const shown = showAll ? rows : rows.slice(0, FIRST_ROWS);

  return (
    <section aria-labelledby="regulars-title" aria-busy={load.kind === "loading"}>
      <p className={LABEL}>Step 1 &middot; Quiet regulars</p>

      {data !== null ? (
        <>
          <h1
            id="regulars-title"
            className="poster-title mt-4 text-[40px] text-bone md:text-[56px]"
            style={{ lineHeight: 0.9 }}
          >
            {plural(data.total, "regular", "regulars")} went quiet.
          </h1>
          <p className="mt-5 max-w-[60ch] text-[16px] leading-[1.55] text-bone-dim">
            Ranked by Mend&apos;s forecast, most at risk first. Only customers who joined the shop&apos;s
            thank-you list with Log in with PayPal can be paid.
          </p>
          {data.asOf !== null && (
            <p className="mt-2 font-mono text-[12px] text-bone-faint">Records run to {formatDay(data.asOf)}</p>
          )}

          {rows.length === 0 ? (
            <p className="mt-10 border-t border-rule pt-6 text-[16px] text-bone-dim">No quiet regulars to show right now.</p>
          ) : (
            <ul role="list" className="-mx-3 mt-10 border-t border-rule">
              {shown.map((row, i) => (
                <RegularRow key={row.position} row={row} longest={longest} index={i} still={still} />
              ))}
            </ul>
          )}

          {rows.length > FIRST_ROWS && (
            <div className="mt-4">
              <TextButton mono expanded={showAll} onClick={() => setShowAll((current) => !current)}>
                {showAll ? `Show first ${FIRST_ROWS}` : `Show all ${rows.length}`}
              </TextButton>
            </div>
          )}

          <div className="mt-10 flex flex-wrap items-center justify-between gap-4">
            <p className="text-[14px] text-bone-dim">Next, Claude drafts a plan from these customers.</p>
            <button
              type="button"
              onClick={onPlan}
              className={`${PRIMARY_BUTTON} h-12 gap-2 px-[22px] text-[15px] ${FOCUS_RING}`}
            >
              Ask Claude for a plan
            </button>
          </div>
        </>
      ) : (
        <>
          <h1 id="regulars-title" className="sr-only">
            Quiet regulars
          </h1>
          {load.kind === "failed" ? (
            <FailurePanel failure={load.failure} onRetry={retry} />
          ) : (
            <>
              {slow && (
                <p role="status" className="mt-4 font-mono text-[12px] text-bone-faint">
                  Mend&apos;s forecast is ranking the shop&apos;s customers
                </p>
              )}
              <PlaceholderRows still={still} />
            </>
          )}
        </>
      )}
    </section>
  );
}
