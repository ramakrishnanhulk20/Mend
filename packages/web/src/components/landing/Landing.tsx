"use client";

import { MotionConfig } from "motion/react";
import { Closing } from "@/components/closing/Closing";
import { Footer } from "@/components/closing/Footer";
import { Hero } from "@/components/hero/Hero";
import { HowItWorks } from "@/components/how/HowItWorks";
import { useShopSummary } from "@/components/live/useShopSummary";
import { ProofSection } from "@/components/proof/ProofSection";
import { Guardrails } from "@/components/safety/Guardrails";

export function Landing() {
  const { state, summary, slow, retry } = useShopSummary();

  return (
    // useStill only knows about reduced motion after hydration; MotionConfig drops the movement
    // of animations already running by then, so a reduced-motion visitor never sees things slide.
    <MotionConfig reducedMotion="user">
      <main>
        <Hero
          live={
            summary
              ? {
                  quietRegulars: summary.quietRegulars,
                  paid12mMinor: summary.quietRegularsPaid12mMinor,
                }
              : null
          }
        />
        <HowItWorks />
        <ProofSection
          state={state}
          summary={summary}
          slow={slow}
          retry={retry}
        />
        <Guardrails />
        <Closing />
      </main>
      <Footer />
    </MotionConfig>
  );
}
