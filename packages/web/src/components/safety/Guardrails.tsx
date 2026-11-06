"use client";

import { useEffect, useId, useRef, useState } from "react";
import { motion, useInView } from "motion/react";
import { useStill } from "@/components/motion/useStill";
import { FOCUS_RING } from "@/components/console/ui";

const EASE = [0.22, 1, 0.36, 1] as const;

const STITCH_RED = "#D72A16";

const CLAUDE_CAN = [
  "Read the shop's order history and see who went quiet",
  "Look up PayPal orders, disputes and products, with keys PayPal refuses for payouts",
  "Draft a campaign and write each customer's note",
  "Answer your questions from live numbers",
];

const ONLY_YOU_CAN = [
  "Approve one exact plan, checked by its fingerprint before anything is sent",
  "Send the cashback as one PayPal Payouts batch",
  "Cancel rewards nobody claimed and get the money back",
  "Keep a random group unpaid, so the results stay honest",
];

const RULES = [
  {
    label: "In code, not in the prompt",
    text: "Every reward has a cap per customer, per campaign and per day, set by Mend's engine, never by the AI.",
    tint: "bg-pale-teal",
  },
  {
    label: "Checked before it goes",
    text: "Every note is checked before PayPal delivers it: no links, no contact details, no claims that PayPal is paying.",
    tint: "bg-pale-peach",
  },
  {
    label: "Sandbox only",
    text: "Mend runs on PayPal's sandbox. No real money moves, and the engine refuses to start against live PayPal.",
    tint: "bg-pale-sage",
  },
];

// Seam geometry in pixels: a stitch every pitch, the first one at start, each reaching reach either side of its centre.
const STITCH_START = 22;
const STITCH_PITCH = 44;
const STITCH_REACH = 6;
const SEAM_THICKNESS = 56;
const SEAM_THICKNESS_FLAT = 32;

function rise(still: boolean, delayMs: number) {
  return {
    initial: still ? (false as const) : { opacity: 0, y: 24 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true, amount: 0.4 },
    transition: { duration: 0.6, delay: delayMs / 1000, ease: EASE },
  };
}

function slideIn(still: boolean, delayMs: number, fromX: number) {
  return {
    initial: still ? (false as const) : { opacity: 0, x: fromX },
    whileInView: { opacity: 1, x: 0 },
    viewport: { once: true, amount: 0.5 },
    transition: { duration: 0.5, delay: delayMs / 1000, ease: EASE },
  };
}

function fadeIn(still: boolean, delayMs: number) {
  return {
    initial: still ? (false as const) : { opacity: 0 },
    whileInView: { opacity: 1 },
    viewport: { once: true },
    transition: { duration: 0.5, delay: delayMs / 1000, ease: EASE },
  };
}

function Glyph({ broken }: { broken: boolean }) {
  return (
    <svg
      width="28"
      height="10"
      viewBox="0 0 28 10"
      fill="none"
      aria-hidden="true"
      className="mt-[7px] shrink-0"
    >
      {broken ? (
        <>
          <path d="M0 5h9M19 5h9" className="stroke-ink-faint" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M11.5 2.5l5 5M16.5 2.5l-5 5" stroke={STITCH_RED} strokeWidth="1.5" strokeLinecap="round" />
        </>
      ) : (
        <path d="M0 5h28" className="stroke-ink-faint" strokeWidth="1.5" strokeLinecap="round" />
      )}
    </svg>
  );
}

function Capabilities({
  heading,
  items,
  broken,
  fromX,
  tint,
  still,
}: {
  heading: string;
  items: string[];
  broken: boolean;
  fromX: number;
  tint: string;
  still: boolean;
}) {
  return (
    <div className={`patch patch-tinted ${tint} px-[26px] py-[30px] md:p-10`}>
      <h3 className="poster-title text-[32px] text-ink">{heading}</h3>
      <ul role="list" className="mt-6 flex flex-col gap-[14px]">
        {items.map((item, i) => (
          <motion.li
            key={item}
            className="flex gap-[14px] text-[17px] leading-[1.5] text-ink"
            {...slideIn(still, i * 80, fromX)}
          >
            <Glyph broken={broken} />
            <span>{item}</span>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}

// The thread between the two pieces. Its length is read from the page, so the line and the
// stitch count follow the real height (or width) of the pieces at every screen size.
function Seam({ vertical, show, still }: { vertical: boolean; show: boolean; still: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [length, setLength] = useState(0);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[entries.length - 1].contentRect;
      setLength(Math.round(vertical ? height : width));
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [vertical]);

  const centre = (vertical ? SEAM_THICKNESS : SEAM_THICKNESS_FLAT) / 2;
  const stitches: number[] = [];
  for (let at = STITCH_START; at <= length - STITCH_REACH; at += STITCH_PITCH) stitches.push(at);

  return (
    <div
      ref={boxRef}
      aria-hidden="true"
      className={
        vertical
          ? "relative hidden w-[56px] md:block"
          : "relative my-2 h-8 w-full md:hidden"
      }
    >
      <svg className="absolute inset-0 h-full w-full overflow-visible" fill="none">
        <motion.path
          d={vertical ? `M${centre} 0V${length}` : `M0 ${centre}H${length}`}
          className="stroke-ink/20"
          strokeWidth="1"
          initial={still ? false : { pathLength: 0 }}
          animate={{ pathLength: show ? 1 : 0 }}
          transition={{ duration: 0.9, ease: EASE }}
        />
        {stitches.map((at, i) => (
          <g key={at} transform={vertical ? `translate(${centre} ${at})` : `translate(${at} ${centre})`}>
            <motion.g
              initial={still ? false : { scale: 0 }}
              animate={{ scale: show ? 1 : 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 22, delay: 0.3 + i * 0.07 }}
            >
              <path d="M-6 -6L6 6M-6 6L6 -6" stroke={STITCH_RED} strokeWidth="2" strokeLinecap="round" />
            </motion.g>
          </g>
        ))}
      </svg>
    </div>
  );
}

export function Guardrails() {
  const still = useStill();
  const titleId = useId();
  const splitRef = useRef<HTMLDivElement>(null);
  const splitInView = useInView(splitRef, { once: true, amount: 0.3 });
  const drawn = still || splitInView;

  return (
    <section id="safety" aria-labelledby={titleId} className="border-t border-rule bg-paper">
      <div className="mx-auto max-w-[1440px] px-4 py-24 md:px-12">
        <motion.p className="label-tag" {...rise(still, 0)}>
          The guardrails
        </motion.p>
        <motion.h2
          id={titleId}
          className="poster-title mt-6 text-[36px] text-ink md:text-[length:clamp(2.75rem,5.4vw,5.5rem)]"
          {...rise(still, 90)}
        >
          Claude plans. Only you pay.
        </motion.h2>
        <motion.p
          className="mb-12 mt-6 max-w-[34em] text-[16px] leading-[1.55] text-ink-dim md:text-[18px]"
          {...rise(still, 180)}
        >
          Mend&apos;s AI is Claude, running on Mend&apos;s own server. It reads the shop&apos;s numbers
          and PayPal orders, drafts the plan and writes each customer&apos;s note. It has no tool that
          sends money. A payout happens only when a person approves one exact plan.
        </motion.p>

        <div ref={splitRef} className="md:grid md:grid-cols-[1fr_56px_1fr]">
          <Capabilities
            heading="Claude can"
            items={CLAUDE_CAN}
            broken={false}
            fromX={-12}
            tint="bg-pale-sky"
            still={still}
          />
          <Seam vertical show={drawn} still={still} />
          <Seam vertical={false} show={drawn} still={still} />
          <Capabilities
            heading="Only you can"
            items={ONLY_YOU_CAN}
            broken
            fromX={12}
            tint="bg-pale-butter"
            still={still}
          />
        </div>

        <div className="mt-7 grid grid-cols-1 gap-5 md:grid-cols-3">
          {RULES.map((rule, i) => (
            <motion.div
              key={rule.label}
              className={`patch patch-tinted ${rule.tint} p-[30px]`}
              {...fadeIn(still, i * 100)}
            >
              <p className="font-mono text-[13px] uppercase tracking-[0.08em] text-ink-faint">
                {rule.label}
              </p>
              <p className="mt-3 text-[16px] leading-[1.5] text-ink-dim">{rule.text}</p>
            </motion.div>
          ))}
        </div>

        <p className="mt-9 text-center text-[18px] leading-[1.55] text-ink-dim">
          Every rule above can be tested from your browser, against the live app.
        </p>
        <div className="mt-5 flex justify-center">
          <a
            href="/demo?step=break-it"
            className={`inline-flex h-[54px] items-center gap-3 rounded-[12px] border-2 border-ink px-6 text-[17px] font-semibold text-ink transition-colors duration-[160ms] ease-out hover:bg-ink hover:text-paper motion-reduce:transition-none ${FOCUS_RING}`}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" className="shrink-0">
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" className="stroke-accent" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Try to break it yourself
          </a>
        </div>
      </div>
    </section>
  );
}
