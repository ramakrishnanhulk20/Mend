"use client";

import { useEffect, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { useStill } from "@/components/motion/useStill";

export const EASE = [0.22, 1, 0.36, 1] as const;

export const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-bone";

export const PRIMARY_BUTTON =
  "inline-flex items-center rounded-[8px] bg-accent font-semibold text-ink transition-[background-color,translate] duration-150 ease-out hover:-translate-y-px hover:bg-accent-hi active:translate-y-0";

export const UNDERLINE_DRAW =
  "absolute inset-x-0 -bottom-1 h-px origin-left scale-x-0 bg-bone transition-transform duration-200 ease-out";

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
      <circle cx="7" cy="7" r="5.5" className="stroke-bone" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="9 26" />
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
    <div aria-hidden="true" className="relative h-px w-full overflow-hidden bg-bone/20">
      {still ? (
        <span className="absolute top-0 h-px w-[60px] bg-bone/70" style={{ left: "calc(50% - 30px)" }} />
      ) : (
        <motion.span
          className="absolute top-0 h-px w-[60px] bg-bone/70"
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
      <path d="M0 5h9M19 5h9" className="stroke-bone-faint" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M11.5 2.5l5 5M16.5 2.5l-5 5" className="stroke-accent" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** A bordered line with the accent dot: an error or a note about the step, announced to screen readers. */
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
      className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-[8px] border border-rule p-5"
    >
      <p className="flex max-w-[60ch] items-start gap-3 text-[15px] leading-[1.5] text-bone">
        <span aria-hidden="true" className="mt-[8px] block h-[6px] w-[6px] shrink-0 rounded-full bg-accent" />
        {children}
      </p>
      {action}
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
      className={`group/text inline-flex items-center py-2 text-bone-dim transition-colors duration-200 ease-out hover:text-bone focus-visible:text-bone disabled:opacity-50 ${look} ${FOCUS_RING}`}
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
