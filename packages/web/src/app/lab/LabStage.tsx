"use client";

import { useState } from "react";
import { Hero } from "@/components/hero/Hero";
import { HowItWorks } from "@/components/how/HowItWorks";

export function LabStage() {
  const [key, setKey] = useState(0);

  const replay = () => {
    window.scrollTo(0, 0);
    setKey((current) => current + 1);
  };

  return (
    <>
      <Hero key={key} />
      <HowItWorks />

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
