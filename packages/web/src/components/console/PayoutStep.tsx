"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useStill } from "@/components/motion/useStill";
import { ApiError, type CampaignView, type ConsoleApi, type Results } from "./api";
import { CampaignThreads } from "./CampaignThreads";
import { formatUsd, plural } from "./money";
import { isSettled, looksFromRows, threadState, type ThreadLook } from "./status";
import {
  EASE,
  FOCUS_RING,
  Figure,
  LoomLine,
  NoticePanel,
  PRIMARY_BUTTON,
  Spinner,
  StepHeader,
  TextButton,
  useElapsedSeconds,
} from "./ui";

const FAST_POLL_MS = 5_000;
const SLOW_POLL_MS = 20_000;
const FAST_POLL_UNTIL_MS = 120_000;
const STOP_POLLING_AFTER_MS = 15 * 60_000;
const COPIED_FOR_MS = 1_500;

// The campaign statuses that mean the batch has already gone to PayPal and is being paid.
const SENT_STATUSES = ["submitted", "completed"];

const DAILY_BUDGET_LINE = "The demo has paid out its daily budget across all visitors. Try again tomorrow.";

type Failure = { text: string; canRetry: boolean };

function submitFailure(error: unknown): Failure {
  if (error instanceof ApiError) {
    if (error.status === 429 && error.code === "limit_reached") {
      return { text: "This session has sent the most batches allowed today.", canRetry: false };
    }
    if (error.code === "over_demo_daily_cap" || error.code === "over_daily_cap") {
      return { text: DAILY_BUDGET_LINE, canRetry: false };
    }
    if (error.status === 422 && error.code === "low_balance") {
      return { text: "The sandbox shop's PayPal balance is too low to send this right now.", canRetry: false };
    }
    if (error.status === 503 && (error.code === "paypal_unavailable" || error.code === "balance_unavailable")) {
      return { text: "PayPal didn't answer. Nothing was sent twice; try again in a moment.", canRetry: true };
    }
    if (error.status === 503 && error.code === "busy") {
      return { text: "Another payout is being sent right now. Try again in a few seconds.", canRetry: false };
    }
  }
  return { text: "The batch didn't go out. Try again.", canRetry: false };
}

type Load = { kind: "loading" } | { kind: "ready"; view: CampaignView } | { kind: "failed"; text: string };

type Phase =
  | { kind: "ready"; failure: Failure | null }
  | { kind: "sending" }
  | { kind: "sent"; batchId: string | null; alreadySent: boolean };

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // The browser refused the clipboard; the id is still on screen to select by hand.
      return;
    }
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_FOR_MS);
  }

  return (
    <TextButton mono onClick={() => void copy()}>
      {copied ? "Copied" : "Copy"}
    </TextButton>
  );
}

function moneyFigures(results: Results): { label: string; value: string }[] {
  const { payouts, feesMinor } = results;
  return [
    { label: "Claimed", value: formatUsd(payouts.claimedMinor) },
    { label: "Waiting", value: formatUsd(payouts.unclaimedMinor + payouts.pendingMinor) },
    { label: "Returned", value: formatUsd(payouts.returnedMinor) },
    { label: "Fees", value: formatUsd(feesMinor) },
  ];
}

type PayoutStepProps = {
  api: ConsoleApi;
  campaignId: string;
  onNewPlan: () => void;
  onResults: () => void;
};

export function PayoutStep({ api, campaignId, onNewPlan, onResults }: PayoutStepProps) {
  const still = useStill();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "ready", failure: null });
  const [results, setResults] = useState<Results | null>(null);
  const [polling, setPolling] = useState(true);
  const [reads, setReads] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const sending = phase.kind === "sending";
  const elapsed = useElapsedSeconds(sending);

  useEffect(() => {
    const mine = new AbortController();
    controller.current = mine;
    api
      .view(campaignId, { signal: mine.signal })
      .then((view) => {
        if (mine.signal.aborted) return;
        setLoad({ kind: "ready", view });
        // A reload on a campaign that was already sent goes straight to watching PayPal pay it.
        if (SENT_STATUSES.includes(view.status)) {
          setPhase((now) => (now.kind === "ready" ? { kind: "sent", batchId: null, alreadySent: false } : now));
        }
      })
      .catch((error: unknown) => {
        if (mine.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) {
          onNewPlan();
          return;
        }
        setLoad({ kind: "failed", text: "The plan didn't load." });
      });
    return () => mine.abort();
  }, [api, campaignId, attempt, onNewPlan]);

  const sent = phase.kind === "sent";

  // Asks PayPal's ledger how each payment stands: quickly at first, then slowly, until every
  // thread has an answer or fifteen minutes have passed. Refresh starts it over.
  useEffect(() => {
    if (!sent) return;
    const mine = new AbortController();
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function read() {
      try {
        const answer = await api.results(campaignId, { signal: mine.signal });
        if (mine.signal.aborted) return;
        setResults(answer);
        const states = answer.rows.map((row) => threadState(row.role, row.payoutStatus));
        if (isSettled(states)) {
          setPolling(false);
          return;
        }
      } catch (error) {
        if (mine.signal.aborted) return;
        if (error instanceof ApiError && error.status === 429) {
          setPolling(false);
          return;
        }
      }
      const waited = Date.now() - startedAt;
      if (waited >= STOP_POLLING_AFTER_MS) {
        setPolling(false);
        return;
      }
      timer = setTimeout(() => void read(), waited < FAST_POLL_UNTIL_MS ? FAST_POLL_MS : SLOW_POLL_MS);
    }

    void read();
    return () => {
      mine.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, campaignId, sent, reads]);

  const refresh = useCallback(() => {
    setPolling(true);
    setReads((n) => n + 1);
  }, []);

  const send = useCallback(async () => {
    const signal = controller.current?.signal;
    setPhase({ kind: "sending" });
    try {
      const answer = await api.submit(campaignId, { signal });
      if (signal?.aborted) return;
      setPhase({ kind: "sent", batchId: answer.payoutBatchId, alreadySent: !answer.sent });
    } catch (error) {
      if (signal?.aborted) return;
      setPhase({ kind: "ready", failure: submitFailure(error) });
    }
  }, [api, campaignId]);

  const view = load.kind === "ready" ? load.view : null;
  const rows = useMemo(() => view?.rows ?? [], [view]);
  const rewarded = rows.filter((row) => row.role === "reward").length;

  const statuses = useMemo<ReadonlyMap<string, ThreadLook>>(
    () =>
      results === null
        ? new Map(rows.map((row) => [row.ref, { state: threadState(row.role, null), returned: null }]))
        : looksFromRows(results.rows),
    [results, rows],
  );

  const states = [...statuses.values()].map((look) => look.state);
  const settled = results !== null && isSettled(states);
  const claimed = states.filter((state) => state === "claimed").length;
  const waiting = states.filter((state) => state === "sent").length;

  let title = "Send it with PayPal.";
  if (phase.kind !== "ready") {
    const returned = states.filter((state) => state === "returned").length;
    title = !settled
      ? `PayPal is paying ${plural(rewarded, "customer", "customers")}.`
      : returned > 0 && claimed === 0 && waiting === 0
        ? "Unclaimed cashback came back to the shop."
        : `Sent. ${claimed} claimed, ${waiting} waiting.`;
  }

  return (
    <section aria-labelledby="payout-title" aria-busy={sending || load.kind === "loading"}>
      <StepHeader
        tint="teal"
        kicker="Step 4 · Payout"
        titleId="payout-title"
        title={title}
        icon="/world/icons/payout.webp"
      >
        <p className="mt-5 max-w-[60ch] text-[16px] leading-[1.55] text-ink-dim">
          Mend sends the sealed plan as one PayPal Payouts batch. Each customer&apos;s thread is stitched as PayPal
          confirms their payment.
        </p>
      </StepHeader>

      {view === null ? (
        load.kind === "failed" ? (
          <NoticePanel action={<TextButton onClick={() => { setLoad({ kind: "loading" }); setAttempt((n) => n + 1); }}>Try again</TextButton>}>
            {load.text}
          </NoticePanel>
        ) : (
          <div role="status" className="patch p-7">
            <LoomLine />
            <p className="mt-4 text-[14px] leading-[1.5] text-ink-dim">Loading the plan</p>
          </div>
        )
      ) : (
        <>
          {phase.kind === "ready" && (
            <motion.div
              className="patch p-7"
              initial={still ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: EASE }}
            >
              <p className="text-[15px] leading-[1.5] text-ink">
                {formatUsd(view.totalMinor)} to {plural(rewarded, "customer", "customers")} in one batch.
              </p>
              <p className="mt-2 max-w-[60ch] text-[14px] leading-[1.5] text-ink-dim">
                This is PayPal&apos;s sandbox: the money is PayPal&apos;s test money, and no real account is charged.
              </p>
              <p className="mt-2 max-w-[60ch] text-[14px] leading-[1.5] text-ink-dim">
                Demo stand-ins have no real PayPal account, so PayPal holds their cashback as unclaimed. You can
                take it back in the results step.
              </p>
              <button
                type="button"
                onClick={() => void send()}
                className={`${PRIMARY_BUTTON} mt-6 h-12 px-[22px] text-[15px] ${FOCUS_RING}`}
              >
                Send with PayPal
              </button>
            </motion.div>
          )}

          {phase.kind === "ready" && phase.failure !== null && (
            <NoticePanel
              action={phase.failure.canRetry ? <TextButton onClick={() => void send()}>Try again</TextButton> : undefined}
            >
              {phase.failure.text}
            </NoticePanel>
          )}

          {sending && (
            <div role="status" className="patch p-7">
              <LoomLine />
              <p className="mt-4 flex items-center gap-3 text-[14px] leading-[1.5] text-ink-dim">
                <Spinner />
                Sending the batch to PayPal
              </p>
              <p className="mt-2 font-mono text-[12px] tabular-nums text-ink-faint">{elapsed} s</p>
            </div>
          )}

          {phase.kind === "sent" && (
            <div className="patch p-7">
              {(phase.batchId !== null || phase.alreadySent) && (
                <div className="flex flex-wrap items-center gap-x-4">
                  <p className="font-mono text-[12px] leading-[1.5] text-ink-dim">
                    {phase.batchId !== null && `PayPal batch ${phase.batchId}`}
                    {phase.batchId !== null && phase.alreadySent && " · "}
                    {phase.alreadySent && (phase.batchId !== null ? "already sent" : "Already sent")}
                  </p>
                  {phase.batchId !== null && <CopyButton text={phase.batchId} />}
                </div>
              )}

              {results !== null && (
                <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 xl:grid-cols-4">
                  {moneyFigures(results).map(({ label, value }) => (
                    <Figure key={label} label={label}>
                      {value}
                    </Figure>
                  ))}
                </dl>
              )}

              {!polling && (
                <div className="mt-1">
                  <TextButton onClick={refresh}>Refresh</TextButton>
                </div>
              )}

              <button
                type="button"
                onClick={onResults}
                className={`${PRIMARY_BUTTON} mt-6 h-12 px-[22px] text-[15px] ${FOCUS_RING}`}
              >
                See the results
              </button>
            </div>
          )}

          <div className="mt-6">
            <CampaignThreads rows={rows} mode="sealed" statuses={statuses} />
          </div>
        </>
      )}
    </section>
  );
}
