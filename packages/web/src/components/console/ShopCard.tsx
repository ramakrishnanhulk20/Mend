"use client";

import { useState } from "react";
import { formatCount } from "@/components/live/summary";
import { useShopSummary } from "@/components/live/useShopSummary";
import { FOCUS_RING, TextButton } from "./StepRail";

const ROW = "flex items-center justify-between border-b border-rule py-3 last:border-0";
const LABEL = "text-[14px] text-bone-dim";
const VALUE = "text-[15px] font-semibold tabular-nums text-bone";

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function Bar({ width }: { width: string }) {
  return <span aria-hidden="true" className={`block h-[14px] rounded-[3px] bg-bone/10 ${width}`} />;
}

/**
 * The shop's numbers, from the same public summary the landing page reads. Below lg it folds
 * to one line that opens on tap; from lg up it is always open in the side column.
 */
export function ShopCard() {
  const { state, summary, retry } = useShopSummary();
  const [open, setOpen] = useState(false);
  const ready = state === "ready" && summary !== null;

  return (
    <div className="rounded-[8px] border border-rule bg-ink-raised">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`flex min-h-12 w-full items-center justify-between gap-4 px-4 py-3 text-left text-[14px] text-bone-dim transition-colors duration-200 ease-out hover:text-bone lg:hidden ${FOCUS_RING}`}
      >
        {ready ? (
          <span>
            {formatCount(summary.shopCustomers)} customers &middot; {formatCount(summary.quietRegulars)} quiet regulars
          </span>
        ) : state === "unavailable" ? (
          <span>Live numbers unavailable.</span>
        ) : (
          <Bar width="w-48" />
        )}
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
          className={`shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none lg:grid-rows-[1fr] ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className={`px-4 pb-4 lg:p-6 ${open ? "" : "invisible"} lg:visible`}>
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-bone-faint">The demo shop</p>

            {state === "unavailable" ? (
              <div className="mt-4 flex items-center justify-between gap-4">
                <p className="text-[14px] text-bone-dim">Live numbers unavailable.</p>
                <TextButton onClick={retry}>Try again</TextButton>
              </div>
            ) : (
              <dl className="mt-3" aria-busy={!ready}>
                <div className={ROW}>
                  <dt className={LABEL}>Customers</dt>
                  <dd className={VALUE}>{ready ? formatCount(summary.shopCustomers) : <Bar width="w-12" />}</dd>
                </div>
                <div className={ROW}>
                  <dt className={LABEL}>Quiet regulars</dt>
                  <dd className={VALUE}>{ready ? formatCount(summary.quietRegulars) : <Bar width="w-12" />}</dd>
                </div>
                <div className={ROW}>
                  <dt className={LABEL}>Joined the thank-you list</dt>
                  <dd className={VALUE}>{ready ? formatCount(summary.membersJoined) : <Bar width="w-8" />}</dd>
                </div>
                <div className={ROW}>
                  <dt className={LABEL}>
                    {ready ? capitalised(summary.membersSeededLabel) : <Bar width="w-28" />}
                  </dt>
                  <dd className={VALUE}>{ready ? formatCount(summary.membersSeeded) : <Bar width="w-8" />}</dd>
                </div>
              </dl>
            )}

            <p className="mt-4 text-[12px] leading-[1.5] text-bone-faint">
              Demo stand-ins were joined by a script so the demo has people to pay. They never signed up, and
              they are always labelled.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
