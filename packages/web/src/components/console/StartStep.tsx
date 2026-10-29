"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { useStill } from "@/components/motion/useStill";
import { ApiError, type ConsoleApi } from "./api";
import { EASE, FOCUS_RING, PRIMARY_BUTTON, Spinner } from "./ui";

const HAPPENS = [
  { title: "See who went quiet", line: "Mend's forecast ranks the shop's regulars." },
  {
    title: "Ask Claude for a plan",
    line: "Say what you want in a sentence. Claude sets the budget and reward within the demo's caps.",
  },
  { title: "Approve the exact plan", line: "Read every reward and note, then approve that plan by its fingerprint." },
  { title: "Watch PayPal pay it", line: "One PayPal Payouts batch. Each customer's thread is stitched as PayPal confirms." },
  {
    title: "See if it worked",
    line: "Simulate a customer coming back and compare the paid group with the held-back group.",
  },
] as const;

function openingFailure(error: unknown): string {
  if (error instanceof ApiError && error.status === 429 && error.code === "rate_limited") {
    if (error.retryAfterSeconds === null) {
      return "This network has opened the most demo sessions allowed for now. Try again later.";
    }
    const minutes = Math.max(1, Math.ceil(error.retryAfterSeconds / 60));
    return `This network has opened the most demo sessions allowed for now. Try again in ${minutes} min.`;
  }
  return "The demo session didn't open. Try again.";
}

type StartStepProps = {
  api: ConsoleApi;
  notice: string | null;
  onStarted: (expiresAt: string) => void;
};

export function StartStep({ api, notice, onStarted }: StartStepProps) {
  const still = useStill();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setFailure(null);
    try {
      const session = await api.startDemo();
      onStarted(session.expiresAt);
    } catch (error) {
      setFailure(openingFailure(error));
      setPending(false);
    }
  }

  const message = failure ?? notice;

  return (
    <section aria-labelledby="start-title">
      <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-bone-faint">The demo shop</p>
      <h1
        id="start-title"
        className="poster-title mt-4 text-[44px] text-bone md:text-[64px]"
        style={{ lineHeight: 0.9 }}
      >
        Run a real campaign.
      </h1>
      <p className="mt-6 max-w-[56ch] text-[16px] leading-[1.55] text-bone-dim md:text-[18px]">
        This shop replays two years of a real store&apos;s orders. You ask Claude for a win-back plan, approve
        the exact plan, and PayPal&apos;s sandbox pays it out. Rewards are small and capped, and some customers
        are held back on purpose so you can see whether the money worked.
      </p>
      <p className="mt-4 text-[14px] text-bone-faint">
        No sign-up and no PayPal login. Sandbox only: no real money moves.
      </p>

      <button
        type="button"
        onClick={start}
        disabled={pending}
        aria-busy={pending}
        className={`group/primary ${PRIMARY_BUTTON} mt-8 h-12 gap-2 px-[22px] text-[15px] disabled:translate-y-0 disabled:cursor-default disabled:hover:translate-y-0 disabled:hover:bg-accent ${FOCUS_RING}`}
      >
        {pending ? (
          <>
            Opening a demo session
            <Spinner />
          </>
        ) : (
          <>
            Start the demo
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
          </>
        )}
      </button>

      {message !== null && (
        <p
          role={failure === null ? "status" : "alert"}
          className="mt-5 flex max-w-[56ch] items-start gap-3 text-[14px] leading-[1.5] text-bone-dim"
        >
          <span aria-hidden="true" className="mt-[7px] block h-[6px] w-[6px] shrink-0 rounded-full bg-accent" />
          {message}
        </p>
      )}

      <h2 className="mt-14 font-mono text-[12px] uppercase tracking-[0.14em] text-bone-faint">What happens</h2>
      <ol role="list" className="mt-5 flex max-w-[56ch] flex-col gap-[18px]">
        {HAPPENS.map((item, i) => (
          <motion.li
            key={item.title}
            className="relative grid grid-cols-[36px_minmax(0,1fr)]"
            initial={still ? false : { opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, ease: EASE, delay: i * 0.06 }}
          >
            <span className="font-mono text-[12px] leading-6 text-bone-faint">0{i + 1}</span>
            {i < HAPPENS.length - 1 && (
              <span aria-hidden="true" className="absolute left-[7px] top-[28px] -bottom-[14px] w-px bg-bone/15" />
            )}
            <div>
              <p className="text-[16px] leading-6 text-bone">{item.title}</p>
              <p className="mt-[2px] text-[14px] leading-[1.5] text-bone-dim">{item.line}</p>
            </div>
          </motion.li>
        ))}
      </ol>
    </section>
  );
}
