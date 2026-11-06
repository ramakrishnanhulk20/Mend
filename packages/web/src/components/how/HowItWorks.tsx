"use client";

import type { CSSProperties } from "react";
import { motion } from "motion/react";
import { useStill } from "@/components/motion/useStill";

const EASE = [0.22, 1, 0.36, 1] as const;

const PANELS = [
  {
    numeral: "01",
    label: "Opt in",
    title: "They say yes.",
    body: "Your regulars join your thank-you list with Log in with PayPal. Mend only pays people who opted in, and anyone can leave with one click.",
    image: "/world/how-1.jpg",
    alt: "A clay customer stands at a blue sign, with a red yarn threaded through it and tied in a bow.",
    tags: ["Join with PayPal"],
    tint: "bg-pale-butter",
  },
  {
    numeral: "02",
    label: "Forecast",
    title: "Mend sees who is slipping.",
    body: "A BG/NBD forecast, the standard model for repeat buying, reads each regular's order history and estimates how many orders they will place in the next 13 weeks. Mend leaves the steady and the long gone alone, and nudges the ones still slipping, biggest spenders first.",
    image: "/world/how-2.jpg",
    alt: "Three yarn roads run to three clay houses: one taut, one fraying, one broken.",
    tags: ["steady", "slipping", "long gone"],
    tint: "bg-pale-sky",
  },
  {
    numeral: "03",
    label: "Pay and hold back",
    title: "Some get cashback. Some don't.",
    body: "You approve one exact plan. Mend sends the cashback in a single PayPal Payouts batch with your note, and keeps a random group unpaid as the yardstick.",
    image: "/world/how-3.jpg",
    alt: "Five clay customers stand behind gold coins, and five more stand behind a dotted line, held back.",
    tags: ["paid", "held back"],
    tint: "bg-pale-peach",
  },
  {
    numeral: "04",
    label: "Measure",
    title: "You learn if it worked.",
    body: "When customers buy again, Mend compares the paid group with the held-back group and gives you a straight answer, including too early to tell when there are not enough returns yet.",
    image: "/world/how-4.jpg",
    alt: "A clay balance weighs a paid group against a held-back group, beside a coiled tape measure.",
    tags: ["yes", "no", "too early to tell"],
    tint: "bg-pale-teal",
  },
];

function enter(still: boolean, delayMs: number) {
  return {
    initial: still ? (false as const) : { opacity: 0, y: 24 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true, amount: 0.5 },
    transition: { duration: 0.6, delay: delayMs / 1000, ease: EASE },
  };
}

export function HowItWorks() {
  const still = useStill();

  return (
    <section id="how-it-works" className="bg-paper">
      <h2 className="sr-only">How it works</h2>
      <div className="mx-auto max-w-[1440px] px-4 py-16 md:px-12 md:py-24">
        <span className="label-tag" aria-hidden="true">
          How it works
        </span>

        <div className="mt-10 flex flex-col gap-7 lg:motion-safe:gap-0">
          {PANELS.map((panel, i) => (
            <div
              key={panel.numeral}
              style={{ "--stack-top": `${96 + i * 14}px` } as CSSProperties}
              className={`patch patch-tinted ${panel.tint} grid items-center gap-7 px-[26px] py-[30px] lg:min-h-[min(620px,calc(100svh-150px))] lg:grid-cols-[1fr_1.15fr] lg:gap-14 lg:p-14 lg:motion-safe:sticky lg:motion-safe:top-[var(--stack-top)] lg:motion-safe:mb-10`}
            >
              <div className="min-w-0">
                <motion.p
                  className="font-mono text-[13px] uppercase tracking-[0.08em] text-ink-dim"
                  {...enter(still, 0)}
                >
                  {panel.numeral} &middot; {panel.label}
                </motion.p>
                <motion.h3
                  className="poster-title mt-[14px] text-[length:clamp(2.25rem,3.8vw,3.75rem)] text-ink"
                  {...enter(still, 60)}
                >
                  {panel.title}
                </motion.h3>
                <motion.p
                  className="mt-4 max-w-[34em] text-[17px] leading-[1.5] text-ink-dim lg:text-[19px]"
                  {...enter(still, 140)}
                >
                  {panel.body}
                </motion.p>
              </div>

              <div className="order-first min-w-0 lg:order-none">
                <div className="group/frame aspect-[4/3] overflow-hidden rounded-[20px] [outline-offset:4px] [outline:2px_dashed_rgb(18_59_63/0.22)] lg:max-h-[calc(100svh-320px)] lg:w-full">
                  {/* eslint-disable-next-line @next/next/no-img-element -- fixed stills that become films later */}
                  <img
                    src={panel.image}
                    alt={panel.alt}
                    loading="lazy"
                    decoding="async"
                    className="block h-full w-full object-cover transition-transform duration-500 ease-out motion-reduce:transition-none motion-safe:group-hover/frame:scale-[1.03]"
                  />
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  {panel.tags.map((tag) => (
                    <span key={tag} className="label-tag">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
