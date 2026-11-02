"use client";

import Link from "next/link";
import { Mark } from "@/components/brand/Mark";
import { FOCUS_RING, StepRail, TextButton, type Step } from "./StepRail";
import { UNDERLINE_DRAW } from "./ui";

export type SessionInfo = { expiresAt: string };

type TopBarProps = {
  step: Step;
  session: SessionInfo | null;
  ending: boolean;
  onEnd: () => void;
  onBreakIt?: () => void;
};

// From lg the step rail takes the middle of the bar. With Break it as a sixth item there is no
// room left for the console label as well below 2xl, so it steps aside until then.
export function TopBar({ step, session, ending, onEnd, onBreakIt }: TopBarProps) {
  return (
    <header className="sticky top-0 z-40 flex h-16 items-center justify-between whitespace-nowrap border-b border-rule bg-ink/90 px-4 backdrop-blur md:px-10">
      <div className="flex flex-1 items-center gap-4">
        <Link href="/" className={`group inline-flex items-center gap-[10px] text-bone ${FOCUS_RING}`}>
          <Mark size={20} spinOnHover />
          {/* Inline, because .poster-title sits outside Tailwind's layers and would beat a tracking class. */}
          <span className="poster-title hidden text-[20px] min-[400px]:inline" style={{ letterSpacing: "0.04em" }}>
            Mend
          </span>
        </Link>
        <span aria-hidden="true" className="hidden h-5 w-px bg-rule sm:block lg:hidden 2xl:block" />
        <span className="hidden font-mono text-[12px] uppercase tracking-[0.14em] text-bone-dim sm:block lg:hidden 2xl:block">
          Demo console
        </span>
        <span className="rounded-[6px] border border-rule px-2 py-[3px] font-mono text-[10.5px] uppercase tracking-[0.14em] text-bone-faint">
          Sandbox
        </span>
      </div>

      <StepRail step={step} onBreakIt={onBreakIt} />

      <div className="flex flex-1 items-center justify-end gap-4">
        <Link
          href="/docs"
          className={`group/docs inline-flex items-center py-2 text-[14px] text-bone-dim transition-colors duration-200 ease-out hover:text-bone focus-visible:text-bone ${FOCUS_RING}`}
        >
          <span className="relative">
            Docs
            <span
              aria-hidden="true"
              className={`${UNDERLINE_DRAW} group-hover/docs:scale-x-100 group-focus-visible/docs:scale-x-100`}
            />
          </span>
        </Link>
        {session !== null && (
          <TextButton onClick={onEnd} disabled={ending}>
            End session
          </TextButton>
        )}
      </div>
    </header>
  );
}
