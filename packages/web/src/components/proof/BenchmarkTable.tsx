"use client";

import { useId } from "react";
import { motion, type Variants } from "motion/react";
import { useStill } from "@/components/motion/useStill";
import { formatCount } from "@/components/live/summary";
import {
  EASE,
  HEAD_RULE,
  ROW_RULE,
  ChartFrame,
  ChartPlaceholder,
  NotMeasured,
  type BlockProps,
} from "./DecileChart";

const HEIGHT_CLASS = "h-[280px]";
const MINUS = "−";

const PARAMETERS = [
  { key: "r", label: "r", digits: 3 },
  { key: "alpha", label: "alpha", digits: 3 },
  { key: "a", label: "a", digits: 3 },
  { key: "b", label: "b", digits: 3 },
  { key: "logLikelihood", label: "log-likelihood", digits: 1 },
] as const;

const ROWS: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.06 } },
};

const ROW: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.4, ease: EASE } },
};

const MATCHES = "matches";

const HEAD =
  "py-2 font-mono text-[12px] font-medium uppercase tracking-[0.04em] text-ink-faint md:tracking-[0.14em]";

function fixed(value: number, digits: number): string {
  return value.toFixed(digits).replace("-", MINUS);
}

// "matches" when the two agree at the precision shown, otherwise Mend minus published.
function check(published: number, fitted: number, digits: number): string {
  if (Number(Math.abs(published - fitted).toFixed(digits)) === 0) return MATCHES;
  const gap = fitted - published;
  return `${gap > 0 ? "+" : MINUS}${Math.abs(gap).toFixed(digits)}`;
}

export function BenchmarkTable({ state, summary }: BlockProps) {
  const titleId = useId();
  const still = useStill();
  const title = "Reproduces the published model";
  const benchmark = summary?.benchmark ?? null;

  if (state !== "ready" || summary === null) {
    return (
      <ChartFrame titleId={titleId} title={title} caption={null}>
        <ChartPlaceholder heightClass={HEIGHT_CLASS} />
      </ChartFrame>
    );
  }

  if (benchmark === null) {
    return (
      <ChartFrame titleId={titleId} title={title} caption={null}>
        <NotMeasured heightClass={HEIGHT_CLASS} />
      </ChartFrame>
    );
  }

  const caption = `Mend's BG/NBD fit on the ${benchmark.source} (${formatCount(benchmark.customers)} customers) against the parameters the paper reports.`;

  return (
    <ChartFrame titleId={titleId} title={title} caption={caption}>
      <table aria-labelledby={titleId} className="w-full text-[14px] tabular-nums md:text-[15px]">
        <thead>
          <tr className={HEAD_RULE}>
            <th scope="col" className={`${HEAD} pr-1.5 text-left md:pr-4`}>
              Parameter
            </th>
            <th scope="col" className={`${HEAD} pr-1.5 text-right md:pr-4`}>
              Published
            </th>
            <th scope="col" className={`${HEAD} pr-1.5 text-right md:pr-4`}>
              Mend
            </th>
            <th scope="col" className={`${HEAD} pl-2 text-left md:pl-4`}>
              <span className="sr-only">Check</span>
            </th>
          </tr>
        </thead>
        <motion.tbody
          variants={ROWS}
          initial={still ? "shown" : "hidden"}
          whileInView={still ? undefined : "shown"}
          viewport={{ once: true, amount: 0.4 }}
        >
          {PARAMETERS.map((parameter) => {
            const published = benchmark.published[parameter.key];
            const fitted = benchmark.fitted[parameter.key];
            const verdict = check(published, fitted, parameter.digits);
            return (
              <motion.tr key={parameter.key} variants={ROW} className={ROW_RULE}>
                <th scope="row" className="py-3 pr-1.5 text-left font-mono text-[12px] font-normal text-ink-dim md:whitespace-nowrap md:pr-4 md:text-[15px]">
                  {parameter.label}
                </th>
                <td className="py-3 pr-1.5 text-right text-ink md:pr-4">{fixed(published, parameter.digits)}</td>
                <td className="py-3 pr-1.5 text-right text-ink md:pr-4">{fixed(fitted, parameter.digits)}</td>
                <td className="py-3 pl-2 text-left font-mono text-[12px] text-ink-dim md:pl-4">
                  {verdict === MATCHES ? (
                    <span className="label-tag h-6 bg-pale-sage px-1.5 text-[11px] tracking-normal md:px-2.5 md:tracking-[0.08em]">{verdict}</span>
                  ) : (
                    verdict
                  )}
                </td>
              </motion.tr>
            );
          })}
        </motion.tbody>
      </table>
    </ChartFrame>
  );
}
