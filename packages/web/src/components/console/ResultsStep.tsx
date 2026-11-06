"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDay } from "@/components/live/summary";
import { verdictTitle, windowNote } from "@/components/studio/widgets/verdict-words";
import { ApiError, type CampaignView, type Cancelled, type ConsoleApi, type Results } from "./api";
import { CampaignThreads } from "./CampaignThreads";
import { formatPercent, formatUsd, plural, utcDay } from "./money";
import { looksFromRows } from "./status";
import { FOCUS_RING, Figure, LoomLine, NoticePanel, PRIMARY_BUTTON, SECONDARY_BUTTON, Spinner, StepHeader, TextButton } from "./ui";

const REFRESH_EVERY_MS = 20_000;

const LABEL = "font-mono text-[12px] uppercase tracking-[0.14em] text-ink-dim";

type Load =
  | { kind: "loading" }
  | { kind: "ready"; view: CampaignView; results: Results }
  | { kind: "failed"; text: string; canRetry: boolean };

function loadFailure(error: unknown): { text: string; canRetry: boolean } {
  if (error instanceof ApiError && error.status === 429) {
    return { text: "You have looked at the results many times this hour. Try again later.", canRetry: false };
  }
  return { text: "The results didn't load.", canRetry: true };
}

type Action<Done> = { kind: "idle" } | { kind: "pending" } | { kind: "done"; value: Done } | { kind: "failed"; text: string };

function simulateFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return "This campaign or session has simulated the most purchases allowed for now.";
    if (error.status === 503) return "PayPal didn't answer. Try again in a moment.";
  }
  return "The purchase didn't go through. Try again.";
}

function takeBackFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409 && error.code === "not_submitted") return "This plan hasn't been sent yet.";
    if (error.status === 429) {
      const seconds = error.retryAfterSeconds;
      if (seconds === null) return "This session has taken back cashback the most times allowed for now. Try again later.";
      return `This session has taken back cashback the most times allowed for now. Try again in ${Math.max(1, Math.ceil(seconds / 60))} min.`;
    }
  }
  return "The take-back didn't go through. Try again.";
}

function takeBackLine(answer: Cancelled): string {
  const returned = formatUsd(answer.returnedMinor);
  if (!answer.incomplete) return `Returned ${returned} to the shop.`;
  const left = plural(answer.stillUnclaimed, "payment", "payments");
  const base = `Returned ${returned}. PayPal didn't confirm ${left}; Mend will check again.`;
  return answer.notCancellable > 0
    ? `${base} ${plural(answer.notCancellable, "payment was", "payments were")} already claimed or settled.`
    : base;
}

type Arm = Results["rewarded"];

function ArmPanel({ title, arm }: { title: string; arm: Arm }) {
  return (
    <section aria-label={title} className="patch p-7">
      <p className={LABEL}>{title}</p>
      <p className="mt-2 text-[24px] font-semibold tabular-nums text-ink">
        {plural(arm.members, "customer", "customers")}
      </p>
      <dl className="mt-5 grid grid-cols-2 items-end gap-x-6 gap-y-5">
        <Figure label="Came back">
          {arm.realReturns}
          {arm.realRate !== null && <> <span className="font-sans text-[16px] font-normal text-ink-dim">{formatPercent(arm.realRate)}</span></>}
        </Figure>
        <Figure label="Simulated returns" note="(kept apart)">
          {arm.simulatedReturns}
        </Figure>
      </dl>
    </section>
  );
}

function InlineAlert({ children }: { children: string }) {
  return (
    <p role="alert" className="mt-4 flex items-start gap-3 text-[14px] leading-[1.5] text-ink-dim">
      <span aria-hidden="true" className="mt-[7px] block h-[6px] w-[6px] shrink-0 rounded-full bg-accent" />
      {children}
    </p>
  );
}

type ResultsStepProps = {
  api: ConsoleApi;
  campaignId: string;
  onNewPlan: () => void;
  /** Told the id of each PayPal order a simulated purchase creates, so the Ask panel can offer to look it up. */
  onOrder: (orderId: string) => void;
  /** Opens the dashboard. Without it the button is left out. */
  onDashboard?: () => void;
};

export function ResultsStep({ api, campaignId, onNewPlan, onOrder, onDashboard }: ResultsStepProps) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [pick, setPick] = useState<string | null>(null);
  const [simulation, setSimulation] = useState<Action<string>>({ kind: "idle" });
  const [takeBack, setTakeBack] = useState<Action<Cancelled>>({ kind: "idle" });
  const controller = useRef<AbortController | null>(null);
  // Set when the server says the hour's reads are used up, so the 20 second refresh stops asking.
  const readsUsedUp = useRef(false);

  useEffect(() => {
    const mine = new AbortController();
    controller.current = mine;
    readsUsedUp.current = false;
    Promise.all([api.view(campaignId, { signal: mine.signal }), api.results(campaignId, { signal: mine.signal })])
      .then(([view, results]) => {
        if (!mine.signal.aborted) setLoad({ kind: "ready", view, results });
      })
      .catch((error: unknown) => {
        if (mine.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) {
          onNewPlan();
          return;
        }
        setLoad({ kind: "failed", ...loadFailure(error) });
      });
    return () => mine.abort();
  }, [api, campaignId, attempt, onNewPlan]);

  const refreshResults = useCallback(async () => {
    const signal = controller.current?.signal;
    try {
      const results = await api.results(campaignId, { signal });
      if (signal?.aborted) return;
      setLoad((current) => (current.kind === "ready" ? { ...current, results } : current));
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof ApiError && error.status === 429) readsUsedUp.current = true;
      if (error instanceof ApiError && error.status === 404) onNewPlan();
    }
  }, [api, campaignId, onNewPlan]);

  const ready = load.kind === "ready";
  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => {
      if (!readsUsedUp.current) void refreshResults();
    }, REFRESH_EVERY_MS);
    return () => clearInterval(timer);
  }, [ready, refreshResults]);

  const results = load.kind === "ready" ? load.results : null;
  const view = load.kind === "ready" ? load.view : null;
  const statuses = useMemo(() => (results === null ? undefined : looksFromRows(results.rows)), [results]);
  // The paid group is the story a judge expects to test first, so the first paid row is the default.
  const picked = pick ?? results?.rows.find((row) => row.role === "reward")?.ref ?? results?.rows[0]?.ref ?? "";

  async function simulate() {
    if (picked === "") return;
    const signal = controller.current?.signal;
    setSimulation({ kind: "pending" });
    try {
      const order = await api.simulate(campaignId, picked, { signal });
      onOrder(order.paypalOrderId);
      if (signal?.aborted) return;
      setSimulation({ kind: "done", value: `PayPal order ${order.paypalOrderId} · ${order.paypalStatus}` });
      await refreshResults();
    } catch (error) {
      if (signal?.aborted) return;
      setSimulation({ kind: "failed", text: simulateFailure(error) });
    }
  }

  async function takeBackUnclaimed() {
    const signal = controller.current?.signal;
    setTakeBack({ kind: "pending" });
    try {
      const answer = await api.cancelUnclaimed(campaignId, { signal });
      if (signal?.aborted) return;
      setTakeBack({ kind: "done", value: answer });
      await refreshResults();
    } catch (error) {
      if (signal?.aborted) return;
      setTakeBack({ kind: "failed", text: takeBackFailure(error) });
    }
  }

  const unclaimed = results?.payouts.unclaimedMinor ?? 0;
  const showTakeBack = results !== null && (unclaimed > 0 || takeBack.kind === "done");

  return (
    <section aria-labelledby="results-title" aria-busy={load.kind === "loading"}>
      {results !== null && view !== null ? (
        <>
          <StepHeader
            tint="sage"
            kicker="Step 5 · Results"
            titleId="results-title"
            title={verdictTitle(results.verdict)}
            icon="/world/icons/results.webp"
          >
            <p className="mt-5 max-w-[60ch] text-[16px] leading-[1.55] text-ink-dim">
              Mend compares how many customers came back in the paid group with the held-back group, over a window
              that started when the cashback was sent. It gives a verdict only when both groups are big enough to tell. A
              five-person demo group never is, and Mend says so instead of guessing.
            </p>
            <p className="mt-2 font-mono text-[12px] text-ink-dim">{windowNote(results)}</p>
          </StepHeader>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            <ArmPanel title="Paid" arm={results.rewarded} />
            <ArmPanel title="Held back" arm={results.holdout} />
          </div>

          {onDashboard && (
            <button type="button" onClick={onDashboard} className={`${SECONDARY_BUTTON} mt-6 h-12 px-5 text-[15px] ${FOCUS_RING}`}>
              Open the dashboard
            </button>
          )}

          <div className="mt-6">
            <CampaignThreads rows={view.rows} mode="sealed" statuses={statuses} />
          </div>

          <div className="patch mt-6 p-7" aria-busy={simulation.kind === "pending"}>
            <p className="text-[16px] leading-6 text-ink">Simulate a customer coming back</p>
            <p className="mt-2 max-w-[60ch] text-[14px] leading-[1.5] text-ink-dim">
              Mend makes a real sandbox purchase with a PayPal test card for the customer you pick, and counts it for
              their group. Simulated returns are always kept apart from real ones.
            </p>
            <div className="mt-5 flex flex-col gap-3 md:flex-row md:items-center">
              <select
                aria-label="Customer to simulate a return for"
                value={picked}
                onChange={(event) => setPick(event.target.value)}
                disabled={simulation.kind === "pending"}
                className={`h-12 w-full rounded-[14px] border-2 border-ink/20 bg-paper-raised px-4 text-[15px] text-ink focus:border-accent disabled:opacity-50 md:w-auto md:min-w-[220px] ${FOCUS_RING}`}
              >
                {results.rows.map((row) => (
                  <option key={row.ref} value={row.ref}>
                    #{row.rank} &middot; {typeof row.displayName === "string" && row.displayName !== "" ? `${row.displayName} · ` : ""}
                    {row.role === "reward" ? "paid" : "held back"}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void simulate()}
                disabled={simulation.kind === "pending" || picked === ""}
                className={`${SECONDARY_BUTTON} h-12 px-5 text-[15px] ${FOCUS_RING}`}
              >
                Simulate a return purchase
              </button>
            </div>
            {simulation.kind === "pending" && (
              <p role="status" className="mt-4 flex items-center gap-3 text-[14px] leading-[1.5] text-ink-dim">
                <Spinner />
                Buying with a sandbox test card
              </p>
            )}
            {simulation.kind === "done" && (
              <p role="status" className="mt-4 font-mono text-[12px] leading-[1.5] text-ink-dim">
                {simulation.value}
              </p>
            )}
            {simulation.kind === "failed" && <InlineAlert>{simulation.text}</InlineAlert>}
          </div>

          {showTakeBack && (
            <div className="patch mt-6 p-7" aria-busy={takeBack.kind === "pending"}>
              {unclaimed > 0 && (
                <>
                  <p className="text-[15px] leading-[1.5] text-ink">{formatUsd(unclaimed)} is still waiting to be claimed.</p>
                  {results.payouts.unclaimedReturnBy !== null && (
                    <p className="mt-2 max-w-[60ch] text-[14px] leading-[1.5] text-ink-dim">
                      PayPal returns it on {formatDay(utcDay(results.payouts.unclaimedReturnBy))} if nobody claims it.
                    </p>
                  )}
                  {takeBack.kind === "pending" ? (
                    <p role="status" className="mt-5 flex items-center gap-3 text-[14px] leading-[1.5] text-ink-dim">
                      <Spinner />
                      Asking PayPal to return the cashback
                    </p>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void takeBackUnclaimed()}
                      className={`${PRIMARY_BUTTON} mt-5 h-12 px-[22px] text-[15px] ${FOCUS_RING}`}
                    >
                      Take back {formatUsd(unclaimed)}
                    </button>
                  )}
                </>
              )}
              {takeBack.kind === "done" && (
                <p role="status" className={`${unclaimed > 0 ? "mt-4" : ""} text-[15px] leading-[1.5] text-ink`}>
                  {takeBackLine(takeBack.value)}
                </p>
              )}
              {takeBack.kind === "failed" && <InlineAlert>{takeBack.text}</InlineAlert>}
            </div>
          )}

          <div className="mt-8">
            <TextButton onClick={onNewPlan}>Start over with a new plan</TextButton>
          </div>
        </>
      ) : (
        <>
          <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-ink-dim">Step 5 &middot; Results</p>
          <h1 id="results-title" className="sr-only">
            Results
          </h1>
          {load.kind === "failed" ? (
            <NoticePanel
              action={
                load.canRetry ? (
                  <TextButton
                    onClick={() => {
                      setLoad({ kind: "loading" });
                      setAttempt((current) => current + 1);
                    }}
                  >
                    Try again
                  </TextButton>
                ) : undefined
              }
            >
              {load.text}
            </NoticePanel>
          ) : (
            <div role="status" className="patch mt-6 p-7">
              <LoomLine />
              <p className="mt-4 text-[14px] leading-[1.5] text-ink-dim">Loading the results</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
