import { formatDay, type ForecastBands } from "../live/summary";

export const GROUPS = ["likelyGone", "worthANudge", "likelyBack"] as const;

export type GroupKey = (typeof GROUPS)[number];

// String(n) drops trailing zeros on its own, so 0.10 reads "0.1" and 1 reads "1".
export function trimNumber(n: number): string {
  return String(n);
}

export function groupName(key: GroupKey): string {
  if (key === "likelyGone") return "Likely gone";
  if (key === "worthANudge") return "Worth a nudge";
  return "Likely back anyway";
}

export function groupRule(key: GroupKey, bands: ForecastBands): string {
  const low = trimNumber(bands.likelyGoneBelow);
  const high = trimNumber(bands.likelyBackFrom);
  if (key === "likelyGone") return `Under ${low} orders expected`;
  if (key === "worthANudge") return `${low} to under ${high} orders expected`;
  return `${high} or more orders expected`;
}

export function groupShare(count: { customers: number; returned: number }): number | null {
  return count.customers === 0 ? null : count.returned / count.customers;
}

export function groupsCaption(bands: ForecastBands, holdoutDays: number): string {
  const converged = bands.cutoffs.filter((c) => c.converged);
  const first = converged[0];
  const last = converged[converged.length - 1];
  if (first === undefined || last === undefined) return "Not measured yet.";
  const base = `Quiet regulars, customers who bought on ${bands.regularMinDays} or more days and then went silent for ${bands.silentMinDays} or more, at ${converged.length} past dates in the shop's history, ${formatDay(first.cutoff)} to ${formatDay(last.cutoff)}. Each was put in a group by how many orders Mend's forecast expected over the next ${bands.horizonWeeks} weeks, and each bar is the share who bought again within ${holdoutDays} days with no cashback at all.`;
  return bands.rising
    ? `${base} Mend nudges only the middle group: the likely gone rarely answer a nudge, and the likely back mostly return without one.`
    : `${base} Mend nudges only the middle group. On this history the shares do not rise from group to group, so the split is not supported.`;
}
