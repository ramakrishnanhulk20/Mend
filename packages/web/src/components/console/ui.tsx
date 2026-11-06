"use client";

import { useEffect, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { useStill } from "@/components/motion/useStill";

export const EASE = [0.22, 1, 0.36, 1] as const;

export const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ink";

export const PRIMARY_BUTTON = "btn-felt";

export const SECONDARY_BUTTON = "btn-line";

export const UNDERLINE_DRAW =
  "absolute inset-x-0 -bottom-1 h-px origin-left scale-x-0 bg-ink transition-transform duration-200 ease-out";

export function Spinner() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      className="shrink-0 animate-[spin_0.8s_linear_infinite] motion-reduce:animate-none"
    >
      <circle cx="7" cy="7" r="5.5" className="stroke-current" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="9 26" />
    </svg>
  );
}

/** Seconds since this component appeared, ticking once a second. */
export function useElapsedSeconds(running: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => {
      clearInterval(timer);
      setSeconds(0);
    };
  }, [running]);
  return seconds;
}

/** A thread with a short bright piece sliding along it; it holds still for people who ask for less motion. */
export function LoomLine() {
  const still = useStill();
  return (
    <div aria-hidden="true" className="relative h-[3px] w-full overflow-hidden rounded-full bg-pale-teal">
      {still ? (
        <span className="absolute top-0 h-[3px] w-[60px] rounded-full bg-accent" style={{ left: "calc(50% - 30px)" }} />
      ) : (
        <motion.span
          className="absolute top-0 h-[3px] w-[60px] rounded-full bg-accent"
          initial={{ left: "-60px" }}
          animate={{ left: "100%" }}
          transition={{ duration: 1.6, ease: "easeInOut", repeat: Infinity }}
        />
      )}
    </div>
  );
}

/** The brand glyph: a short thread with the red cross-stitch on it. It marks a step or a plan as done. */
export function StitchedThread() {
  return (
    <svg width="28" height="10" viewBox="0 0 28 10" fill="none" aria-hidden="true" className="shrink-0">
      <path d="M0 5h9M19 5h9" className="stroke-ink-faint" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M11.5 2.5l5 5M16.5 2.5l-5 5" className="stroke-accent" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** A peach felt patch with the accent dot: an error or a note about the step, announced to screen readers. */
export function NoticePanel({
  children,
  alert = true,
  action,
}: {
  children: ReactNode;
  alert?: boolean;
  action?: ReactNode;
}) {
  return (
    <div
      role={alert ? "alert" : "status"}
      className="patch patch-tinted mt-6 flex flex-wrap items-center justify-between gap-4 bg-pale-peach px-[22px] py-[18px]"
    >
      <p className="flex max-w-[60ch] items-start gap-3 text-[15px] leading-[1.5] text-ink">
        <span aria-hidden="true" className="mt-[8px] block h-[6px] w-[6px] shrink-0 rounded-full bg-accent" />
        {children}
      </p>
      {action}
    </div>
  );
}

const TINT = {
  sky: "bg-pale-sky",
  butter: "bg-pale-butter",
  peach: "bg-pale-peach",
  teal: "bg-pale-teal",
  sage: "bg-pale-sage",
} as const;

export type StepTint = keyof typeof TINT;

type StepHeaderProps = {
  tint: StepTint;
  kicker: string;
  titleId: string;
  title: ReactNode;
  /** Classes for the h1 size. Start has a bigger one than the other steps. */
  titleClass?: string;
  /** A picture for the right-hand side, hidden on phones. It is decoration, so it carries no text. */
  icon?: string;
  children?: ReactNode;
};

/** The coloured felt patch at the top of every step: a kicker, the poster title, then the step's intro lines. */
export function StepHeader({
  tint,
  kicker,
  titleId,
  title,
  titleClass = "text-[34px] md:text-[48px]",
  icon,
  children,
}: StepHeaderProps) {
  return (
    <div
      className={`patch patch-tinted relative mb-6 overflow-hidden px-6 py-7 md:py-[38px] ${
        icon === undefined ? "md:px-11" : "md:pl-11 md:pr-[170px]"
      } ${TINT[tint]}`}
    >
      <p className="font-mono text-[13px] uppercase tracking-[0.08em] text-ink-dim">{kicker}</p>
      <h1 id={titleId} className={`poster-title mt-4 text-ink ${titleClass}`}>
        {title}
      </h1>
      {children}
      {icon !== undefined && (
        // eslint-disable-next-line @next/next/no-img-element -- a small fixed decoration, not worth the image loader
        <img
          src={icon}
          alt=""
          className="pointer-events-none absolute right-9 top-1/2 hidden w-[132px] -translate-y-1/2 md:block"
        />
      )}
    </div>
  );
}

/** A labelled number: a small caps label over a big display figure. Put several in a dl. */
export function Figure({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-mono text-[12px] uppercase tracking-[0.14em] text-ink-dim">
        {label}
        {note !== undefined && (
          <>
            {" "}
            <span className="normal-case tracking-normal">{note}</span>
          </>
        )}
      </dt>
      <dd className="poster-title mt-2 break-words text-[34px] tabular-nums text-ink">{children}</dd>
    </div>
  );
}

type TextButtonProps = {
  children: ReactNode;
  onClick: () => void;
  mono?: boolean;
  expanded?: boolean;
  disabled?: boolean;
};

/** A quiet text button whose underline draws in on hover and focus. */
export function TextButton({ children, onClick, mono = false, expanded, disabled = false }: TextButtonProps) {
  const look = mono
    ? "font-mono text-[12px] uppercase tracking-[0.14em]"
    : "text-[14px]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-expanded={expanded}
      className={`group/text inline-flex items-center py-2 text-ink-dim transition-colors duration-200 ease-out hover:text-ink focus-visible:text-ink disabled:opacity-50 ${look} ${FOCUS_RING}`}
    >
      <span className="relative">
        {children}
        <span
          aria-hidden="true"
          className={`${UNDERLINE_DRAW} group-hover/text:scale-x-100 group-focus-visible/text:scale-x-100`}
        />
      </span>
    </button>
  );
}
