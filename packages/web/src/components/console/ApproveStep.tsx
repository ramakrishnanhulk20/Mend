"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useStill } from "@/components/motion/useStill";
import { ApiError, type CampaignView, type ConsoleApi } from "./api";
import { CampaignThreads } from "./CampaignThreads";
import { formatUsd, plural, shortHash } from "./money";
import {
  EASE,
  FOCUS_RING,
  LoomLine,
  NoticePanel,
  PRIMARY_BUTTON,
  Spinner,
  StitchedThread,
  TextButton,
  useElapsedSeconds,
} from "./ui";

const OPEN_STATUSES = ["draft", "awaiting_approval"];
const PLACEHOLDER_ROWS = 6;
const TYPE_IN_MS = 600;

function minutesFor(error: ApiError): number | null {
  return error.retryAfterSeconds === null ? null : Math.max(1, Math.ceil(error.retryAfterSeconds / 60));
}

function limitLine(minutes: number | null): string {
  return minutes === null
    ? "This session has used its plans for now."
    : `This session has drafted the most plans allowed. Try again in ${minutes} min.`;
}

function isBusy(error: ApiError): boolean {
  return error.status === 503 || error.code === "still_running";
}

// A timestamp that does not read just drops the time; the seal still stands.
function localClock(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

type Load =
  | { kind: "loading" }
  | { kind: "ready"; view: CampaignView }
  | { kind: "failed"; text: string; canRetry: boolean };

function loadFailure(error: unknown): { text: string; canRetry: boolean } {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      const minutes = minutesFor(error);
      return {
        text:
          minutes === null
            ? "You have looked at this plan many times this hour. Try again later."
            : `You have looked at this plan many times this hour. Try again in ${minutes} min.`,
        canRetry: false,
      };
    }
    if (isBusy(error)) return { text: "The engine is busy. Try again in a moment.", canRetry: true };
  }
  return { text: "The plan didn't load.", canRetry: true };
}

const OVER_CAPS = "An amount in this plan is above the demo's caps, so it can't be approved. Draft a new plan.";

const REVIEW_PROBLEM_TEXT: Readonly<Record<string, string>> = {
  voided: "This plan was cancelled and can't be approved. Draft a new plan.",
  not_open: "This plan has already moved past approval.",
  member_held: "One of these customers is in another campaign that is still being measured. Draft a new plan.",
  amount_over_item_cap: OVER_CAPS,
  amount_over_per_recipient: OVER_CAPS,
  over_budget: OVER_CAPS,
  budget_over_cap: OVER_CAPS,
  over_daily_cap: "The demo has paid out its daily budget across all visitors. Try again tomorrow.",
  recipient_not_member: "A customer in this plan has left the list. Draft a new plan.",
  recipient_unverified: "PayPal hasn't verified one customer's email, so this plan can't be paid. Draft a new plan.",
  incomplete_item: "A reward in this plan is missing its amount or note. Draft a new plan.",
  snapshot_refused: "Mend couldn't freeze this plan. Draft a new plan.",
};

/** The engine names why a plan cannot be approved with a short code; people never see the code. */
function reviewProblemText(code: string): string {
  return REVIEW_PROBLEM_TEXT[code] ?? "This plan can't be approved as it stands. Draft a new plan.";
}

// Approving can be refused for the same reasons the review reports, so these use the same sentences.
const NEW_PLAN_CODES = ["member_held", "voided", "recipient_not_member", "recipient_unverified"];

type Seal = { approvedAt: string | null; snapshotHash: string | null };

type Problem = { text: string; reload: boolean; newPlan: boolean };

function approveProblem(error: unknown): Problem {
  if (error instanceof ApiError) {
    if (error.code === "hash_mismatch") {
      return { text: "The plan changed since you opened it. Reload it and review it again.", reload: true, newPlan: false };
    }
    if (NEW_PLAN_CODES.includes(error.code)) {
      return { text: reviewProblemText(error.code), reload: false, newPlan: true };
    }
    if (error.status === 429) {
      if (error.code === "over_demo_daily_cap") {
        return {
          text: "The demo has paid out its daily budget across all visitors. Try again tomorrow.",
          reload: false,
          newPlan: false,
        };
      }
      return { text: limitLine(minutesFor(error)), reload: false, newPlan: false };
    }
  }
  return { text: "The approval didn't go through. Try again.", reload: false, newPlan: false };
}

type NotesState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "done"; line: string }
  | { kind: "failed"; line: string };

function notesFailure(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) return limitLine(minutesFor(error));
  return "The notes didn't come through. The template still works.";
}

function PlaceholderRows({ still }: { still: boolean }) {
  return (
    <ul role="list" aria-hidden="true" className="mt-10 border-t border-rule">
      {Array.from({ length: PLACEHOLDER_ROWS }, (_, i) => (
        <li key={i} className="border-b border-rule py-4">
          <motion.div
            className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-3 md:grid-cols-[48px_220px_minmax(0,1fr)_120px] md:gap-y-0"
            initial={{ opacity: still ? 0.6 : 0.4 }}
            animate={still ? { opacity: 0.6 } : { opacity: [0.4, 0.8, 0.4] }}
            transition={still ? { duration: 0 } : { duration: 1.2, ease: "easeInOut", repeat: Infinity, delay: i * 0.08 }}
          >
            <span className="h-[10px] w-[24px] rounded-[2px] bg-bone/8 md:col-start-1" />
            <span className="col-span-2 row-start-2 md:col-span-1 md:col-start-2 md:row-start-1">
              <svg viewBox="0 0 220 14" fill="none" className="block h-auto w-full md:h-[14px] md:w-[220px]">
                <path d="M0 7H220" className="stroke-bone/8" strokeWidth="1.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              </svg>
            </span>
            <span className="col-span-2 row-start-3 h-[14px] w-48 max-w-full rounded-[2px] bg-bone/8 md:col-span-1 md:col-start-3 md:row-start-1" />
            <span className="col-start-2 row-start-1 h-[14px] w-16 rounded-[2px] bg-bone/8 md:col-start-4" />
          </motion.div>
        </li>
      ))}
    </ul>
  );
}

/** The fingerprint types in from the left. Every character is always in the page, so nothing shifts and screen readers get all of it. */
function TypedFingerprint({ text, still }: { text: string; still: boolean }) {
  const [typed, setTyped] = useState(0);
  const shown = still ? text.length : typed;

  useEffect(() => {
    if (still) return;
    const timer = setInterval(() => {
      setTyped((count) => {
        if (count + 1 >= text.length) clearInterval(timer);
        return Math.min(count + 1, text.length);
      });
    }, TYPE_IN_MS / text.length);
    return () => clearInterval(timer);
  }, [still, text]);

  return (
    <p className="mt-2 font-mono text-[12px] text-bone-dim">
      fingerprint <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {Array.from(text).map((char, i) => (
          <span key={i} style={{ opacity: i < shown ? 1 : 0 }}>
            {char}
          </span>
        ))}
      </span>
    </p>
  );
}

function SealPanel({ seal, still, onSend }: { seal: Seal; still: boolean; onSend: () => void }) {
  const send = useRef<HTMLButtonElement>(null);
  const clock = seal.approvedAt === null ? null : localClock(seal.approvedAt);

  useEffect(() => {
    send.current?.focus({ preventScroll: true });
  }, []);

  return (
    <motion.div
      className="mt-6 rounded-[8px] border border-rule bg-ink-raised p-6"
      initial={still ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE }}
    >
      <p className="flex items-center gap-3 text-[15px] text-bone">
        <motion.span
          className="flex"
          initial={still ? false : { scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 500, damping: 22, delay: still ? 0 : 0.2 }}
        >
          <StitchedThread />
        </motion.span>
        {clock === null ? "Approved" : `Approved at ${clock}`}
      </p>
      {seal.snapshotHash !== null && <TypedFingerprint text={shortHash(seal.snapshotHash)} still={still} />}
      <button
        ref={send}
        type="button"
        onClick={onSend}
        className={`${PRIMARY_BUTTON} mt-6 h-12 px-[22px] text-[15px] ${FOCUS_RING}`}
      >
        Send it with PayPal
      </button>
    </motion.div>
  );
}

type ApproveStepProps = {
  api: ConsoleApi;
  campaignId: string;
  onNewPlan: () => void;
  onSend: () => void;
};

export function ApproveStep({ api, campaignId, onNewPlan, onSend }: ApproveStepProps) {
  const still = useStill();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [notes, setNotes] = useState<NotesState>({ kind: "idle" });
  const [seal, setSeal] = useState<Seal | null>(null);
  const [approving, setApproving] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const controller = useRef<AbortController | null>(null);
  const notesElapsed = useElapsedSeconds(notes.kind === "pending");

  useEffect(() => {
    const mine = new AbortController();
    controller.current = mine;
    api
      .view(campaignId, { signal: mine.signal })
      .then((view) => {
        if (!mine.signal.aborted) setLoad({ kind: "ready", view });
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

  const retryLoad = useCallback(() => {
    setLoad({ kind: "loading" });
    setAttempt((current) => current + 1);
  }, []);

  // Fetches the campaign again and swaps it in place. Returns false when it could not be read.
  const refresh = useCallback(async (): Promise<boolean> => {
    const signal = controller.current?.signal;
    try {
      const view = await api.view(campaignId, { signal });
      if (signal?.aborted) return false;
      setLoad({ kind: "ready", view });
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404 && !signal?.aborted) onNewPlan();
      return false;
    }
  }, [api, campaignId, onNewPlan]);

  const view = load.kind === "ready" ? load.view : null;
  const rewards = view?.rows.filter((row) => row.role === "reward") ?? [];
  const heldBack = view?.rows.filter((row) => row.role === "holdout") ?? [];
  const rewardTotal = rewards.reduce((sum, row) => sum + (row.amountMinor ?? 0), 0);
  const open = view !== null && OPEN_STATUSES.includes(view.status);
  const voided = view !== null && view.status === "voided";
  const sealed: Seal | null = seal ?? (view !== null && !open && !voided ? { approvedAt: null, snapshotHash: null } : null);

  async function writeNotes() {
    const signal = controller.current?.signal;
    setNotes({ kind: "pending" });
    try {
      const result = await api.writeNotes(campaignId, { signal });
      if (signal?.aborted) return;
      await refresh();
      if (result.ai === "no_key") {
        setNotes({ kind: "done", line: "Claude isn't available on this server, so the template stays." });
        return;
      }
      const extra =
        result.template > 0 || result.skipped > 0
          ? ` · ${result.template} kept the template · ${result.skipped} skipped`
          : "";
      setNotes({ kind: "done", line: `Claude wrote ${plural(result.written, "note", "notes")}${extra}` });
    } catch (error) {
      if (signal?.aborted) return;
      setNotes({ kind: "failed", line: notesFailure(error) });
    }
  }

  async function approve() {
    if (view === null || view.reviewHash === null) return;
    const signal = controller.current?.signal;
    setApproving(true);
    setProblem(null);
    try {
      const approved = await api.approve(campaignId, view.reviewHash, { signal });
      if (signal?.aborted) return;
      setSeal({ approvedAt: approved.approvedAt, snapshotHash: approved.snapshotHash });
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof ApiError && error.code === "approved_before") {
        await refresh();
        setSeal({ approvedAt: null, snapshotHash: null });
      } else {
        setProblem(approveProblem(error));
      }
    }
    setApproving(false);
  }

  async function reload() {
    setProblem(null);
    const read = await refresh();
    if (!read) setProblem({ text: "The plan didn't load. Try again.", reload: true, newPlan: false });
  }

  const notesPending = notes.kind === "pending";
  const canApprove = open && view !== null && view.reviewHash !== null && view.reviewProblem === null && !approving && !notesPending;

  return (
    <section aria-labelledby="approve-title" aria-busy={load.kind === "loading"}>
      <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-bone-faint">Step 3 &middot; Approve</p>

      {view !== null ? (
        <>
          <h1 id="approve-title" className="poster-title mt-4 text-[40px] text-bone md:text-[56px]" style={{ lineHeight: 0.9 }}>
            {rewards.length} {rewards.length === 1 ? "gets" : "get"} cashback. {heldBack.length}{" "}
            {heldBack.length === 1 ? "is" : "are"} held back.
          </h1>
          <p className="mt-5 max-w-[60ch] text-[16px] leading-[1.55] text-bone-dim">
            Read every reward and note. When you approve, Mend freezes this exact plan by its fingerprint, and
            nothing else can be sent.
          </p>

          {open && sealed === null && rewards.length > 0 && notes.kind !== "done" && (
            <div className="mt-8 rounded-[8px] border border-rule p-5">
              {notesPending ? (
                <div role="status">
                  <LoomLine />
                  <p className="mt-4 flex items-center gap-3 text-[14px] leading-[1.5] text-bone-dim">
                    <Spinner />
                    Claude is writing {plural(rewards.length, "note", "notes")}
                  </p>
                  <p className="mt-2 font-mono text-[12px] tabular-nums text-bone-faint">{notesElapsed} s</p>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <p className="max-w-[56ch] text-[15px] leading-[1.5] text-bone">
                      These notes are the shop&apos;s template. Claude can write each customer their own.
                    </p>
                    {notes.kind === "failed" && (
                      <p role="alert" className="mt-2 text-[14px] leading-[1.5] text-bone-dim">
                        {notes.line}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void writeNotes()}
                    className={`rounded-[8px] border border-rule px-4 py-[10px] text-[14px] text-bone transition-colors duration-150 ease-out hover:border-bone-faint hover:bg-ink-raised ${FOCUS_RING}`}
                  >
                    Have Claude write the notes
                  </button>
                </div>
              )}
            </div>
          )}
          {notes.kind === "done" && (
            <p role="status" className="mt-8 font-mono text-[12px] leading-[1.5] text-bone-dim">
              {notes.line}
            </p>
          )}

          <div className="mt-10">
            {view.rows.length === 0 ? (
              <p className="border-t border-rule pt-6 text-[16px] text-bone-dim">This plan has no customers.</p>
            ) : (
              <CampaignThreads rows={view.rows} mode={sealed === null ? "review" : "sealed"} />
            )}
          </div>

          <p className="mt-8 text-[15px] leading-[1.5] text-bone">
            {formatUsd(rewardTotal)} to {plural(rewards.length, "customer", "customers")}. PayPal adds its own fee for each
            payment.
          </p>

          {view.reviewProblem !== null && (
            <NoticePanel action={<TextButton onClick={onNewPlan}>Draft a new plan</TextButton>}>
              {reviewProblemText(view.reviewProblem)}
            </NoticePanel>
          )}
          {voided && (
            <NoticePanel action={<TextButton onClick={onNewPlan}>Draft a new plan</TextButton>}>
              This plan was cancelled and can&apos;t be approved. Draft a new plan.
            </NoticePanel>
          )}

          {problem !== null && (
            <NoticePanel
              action={
                problem.reload ? (
                  <TextButton onClick={() => void reload()}>Reload</TextButton>
                ) : problem.newPlan ? (
                  <TextButton onClick={onNewPlan}>Draft a new plan</TextButton>
                ) : undefined
              }
            >
              {problem.text}
            </NoticePanel>
          )}

          {sealed !== null ? (
            <SealPanel seal={sealed} still={still} onSend={onSend} />
          ) : (
            !voided && (
              <button
                type="button"
                onClick={() => void approve()}
                disabled={!canApprove}
                aria-busy={approving}
                className={`${PRIMARY_BUTTON} mt-6 h-12 gap-2 px-[22px] text-[15px] disabled:translate-y-0 disabled:cursor-default disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:bg-accent ${FOCUS_RING}`}
              >
                {approving ? (
                  <>
                    Sealing the plan
                    <Spinner />
                  </>
                ) : (
                  "Approve this exact plan"
                )}
              </button>
            )
          )}
        </>
      ) : (
        <>
          <h1 id="approve-title" className="sr-only">
            Approve the plan
          </h1>
          {load.kind === "failed" ? (
            <NoticePanel action={load.canRetry ? <TextButton onClick={retryLoad}>Try again</TextButton> : undefined}>{load.text}</NoticePanel>
          ) : (
            <PlaceholderRows still={still} />
          )}
        </>
      )}
    </section>
  );
}
