"use client";

import { useState } from "react";
import { Closing } from "@/components/closing/Closing";
import { Footer } from "@/components/closing/Footer";
import { Hero } from "@/components/hero/Hero";
import { HowItWorks } from "@/components/how/HowItWorks";
import { useShopSummary } from "@/components/live/useShopSummary";
import { ProofSection } from "@/components/proof/ProofSection";
import { Guardrails } from "@/components/safety/Guardrails";

export function LabStage() {
  const [key, setKey] = useState(0);
  const { state, summary, slow, retry } = useShopSummary();

  const replay = () => {
    window.scrollTo(0, 0);
    setKey((current) => current + 1);
  };

  return (
    <>
      <Hero
        key={key}
        live={summary ? { quietRegulars: summary.quietRegulars, paid12mMinor: summary.quietRegularsPaid12mMinor } : null}
      />
      <HowItWorks />
      <ProofSection state={state} summary={summary} slow={slow} retry={retry} />
      <Guardrails />
      <Closing />
      <Footer />

      <section className="h-[120vh] border-t border-rule px-4 pt-24 md:px-10">
        {/* The lab control lives below the hero so it never sits on top of what is being judged. */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-bone-faint">
            Lab preview. The next section goes here.
          </span>
          <button
            type="button"
            onClick={replay}
            className="rounded-[6px] border border-rule px-[10px] py-[6px] font-mono text-[11px] uppercase tracking-[0.14em] text-bone-dim transition-colors duration-150 hover:border-bone-faint hover:text-bone"
          >
            Replay intro
          </button>
        </div>
      </section>
    </>
  );
}
