export type ThreadState = "waiting" | "sending" | "sent" | "claimed" | "returned" | "refused" | "unclear" | "held";

type Role = "reward" | "holdout";

/** What a thread is drawn from: where its payment stands, and whether the customer came back. */
export type ThreadLook = { state: ThreadState; returned: "simulated" | "real" | null };

type ResultRowLike = {
  ref: string;
  role: Role;
  payoutStatus: string | null;
  simulatedReturn: boolean;
  realReturn: boolean;
};

/** One look per customer, by ref. A real purchase outranks a simulated one when a row has both. */
export function looksFromRows(rows: readonly ResultRowLike[]): Map<string, ThreadLook> {
  return new Map(
    rows.map((row) => [
      row.ref,
      {
        state: threadState(row.role, row.payoutStatus),
        returned: row.realReturn ? "real" : row.simulatedReturn ? "simulated" : null,
      },
    ]),
  );
}

/**
 * What one customer's thread shows, from the payout status Mend's ledger stores for their
 * reward. A held-back customer is never paid, and a reward with no payout item yet is still
 * waiting to be sent. A status this list does not know is unclear, never guessed at.
 */
export function threadState(role: Role, payoutStatus: string | null): ThreadState {
  if (role === "holdout") return "held";
  if (payoutStatus === null) return "waiting";
  switch (payoutStatus) {
    case "PENDING":
      return "sending";
    case "UNCLAIMED":
      return "sent";
    case "SUCCESS":
      return "claimed";
    case "RETURNED":
    case "REFUNDED":
    case "REVERSED":
      return "returned";
    case "FAILED":
    case "BLOCKED":
      return "refused";
    default:
      return "unclear";
  }
}

export const STATE_LABEL: Record<ThreadState, string> = {
  waiting: "not sent yet",
  sending: "PayPal is processing",
  sent: "sent, waiting to be claimed",
  claimed: "claimed by the customer",
  returned: "returned to the shop",
  refused: "PayPal could not pay",
  unclear: "status unclear, Mend will check again",
  held: "held back, never paid",
};

/** True once nothing is still waiting to be sent or being processed, so polling can stop. */
export function isSettled(states: readonly ThreadState[]): boolean {
  return !states.some((state) => state === "waiting" || state === "sending");
}
