"use client";

import { Fragment, useId, useRef } from "react";
import Link from "next/link";
import { motion, useInView } from "motion/react";
import { useStill } from "@/components/motion/useStill";

const EASE = [0.22, 1, 0.36, 1] as const;

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ink";

// The felt button from globals.css: the same one as the hero, with its height and padding set here.
const PRIMARY_BUTTON = "btn-felt";

const SECONDARY_BUTTON =
  "inline-flex h-[54px] items-center justify-center whitespace-nowrap rounded-[12px] border-2 border-ink px-6 text-[17px] font-semibold leading-none text-ink transition-colors duration-[160ms] ease-out hover:bg-ink hover:text-paper motion-reduce:transition-none";

const TITLE = "Try it on the demo shop.";
const WORDS = TITLE.split(" ");

function rise(still: boolean, shown: boolean, delayMs: number) {
  return {
    initial: still ? (false as const) : { opacity: 0, y: 32 },
    animate: still || shown ? { opacity: 1, y: 0 } : { opacity: 0, y: 32 },
    transition: { duration: 0.8, delay: delayMs / 1000, ease: EASE },
  };
}

export function Closing() {
  const still = useStill();
  const titleId = useId();
  const patchRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // The film is tall, so the patch is watched on its own: the entrance plays when its text is on screen.
  const patchInView = useInView(patchRef, { once: true, amount: 0.3 });
  // The words sit inside clipping boxes, so the heading is watched instead of the words.
  const titleInView = useInView(titleRef, { once: true, amount: 0.3 });
  const titleShown = still || titleInView;

  return (
    <section
      id="demo"
      aria-labelledby={titleId}
      className="relative bg-paper pb-16 min-[860px]:pb-24"
    >
      <div className="relative aspect-[4/5] w-full overflow-hidden min-[860px]:aspect-[2/1]">
        <picture className="block h-full w-full">
          <source media="(max-width: 859px)" srcSet="/world/film/end-phone.jpg" />
          <img
            src="/world/film/end.jpg"
            alt="The clay town at the end of the story: the road is mended and the customer's window is lit."
            loading="lazy"
            decoding="async"
            className="block h-full w-full object-cover"
          />
        </picture>
      </div>

      <div
        ref={patchRef}
        className="patch relative z-10 mx-auto mt-[calc(-1*clamp(120px,12vw,190px))] w-[calc(100%_-_32px)] max-w-[1344px] px-[26px] py-10 text-left min-[860px]:w-[calc(100%_-_96px)] min-[860px]:px-[68px] min-[860px]:py-[60px]"
      >
        <span className="label-tag">Now showing</span>
        <h2
          ref={titleRef}
          id={titleId}
          aria-label={TITLE}
          className="poster-title mt-4 text-[42px] text-ink md:text-[length:clamp(3rem,6.6vw,6.5rem)]"
        >
          {WORDS.map((word, i) => (
            <Fragment key={word}>
              {i > 0 && " "}
              <span className="inline-block overflow-hidden pb-[0.14em] -mb-[0.1em]">
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
          className="mt-8 max-w-[36em] text-[17px] leading-[1.5] text-ink-dim min-[860px]:text-[20px]"
          {...rise(still, patchInView, 120)}
        >
          No sign-up. A sandbox shop with two years of real order history, real PayPal sandbox
          payouts and Claude. Plan a campaign, approve it, and watch the money land.
        </motion.p>

        <motion.div
          className="mt-10 flex flex-col gap-[10px] md:flex-row md:gap-4"
          {...rise(still, patchInView, 240)}
        >
          <Link href="/demo" className={`${PRIMARY_BUTTON} group/primary h-[54px] whitespace-nowrap px-6 text-[17px] leading-none ${FOCUS_RING}`}>
            Run the live demo
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              aria-hidden="true"
              className="transition-transform duration-150 ease-out motion-safe:group-hover/primary:translate-x-[3px]"
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
          <Link href="/docs" className={`${SECONDARY_BUTTON} ${FOCUS_RING}`}>
            Read the docs
          </Link>
        </motion.div>

        <motion.p
          className="mt-8 border-t border-rule pt-6 text-left font-mono text-[12px] uppercase leading-[2] tracking-[0.18em] text-ink-dim"
          {...rise(still, patchInView, 360)}
        >
          Mend. A win-back engine for shops. Built on PayPal Payouts, Log in with PayPal and
          PayPal&apos;s MCP server. Forecast by a BG/NBD model. Planned and written with Claude. Every
          payout is held to caps set in code and measured against a random holdout. Sandbox only.
        </motion.p>
      </div>
    </section>
  );
}
