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
    <header className="sticky top-0 z-40 mx-auto flex h-[60px] w-[calc(100%-24px)] max-w-[1392px] items-center justify-between whitespace-nowrap rounded-b-[20px] bg-paper px-4 shadow-[0_8px_24px_rgb(18_59_63/0.12)] after:pointer-events-none after:absolute after:inset-x-[6px] after:bottom-[6px] after:top-0 after:rounded-b-[15px] after:border-[1.5px] after:border-t-0 after:border-dashed after:border-stitch after:content-[''] md:w-[calc(100%-48px)] md:px-7">
      <div className="flex flex-1 items-center gap-4">
        <Link href="/" className={`group inline-flex items-center gap-[10px] text-ink ${FOCUS_RING}`}>
          <Mark size={20} spinOnHover />
          <span className="brand-word hidden text-[20px] min-[400px]:inline">
            Mend
          </span>
        </Link>
        <span aria-hidden="true" className="hidden h-5 w-px bg-rule sm:block lg:hidden 2xl:block" />
        <span className="hidden font-mono text-[12px] uppercase tracking-[0.14em] text-ink-dim sm:block lg:hidden 2xl:block">
          Demo console
        </span>
        <span className="label-tag h-6">Sandbox</span>
      </div>

      <StepRail step={step} onBreakIt={onBreakIt} />

      <div className="flex flex-1 items-center justify-end gap-4">
        <Link
          href="/docs"
          className={`group/docs inline-flex items-center py-2 text-[14px] text-ink-dim transition-colors duration-200 ease-out hover:text-ink focus-visible:text-ink ${FOCUS_RING}`}
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
