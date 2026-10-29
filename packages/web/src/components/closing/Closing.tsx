"use client";

import { Fragment, useId, useRef } from "react";
import Link from "next/link";
import { motion, useInView } from "motion/react";
import { useStill } from "@/components/motion/useStill";

const EASE = [0.22, 1, 0.36, 1] as const;

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-bone";

const PRIMARY_BUTTON =
  "inline-flex items-center rounded-[8px] bg-accent font-semibold text-ink transition-[background-color,translate] duration-150 ease-out hover:-translate-y-px hover:bg-accent-hi active:translate-y-0";

const UNDERLINE_DRAW =
  "absolute inset-x-0 -bottom-1 h-px origin-left scale-x-0 bg-bone transition-transform duration-200 ease-out";

const TITLE = "Try it on the demo shop.";
const WORDS = TITLE.split(" ");

// Eighteen threads from eight to ninety-two percent of the height. The eleventh is the broken one.
const THREAD_COUNT = 18;
const THREAD_TOP = 8;
const THREAD_BOTTOM = 92;
const BROKEN_THREAD = 10;
const BREAK_CENTRE = 64;
const BREAK_HALF_WIDTH = 1.4;

function threadY(index: number) {
  return THREAD_TOP + (index * (THREAD_BOTTOM - THREAD_TOP)) / (THREAD_COUNT - 1);
}

function rise(still: boolean, delayMs: number) {
  return {
    initial: still ? (false as const) : { opacity: 0, y: 32 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true, amount: 0.3 },
    transition: { duration: 0.8, delay: delayMs / 1000, ease: EASE },
  };
}

export function Closing() {
  const still = useStill();
  const titleId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const sectionInView = useInView(sectionRef, { once: true, amount: 0.3 });
  // The words sit inside clipping boxes, so the heading is watched instead of the words.
  const titleInView = useInView(titleRef, { once: true, amount: 0.3 });
  const stitched = still || sectionInView;
  const titleShown = still || titleInView;
  const brokenY = threadY(BROKEN_THREAD);

  return (
    <section
      ref={sectionRef}
      id="demo"
      aria-labelledby={titleId}
      className="relative flex min-h-svh flex-col justify-center overflow-hidden border-t border-rule bg-ink px-4 py-28 md:px-10"
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        fill="none"
      >
        {Array.from({ length: THREAD_COUNT }, (_, i) => {
          const y = threadY(i);
          if (i !== BROKEN_THREAD) {
            return (
              <line
                key={i}
                x1="0"
                x2="100"
                y1={y}
                y2={y}
                className="stroke-bone/8"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            );
          }
          return (
            <Fragment key={i}>
              <line
                x1="0"
                x2={BREAK_CENTRE - BREAK_HALF_WIDTH}
                y1={y}
                y2={y}
                className="stroke-bone/25"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
              <line
                x1={BREAK_CENTRE + BREAK_HALF_WIDTH}
                x2="100"
                y1={y}
                y2={y}
                className="stroke-bone/25"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            </Fragment>
          );
        })}
      </svg>

      {/* The stitch is a separate box, because the thread field is stretched and would squash it. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute h-[clamp(12px,1.5vw,22px)] w-[clamp(12px,1.5vw,22px)] -translate-x-1/2 -translate-y-1/2"
        style={{ left: `${BREAK_CENTRE}%`, top: `${brokenY}%` }}
      >
        <motion.svg
          width="100%"
          height="100%"
          viewBox="-6 -6 12 12"
          fill="none"
          className="block overflow-visible"
          initial={still ? false : { scale: 0 }}
          animate={{ scale: stitched ? 1 : 0 }}
          transition={{ type: "spring", stiffness: 500, damping: 22, delay: 0.6 }}
        >
          <path
            d="M-6 -6L6 6M-6 6L6 -6"
            stroke="#ff4d2e"
            strokeWidth="2.5"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </motion.svg>
      </div>

      <div className="relative max-w-[1100px] text-left">
        <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-bone-faint">
          Now showing
        </p>
        {/* Inline line height, because .poster-title sits outside Tailwind's layers and would beat a leading class. */}
        <h2
          ref={titleRef}
          id={titleId}
          aria-label={TITLE}
          className="poster-title mt-4 text-[52px] text-bone md:text-[length:clamp(4rem,10vw,10rem)]"
          style={{ lineHeight: 0.85 }}
        >
          {WORDS.map((word, i) => (
            <Fragment key={word}>
              {i > 0 && " "}
              <span className="inline-block overflow-hidden pb-[0.04em]">
                <motion.span
                  aria-hidden="true"
                  className="inline-block"
                  initial={still ? false : { y: "105%" }}
                  animate={{ y: titleShown ? "0%" : "105%" }}
                  transition={{ duration: 0.9, delay: (i * 60) / 1000, ease: EASE }}
                >
                  {word}
                </motion.span>
              </span>
            </Fragment>
          ))}
        </h2>

        <motion.p
          className="mt-8 max-w-[52ch] text-[16px] leading-[1.55] text-bone-dim md:text-[18px]"
          {...rise(still, 120)}
        >
          No sign-up. A sandbox shop with two years of real order history, real PayPal sandbox
          payouts and Claude. Plan a campaign, approve it, and watch the money land.
        </motion.p>

        <motion.div
          className="mt-10 flex flex-col gap-[10px] md:flex-row md:gap-4"
          {...rise(still, 240)}
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
            href="/docs"
            className={`group/secondary inline-flex h-12 items-center text-[15px] text-bone ${FOCUS_RING}`}
          >
            <span className="relative inline-block">
              Read the docs
              <span aria-hidden="true" className="absolute inset-x-0 -bottom-1 h-px bg-bone/35" />
              <span
                aria-hidden="true"
                className={`${UNDERLINE_DRAW} group-hover/secondary:scale-x-100`}
              />
            </span>
          </Link>
        </motion.div>

        <motion.p
          className="mt-24 border-t border-rule pt-6 text-left font-mono text-[10.5px] uppercase leading-[2] tracking-[0.18em] text-bone-faint md:mt-32 md:text-justify md:text-[11px]"
          {...rise(still, 360)}
        >
          Mend. A win-back engine for shops. Built on PayPal Payouts, Log in with PayPal and
          PayPal&apos;s MCP server. Forecast by a BG/NBD model. Planned and written with Claude. Every
          payout is held to caps set in code and measured against a random holdout. Sandbox only.
        </motion.p>
      </div>
    </section>
  );
}
