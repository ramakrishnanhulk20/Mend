"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { useStill } from "@/components/motion/useStill";
import { Mark } from "@/components/brand/Mark";
import { formatCount, formatUsdCompact } from "@/components/live/summary";
import { INTRO } from "./loom";
import { Loom } from "./LoomCanvas";

const EASE = [0.22, 1, 0.36, 1] as const;

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-bone";

const PRIMARY_BUTTON =
  "inline-flex items-center rounded-[8px] bg-accent font-semibold text-ink transition-[background-color,translate] duration-150 ease-out hover:-translate-y-px hover:bg-accent-hi active:translate-y-0";

const UNDERLINE_DRAW =
  "absolute inset-x-0 -bottom-1 h-px origin-left scale-x-0 bg-bone transition-transform duration-200 ease-out";

const NAV_LINKS = [
  { label: "How it works", href: "/#how-it-works" },
  { label: "Results", href: "/#results" },
  { label: "Docs", href: "/docs" },
];

const CREDITS = [
  "PayPal Payouts",
  "Log in with PayPal",
  "Planned with Claude",
  "BG/NBD forecast",
  "Random holdout",
];

const LETTERS = ["M", "E", "N", "D"];

function fadeRise(still: boolean, delayMs: number, durationMs: number, rise: number) {
  return {
    initial: still ? (false as const) : { opacity: 0, y: rise },
    animate: { opacity: 1, y: 0 },
    transition: { duration: durationMs / 1000, delay: delayMs / 1000, ease: EASE },
  };
}

function fade(still: boolean, delayMs: number, durationMs: number) {
  return {
    initial: still ? (false as const) : { opacity: 0 },
    animate: { opacity: 1 },
    transition: { duration: durationMs / 1000, delay: delayMs / 1000, ease: EASE },
  };
}

function copyDelay(item: number) {
  return INTRO.copy.start + item * INTRO.copy.stagger;
}

export type HeroLive = { quietRegulars: number; paid12mMinor: number };

export function Hero({ live = null }: { live?: HeroLive | null }) {
  const sectionRef = useRef<HTMLElement>(null);
  const still = useStill();

  useEffect(() => {
    const section = sectionRef.current;
    if (!section || still) return;

    let frameId = 0;
    let published = -1;
    const publish = () => {
      frameId = requestAnimationFrame(publish);
      const height = section.offsetHeight || 1;
      const progress = Math.min(1, Math.max(0, window.scrollY / height));
      if (Math.abs(progress - published) > 0.0005) {
        published = progress;
        section.style.setProperty("--hero-progress", progress.toFixed(4));
      }
    };
    publish();

    return () => cancelAnimationFrame(frameId);
  }, [still]);

  return (
    <section
      ref={sectionRef}
      id="top"
      className="relative h-svh min-h-[640px] overflow-hidden bg-ink md:min-h-[720px]"
    >
      <div
        className="absolute inset-0"
        style={{ transform: "translate3d(0, calc(var(--hero-progress, 0) * 10vh), 0)" }}
      >
        <Loom />
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 60% 35%, transparent 40%, rgb(0 0 0 / 0.55) 100%)",
        }}
      />

      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        {...fade(still, INTRO.light.start, INTRO.light.duration)}
      >
        <div
          className="absolute inset-0 xl:hidden"
          style={{
            background:
              "radial-gradient(circle at 55% 28%, rgb(255 77 46 / 0.10), transparent 50%)",
          }}
        />
        <div
          className="absolute inset-0 hidden xl:block"
          style={{
            background:
              "radial-gradient(circle at 68% 34%, rgb(255 77 46 / 0.10), transparent 45%)",
          }}
        />
      </motion.div>

      <p className="sr-only">
        Illustration: ten threads are broken. Five are stitched back in red, for the customers
        sent cashback. Five are bridged with a dotted line, for the customers held back for
        comparison.
      </p>

      <motion.nav
        className="absolute inset-x-0 top-0 flex h-[60px] items-center justify-between px-4 md:h-[72px] md:px-10"
        {...fade(still, 200, 600)}
      >
        <Link href="/#top" className={`group inline-flex items-center gap-[10px] text-bone ${FOCUS_RING}`}>
          <Mark size={22} spinOnHover />
          {/* Inline, because .poster-title sits outside Tailwind's layers and would beat a tracking class. */}
          <span className="poster-title text-[24px]" style={{ letterSpacing: "0.04em" }}>
            Mend
          </span>
        </Link>

        <div className="flex items-center">
          <Link
            href="/docs"
            className={`mr-5 text-[14px] text-bone-dim transition-colors duration-200 ease-out hover:text-bone md:hidden ${FOCUS_RING}`}
          >
            Docs
          </Link>
          <div className="hidden items-center gap-8 md:flex">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`group/link relative text-[15px] text-bone-dim transition-colors duration-200 ease-out hover:text-bone ${FOCUS_RING}`}
              >
                {link.label}
                <span aria-hidden="true" className={`${UNDERLINE_DRAW} group-hover/link:scale-x-100`} />
              </Link>
            ))}
          </div>
          <Link
            href="/demo"
            className={`${PRIMARY_BUTTON} h-[38px] px-[14px] text-[14px] md:ml-6 md:h-10 md:px-4 ${FOCUS_RING}`}
          >
            Run the demo
          </Link>
        </div>
      </motion.nav>

      <div className="absolute inset-x-4 top-[72px] flex flex-wrap gap-x-[14px] gap-y-[6px] md:inset-x-auto md:left-10 md:top-[104px] md:flex-col md:flex-nowrap md:gap-[10px]">
        <motion.div
          className="flex items-center gap-[10px] font-mono text-[10.5px] tracking-[0.02em] text-bone-dim md:text-[12px]"
          {...fadeRise(still, INTRO.legend[0], 500, 8)}
        >
          <svg width="28" height="10" viewBox="0 0 28 10" fill="none" aria-hidden="true" className="shrink-0">
            <path d="M0 5h9M19 5h9" className="stroke-bone-faint" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          A regular who went quiet
        </motion.div>
        <motion.div
          className="flex items-center gap-[10px] font-mono text-[10.5px] tracking-[0.02em] text-bone-dim md:text-[12px]"
          {...fadeRise(still, INTRO.legend[1], 500, 8)}
        >
          <svg width="28" height="10" viewBox="0 0 28 10" fill="none" aria-hidden="true" className="shrink-0">
            <path d="M0 5h9M19 5h9" className="stroke-bone-faint" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M11.5 2.5l5 5M16.5 2.5l-5 5" stroke="#ff4d2e" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Cashback sent through PayPal
        </motion.div>
        <motion.div
          className="flex items-center gap-[10px] font-mono text-[10.5px] tracking-[0.02em] text-bone-dim md:text-[12px]"
          {...fadeRise(still, INTRO.legend[2], 500, 8)}
        >
          <svg width="28" height="10" viewBox="0 0 28 10" fill="none" aria-hidden="true" className="shrink-0">
            <path d="M0 5h9M19 5h9" className="stroke-bone-faint" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="11" cy="5" r="1" className="fill-bone-faint" />
            <circle cx="14" cy="5" r="1" className="fill-bone-faint" />
            <circle cx="17" cy="5" r="1" className="fill-bone-faint" />
          </svg>
          Held back for comparison
        </motion.div>
      </div>

      <div
        className="absolute inset-x-4 bottom-[64px] md:inset-x-10 md:bottom-[76px]"
        style={{
          transform: "translate3d(0, calc(var(--hero-progress, 0) * -8vh), 0)",
          opacity: "calc(1 - var(--hero-progress, 0) * 1.25)",
        }}
      >
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_minmax(0,420px)] xl:items-end xl:gap-x-16">
          <div>
            <motion.p
              className="mb-3 text-[16px] font-normal italic text-bone-dim md:text-[length:clamp(1.05rem,1.4vw,1.375rem)]"
              {...fadeRise(still, copyDelay(0), 600, 24)}
            >
              Every shop has regulars who quietly stop coming back.
            </motion.p>
            <h1
              aria-label="Mend"
              className="poster-title ml-[-0.04em] text-[38vw] text-bone md:text-[18vw] xl:text-[length:min(29vw,28rem)]"
            >
              {LETTERS.map((letter, i) => (
                <span key={letter} className="inline-block overflow-hidden pb-[0.04em]">
                  <motion.span
                    aria-hidden="true"
                    className="inline-block"
                    initial={still ? false : { y: "105%" }}
                    animate={{ y: "0%" }}
                    transition={{
                      duration: INTRO.title.duration / 1000,
                      delay: (INTRO.title.start + i * INTRO.title.stagger) / 1000,
                      ease: EASE,
                    }}
                  >
                    {letter}
                  </motion.span>
                </span>
              ))}
            </h1>
          </div>

          <div className="mt-6 xl:mt-0">
            <motion.p
              className="max-w-[36ch] text-[16px] font-normal leading-[1.55] text-bone-dim md:text-[18px]"
              {...fadeRise(still, copyDelay(1), 600, 24)}
            >
              Mend finds the regulars who are drifting away, has Claude draft a small cashback
              thank-you, pays it through PayPal, and holds a random few back so you can measure
              whether it worked.
            </motion.p>
            <motion.div
              className="mt-6 flex flex-col gap-[10px] md:flex-row md:gap-4"
              {...fadeRise(still, copyDelay(2), 600, 24)}
            >
              <Link
                href="/demo"
                className={`group/primary ${PRIMARY_BUTTON} h-12 gap-2 px-[22px] text-[15px] ${FOCUS_RING}`}
              >
                Run the live demo
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  aria-hidden="true"
                  className="transition-transform duration-150 ease-out group-hover/primary:translate-x-[3px]"
                >
                  <path
                    d="M3 7h8M8 3.5 11.5 7 8 10.5"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Link>
              <Link
                href="/#how-it-works"
                className={`group/secondary inline-flex h-12 items-center text-[15px] text-bone ${FOCUS_RING}`}
              >
                <span className="relative inline-block">
                  How it works
                  <span aria-hidden="true" className="absolute inset-x-0 -bottom-1 h-px bg-bone/35" />
                  <span
                    aria-hidden="true"
                    className={`${UNDERLINE_DRAW} group-hover/secondary:scale-x-100`}
                  />
                </span>
              </Link>
            </motion.div>
          </div>
        </div>
      </div>

      <motion.div
        className="absolute inset-x-0 bottom-0 flex items-center justify-between border-t border-rule px-4 py-3 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-bone/55 md:px-10 md:py-4 md:text-[11.5px]"
        {...fade(still, copyDelay(3), 600)}
      >
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] xl:mr-8 xl:max-w-[60%]">
          <AnimatePresence initial={false}>
            {live === null ? (
              <motion.span
                key="sandbox"
                className="col-start-1 row-start-1 min-w-0 truncate"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: still ? 0 : 0.4, ease: EASE }}
              >
                Now showing in the PayPal sandbox
              </motion.span>
            ) : (
              <motion.span
                key="live"
                className="col-start-1 row-start-1 flex min-w-0 items-center gap-2"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: still ? 0 : 0.4, ease: EASE }}
              >
                <span aria-hidden="true" className="relative block h-[6px] w-[6px] shrink-0">
                  {!still && (
                    <motion.span
                      className="absolute inset-0 rounded-full bg-accent"
                      initial={{ scale: 1, opacity: 0.6 }}
                      animate={{ scale: 2.4, opacity: 0 }}
                      transition={{ duration: 1.8, ease: "easeOut", repeat: Infinity }}
                    />
                  )}
                  <span className="absolute inset-0 rounded-full bg-accent" />
                </span>
                <span className="min-w-0 truncate">
                  Live: {formatCount(live.quietRegulars)} quiet regulars
                  <span className="hidden md:inline">
                    {" "}&middot; {formatUsdCompact(live.paid12mMinor)} spent last year
                  </span>
                </span>
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        {/* shrink-0: when the live line is long, the left text gives way, never the credits. Below 2xl only
            the first three show, so at 1440 the live line keeps its "last year" and is not misread. */}
        <div className="hidden shrink-0 items-center xl:flex">
          {CREDITS.map((credit, i) => (
            <span key={credit} className={`items-center ${i < 3 ? "flex" : "hidden 2xl:flex"}`}>
              {i > 0 && <span aria-hidden="true" className="mx-[14px] h-[10px] w-px bg-bone/25" />}
              {credit}
            </span>
          ))}
          <span className="ml-7 flex items-center gap-[10px]">
            Scroll
            <span aria-hidden="true" className="relative block h-7 w-px overflow-hidden bg-bone/20">
              <motion.span
                className="absolute left-0 top-0 block h-[10px] w-px bg-bone"
                initial={still ? false : { y: -10 }}
                animate={still ? { y: 9 } : { y: [-10, 28] }}
                transition={
                  still
                    ? { duration: 0 }
                    : { duration: 1.6, ease: "easeInOut", repeat: Infinity }
                }
              />
            </span>
          </span>
        </div>
      </motion.div>
    </section>
  );
}
