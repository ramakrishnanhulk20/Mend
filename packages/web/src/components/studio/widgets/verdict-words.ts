import type { Results } from "../../console/api";
import { utcDay } from "../../console/money";
import { formatDay } from "../../live/summary";

// The Results step and the dashboard both read their verdict words from here, so they cannot drift apart.

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The verdict as a title: the first letter capital, one full stop at the end. */
export function verdictTitle(verdict: string): string {
  const text = capitalised(verdict.trim());
  return text.endsWith(".") ? text : `${text}.`;
}

type WindowFacts = Pick<Results, "windowStartsAt" | "windowEndsAt" | "windowOpen" | "pValue">;

const PART_BREAK = " \u00b7 ";
const P_VALUE = "p = ";

/** The Window line: the days the count runs, whether it is open, and the p value once Mend has one. Empty when there is nothing to say. */
export function windowNote(results: WindowFacts): string {
  const parts: string[] = [];
  if (results.windowStartsAt !== null && results.windowEndsAt !== null) {
    parts.push(`Window ${formatDay(utcDay(results.windowStartsAt))} to ${formatDay(utcDay(results.windowEndsAt))} \u00b7 ${results.windowOpen ? "open" : "closed"}`);
  }
  if (results.pValue !== null) parts.push(`${P_VALUE}${results.pValue.toFixed(2)}`);
  return parts.join(PART_BREAK);
}

/**
 * True when Mend has a verdict to give, so a share may be drawn. The engine sets a p value only once its verdict gate
 * has passed (campaigns/results.py), so the p value decides, never the verdict's words. A widget sees only its mapped
 * fields, and the window line is where a row carries the p value. No line, or no p value in it, reads as no verdict.
 */
export function hasVerdict(windowLine: string): boolean {
  return windowLine.split(PART_BREAK).some((part) => part.startsWith(P_VALUE));
}
