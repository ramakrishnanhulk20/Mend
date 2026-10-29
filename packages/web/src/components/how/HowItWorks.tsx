"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useStill } from "@/components/motion/useStill";
import { ForecastDrawing, JoinDrawing, MeasureDrawing, SplitDrawing } from "./illustrations";
import { activePanel, sectionProgress } from "./progress";

const EASE = [0.22, 1, 0.36, 1] as const;

const PANELS = [
  {
    numeral: "01",
    label: "Opt in",
    title: "They say yes.",
    body: "Your regulars join your thank-you list with Log in with PayPal. Mend only pays people who opted in, and anyone can leave with one click.",
    description:
      "Drawing: a thread runs through a Join with PayPal button and is tied off with a red stitch.",
    Drawing: JoinDrawing,
  },
  {
    numeral: "02",
    label: "Forecast",
    title: "Mend sees who is slipping.",
    body: "A BG/NBD forecast, the standard model for repeat buying, reads each regular's order history and estimates the chance they are still coming back. The ones sliding fastest rise to the top.",
    description:
      "Drawing: three threads labelled steady, slipping and gone quiet; the second has small gaps and the third breaks off.",
    Drawing: ForecastDrawing,
  },
  {
    numeral: "03",
    label: "Pay and hold back",
    title: "Some get cashback. Some don't.",
    body: "You approve one exact plan. Mend sends the cashback in a single PayPal Payouts batch with your note, and keeps a random group unpaid as the yardstick.",
    description:
      "Drawing: a row of five breaks stitched in red, labelled paid, and a row of five breaks bridged with dots, labelled held back.",
    Drawing: SplitDrawing,
  },
  {
    numeral: "04",
    label: "Measure",
    title: "You learn if it worked.",
    body: "When customers buy again, Mend compares the paid group with the held-back group and gives you a straight answer, including too early to tell when there are not enough returns yet.",
    description:
      "Drawing: the paid thread and the held-back thread meet at one question with three possible answers: yes, no, too early to tell.",
    Drawing: MeasureDrawing,
  },
];

const MARKERS = [
  { left: "0%", shift: "translate-x-0" },
  { left: "33.333%", shift: "-translate-x-1/2" },
  { left: "66.667%", shift: "-translate-x-1/2" },
  { left: "100%", shift: "-translate-x-full" },
];

function enter(still: boolean, delayMs: number) {
  return {
    initial: still ? (false as const) : { opacity: 0, y: 24 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true, amount: 0.5 },
    transition: { duration: 0.6, delay: delayMs / 1000, ease: EASE },
  };
}

function CrossStitch() {
  return (
    <motion.span
      className="block"
      initial={{ scale: 0 }}
      animate={{ scale: 1 }}
      transition={{ type: "spring", stiffness: 500, damping: 22 }}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="block">
        <path d="M2 2l6 6M8 2l-6 6" stroke="#ff4d2e" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </motion.span>
  );
}

export function HowItWorks() {
  const sectionRef = useRef<HTMLElement>(null);
  const still = useStill();
  const [active, setActive] = useState(0);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section || still) return;

    let frameId = 0;
    let published = -1;
    let shownPanel = 0;

    const publish = () => {
      const progress = sectionProgress(
        section.getBoundingClientRect().top,
        section.offsetHeight,
        window.innerHeight,
      );
      if (Math.abs(progress - published) > 0.0005) {
        published = progress;
        section.style.setProperty("--how-progress", progress.toFixed(4));
      }
      const panel = activePanel(progress);
      if (panel !== shownPanel) {
        shownPanel = panel;
        setActive(panel);
      }
    };

    const tick = () => {
      publish();
      frameId = requestAnimationFrame(tick);
    };

    // The loop only runs while the section is on screen. One last read on the way out
    // leaves the track at its true end position.
    const observer = new IntersectionObserver((entries) => {
      const onScreen = entries[entries.length - 1].isIntersecting;
      cancelAnimationFrame(frameId);
      frameId = 0;
      if (onScreen) frameId = requestAnimationFrame(tick);
      else publish();
    });
    observer.observe(section);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameId);
    };
  }, [still]);

  return (
    <section
      ref={sectionRef}
      id="how-it-works"
      className="relative bg-ink px-4 py-24 md:px-10 lg:motion-safe:h-[400svh] lg:motion-safe:p-0"
    >
      <div className="lg:motion-safe:sticky lg:motion-safe:top-0 lg:motion-safe:h-svh lg:motion-safe:overflow-hidden">
        <div className="mb-16 flex justify-between lg:motion-safe:absolute lg:motion-safe:inset-x-10 lg:motion-safe:top-10 lg:motion-safe:mb-0">
          <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-bone-faint">
            How it works
          </span>
          <span
            aria-hidden="true"
            className="hidden font-mono text-[12px] tracking-[0.14em] text-bone-dim lg:motion-safe:block"
          >
            0
            <span className="inline-block overflow-hidden align-bottom">
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={active}
                  className="inline-block"
                  initial={{ y: 12, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: -12, opacity: 0 }}
                  transition={{ duration: 0.25, ease: EASE }}
                >
                  {active + 1}
                </motion.span>
              </AnimatePresence>
            </span>
            {" / 04"}
          </span>
        </div>

        <div className="flex flex-col gap-28 lg:motion-safe:h-full lg:motion-safe:w-[400vw] lg:motion-safe:flex-row lg:motion-safe:gap-0 lg:motion-safe:[transform:translate3d(calc(var(--how-progress,0)_*_-300vw),0,0)]">
          {PANELS.map((panel, i) => (
            <div
              key={panel.numeral}
              style={{ "--i": i } as CSSProperties}
              className="relative lg:motion-safe:h-full lg:motion-safe:w-[100vw] lg:motion-safe:shrink-0"
            >
              <p
                aria-hidden="true"
                className="poster-title mb-4 text-[34vw] text-transparent [-webkit-text-stroke:1px_rgb(237_230_218/0.18)] md:text-[24vw] lg:motion-safe:absolute lg:motion-safe:left-10 lg:motion-safe:top-[12%] lg:motion-safe:mb-0 lg:motion-safe:text-[length:min(26vw,30rem)] lg:motion-safe:[transform:translate3d(calc((var(--how-progress,0)_*_3_-_var(--i))_*_-8vw),0,0)]"
              >
                {panel.numeral}
              </p>

              <div className="max-w-[40ch] lg:motion-safe:absolute lg:motion-safe:right-10 lg:motion-safe:top-[16%] lg:motion-safe:w-[min(520px,38vw)] lg:motion-safe:max-w-none">
                {/* Inline line height, because .poster-title sits outside Tailwind's layers and would beat a leading class. */}
                <motion.h2
                  className="poster-title text-[40px] text-bone md:text-[length:clamp(3rem,5vw,5rem)]"
                  style={{ lineHeight: 0.9 }}
                  {...enter(still, 0)}
                >
                  {panel.title}
                </motion.h2>
                <motion.p
                  className="mt-5 text-[16px] leading-[1.55] text-bone-dim md:text-[18px]"
                  {...enter(still, 90)}
                >
                  {panel.body}
                </motion.p>
              </div>

              <div className="mt-10 w-full max-w-[640px] lg:motion-safe:absolute lg:motion-safe:bottom-[18%] lg:motion-safe:left-10 lg:motion-safe:mt-0 lg:motion-safe:w-[min(640px,46vw)]">
                <p className="sr-only">{panel.description}</p>
                <panel.Drawing still={still} />
              </div>
            </div>
          ))}
        </div>

        <div
          aria-hidden="true"
          className="absolute inset-x-10 bottom-10 hidden h-px bg-bone/15 lg:motion-safe:block"
        >
          <div
            className="absolute inset-0 origin-left bg-bone/60"
            style={{ transform: "scaleX(var(--how-progress, 0))" }}
          />
          {PANELS.map((panel, i) => {
            const marker = MARKERS[i];
            const reached = i <= active;
            return (
              <div key={panel.label} className="absolute top-0" style={{ left: marker.left }}>
                <div
                  className={`absolute -top-[4.5px] flex h-[10px] w-[10px] items-center justify-center ${marker.shift}`}
                >
                  {reached ? (
                    <CrossStitch />
                  ) : (
                    <span className="block h-[9px] w-[9px] rounded-full border border-bone/30 bg-ink" />
                  )}
                </div>
                <span
                  className={`absolute top-[14px] whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.14em] transition-colors duration-200 ${marker.shift} ${
                    i === active ? "text-bone" : "text-bone-faint"
                  }`}
                >
                  {panel.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
