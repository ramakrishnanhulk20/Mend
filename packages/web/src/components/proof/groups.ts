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
  const base = `Quiet regulars at ${converged.length} past dates in the shop's history, ${formatDay(first.cutoff)} to ${formatDay(last.cutoff)}, split by how many orders Mend's forecast expected of each over the next ${bands.horizonWeeks} weeks. Each bar is the share who bought again within ${holdoutDays} days with no cashback at all. Mend nudges only the middle group.`;
  return bands.rising ? base : `${base} On this history the shares do not rise from group to group, so the split is not supported.`;
}
