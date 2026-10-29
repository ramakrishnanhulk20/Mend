"use client";

import Link from "next/link";
import { Mark } from "@/components/brand/Mark";
import { FOCUS_RING, StepRail, TextButton, type Step } from "./StepRail";

export type SessionInfo = { expiresAt: string };

function localTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

type TopBarProps = {
  step: Step;
  session: SessionInfo | null;
  ending: boolean;
  onEnd: () => void;
};

// From lg the step rail takes the middle of the bar. Between lg and xl there is no room left
// for the console label and the session time as well, so they step aside until xl.
export function TopBar({ step, session, ending, onEnd }: TopBarProps) {
  const endsAt = session === null ? null : localTime(session.expiresAt);

  return (
    <header className="sticky top-0 z-40 flex h-16 items-center justify-between whitespace-nowrap border-b border-rule bg-ink/90 px-4 backdrop-blur md:px-10">
      <div className="flex flex-1 items-center gap-4">
        <Link href="/" className={`group inline-flex items-center gap-[10px] text-bone ${FOCUS_RING}`}>
          <Mark size={20} spinOnHover />
          {/* Inline, because .poster-title sits outside Tailwind's layers and would beat a tracking class. */}
          <span className="poster-title text-[20px]" style={{ letterSpacing: "0.04em" }}>
            Mend
          </span>
        </Link>
        <span aria-hidden="true" className="hidden h-5 w-px bg-rule sm:block lg:hidden xl:block" />
        <span className="hidden font-mono text-[12px] uppercase tracking-[0.14em] text-bone-dim sm:block lg:hidden xl:block">
          Demo console
        </span>
        <span className="rounded-[6px] border border-rule px-2 py-[3px] font-mono text-[10.5px] uppercase tracking-[0.14em] text-bone-faint">
          Sandbox
        </span>
      </div>

      <StepRail step={step} />

      <div className="flex flex-1 items-center justify-end gap-5">
        {session !== null && endsAt !== null && (
          <span className="hidden font-mono text-[12px] text-bone-faint sm:block lg:hidden xl:block">
            Session ends {endsAt}
          </span>
        )}
        {session !== null && (
          <TextButton onClick={onEnd} disabled={ending}>
            End session
          </TextButton>
        )}
      </div>
    </header>
  );
}
