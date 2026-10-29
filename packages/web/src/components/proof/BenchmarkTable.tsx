"use client";

import { useId } from "react";
import { motion, type Variants } from "motion/react";
import { useStill } from "@/components/motion/useStill";
import { formatCount } from "@/components/live/summary";
import { EASE, ChartFrame, ChartPlaceholder, NotMeasured, type BlockProps } from "./DecileChart";

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

const HEAD =
  "py-2 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-bone-faint";

function fixed(value: number, digits: number): string {
  return value.toFixed(digits).replace("-", MINUS);
}

// "matches" when the two agree at the precision shown, otherwise Mend minus published.
function check(published: number, fitted: number, digits: number): string {
  if (Number(Math.abs(published - fitted).toFixed(digits)) === 0) return "matches";
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
      <table aria-labelledby={titleId} className="w-full max-w-[720px] text-[15px] tabular-nums">
        <thead>
          <tr className="border-b border-bone/10">
            <th scope="col" className={`${HEAD} pr-2 text-left md:pr-4`}>
              Parameter
            </th>
            <th scope="col" className={`${HEAD} pr-2 text-right md:pr-4`}>
              Published
            </th>
            <th scope="col" className={`${HEAD} pr-2 text-right md:pr-4`}>
              Mend
            </th>
            <th scope="col" className={`${HEAD} pl-3 text-left md:pl-4`}>
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
            return (
              <motion.tr key={parameter.key} variants={ROW} className="border-b border-bone/10">
                <th scope="row" className="whitespace-nowrap py-3 pr-2 text-left font-mono text-[13px] md:text-[15px] font-normal text-bone-dim md:pr-4">
                  {parameter.label}
                </th>
                <td className="py-3 pr-2 text-right text-bone md:pr-4">{fixed(published, parameter.digits)}</td>
                <td className="py-3 pr-2 text-right text-bone md:pr-4">{fixed(fitted, parameter.digits)}</td>
                <td className="py-3 pl-3 text-left font-mono text-[12px] text-bone-dim md:pl-4">
                  {check(published, fitted, parameter.digits)}
                </td>
              </motion.tr>
            );
          })}
        </motion.tbody>
      </table>
    </ChartFrame>
  );
}
