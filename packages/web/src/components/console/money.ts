const USD = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Exact amounts, unlike the compact figure the landing page uses: 4821 reads "USD 48.21". */
export function formatUsd(minor: number): string {
  return `${minor < 0 ? "-" : ""}USD ${USD.format(Math.abs(minor) / 100)}`;
}

/** The plan carries the held-back share as text such as "0.05"; people read "5%". */
export function formatShare(share: string): string {
  return `${Math.round(Number(share) * 100)}%`;
}

const ELLIPSIS = "…";

/** A long hex fingerprint cut to its first six and last four characters. */
export function shortHash(hex: string): string {
  if (hex.length <= 10) return hex;
  return `${hex.slice(0, 6)}${ELLIPSIS}${hex.slice(-4)}`;
}

const COUNT = new Intl.NumberFormat("en-US");

/** A count with its noun, so one reads "1 customer" and the rest "2 customers". */
export function plural(n: number, one: string, many: string): string {
  return `${COUNT.format(n)} ${n === 1 ? one : many}`;
}

/** A rate between 0 and 1 as a percent with at most one decimal: 0.2 reads "20%", 0.0625 reads "6.3%". */
export function formatPercent(rate: number): string {
  return `${Number((rate * 100).toFixed(1))}%`;
}

/** The UTC calendar day of a timestamp, in the form formatDay reads. The engine's window times are UTC. */
export function utcDay(iso: string): string {
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? iso : time.toISOString().slice(0, 10);
}
