"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useStill } from "@/components/motion/useStill";
import { ApiError, type ConsoleApi, type Draft } from "./api";
import { formatShare, formatUsd, plural } from "./money";
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

const GOAL_LIMIT = 500;
// Above this the form says Claude will lower the budget. The request still goes, and the server clamps it.
const BUDGET_LIMIT_DOLLARS = 1000;
const OVER_BUDGET_HINT = "The demo pays at most a small budget; Claude will lower it to the demo's cap.";
const PLACEHOLDER = "Bring back my quiet regulars with a small thank-you";
const SUGGESTIONS = [
  "Win back my best lapsed regulars with 10 dollars",
  "A small thank-you to five quiet regulars, 2 dollars each",
  "Bring back customers silent for over three months, 10 dollars in total",
] as const;

const LABEL = "font-mono text-[12px] uppercase tracking-[0.14em] text-ink-dim";

const FIELD =
  "rounded-[14px] border-2 border-ink/20 bg-paper-raised px-4 py-[14px] text-[17px] text-ink placeholder:text-ink-faint focus:border-accent";

function limitMinutes(error: ApiError): number | null {
  return error.retryAfterSeconds === null ? null : Math.max(1, Math.ceil(error.retryAfterSeconds / 60));
}

type Failure = { kind: "limit"; minutes: number | null } | { kind: "busy" } | { kind: "other" };

function failureFor(error: unknown): Failure {
  if (error instanceof ApiError) {
    if (error.status === 429) return { kind: "limit", minutes: limitMinutes(error) };
    if (error.status === 503 || error.code === "still_running") return { kind: "busy" };
  }
  return { kind: "other" };
}

function failureText(failure: Failure): string {
  switch (failure.kind) {
    case "limit":
      return failure.minutes === null
        ? "This session has used its plans for now."
        : `This session has drafted the most plans allowed. Try again in ${failure.minutes} min.`;
    case "busy":
      return "The engine is busy. Try again in a moment.";
    case "other":
      return "The plan didn't come through. Try again.";
  }
}

type Outcome =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "drafted"; draft: Draft }
  | { kind: "needs_budget"; message: string }
  | { kind: "failed"; failure: Failure };

function ThreadGlyph() {
  return (
    <svg width="16" height="6" viewBox="0 0 16 6" fill="none" aria-hidden="true" className="mt-[9px] shrink-0">
      <path d="M0 3H16" className="stroke-ink/40" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PlanPanel({ draft, still, onReview }: { draft: Draft; still: boolean; onReview: () => void }) {
  const settings = draft.plan?.settings ?? null;
  const changes = draft.plan?.changes ?? [];
  const panel = useRef<HTMLDivElement>(null);

  // The plan lands under the goal form, below the fold on most screens; "nearest" brings its button into view.
  useEffect(() => {
    panel.current?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "nearest" });
  }, [still]);

  return (
    <motion.div
      ref={panel}
      className="patch mt-8 p-7"
      initial={still ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE }}
    >
      <p className={LABEL}>Claude&apos;s plan</p>

      {settings !== null && (
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 xl:grid-cols-4">
          <Figure label="Budget">{formatUsd(settings.budgetMinor)}</Figure>
          <Figure label="Per customer">{formatUsd(settings.perRecipientMinor)}</Figure>
          <Figure label="Held back">{formatShare(settings.holdoutShare)}</Figure>
          <Figure label="Considered">{settings.maxCandidates}</Figure>
        </dl>
      )}

      {changes.length > 0 && (
        <div className="mt-6">
          <p className={LABEL}>What Claude adjusted</p>
          <ul role="list" className="mt-3 flex flex-col gap-2">
            {changes.map((change) => (
              <li key={change} className="flex items-start gap-3 text-[14px] leading-[1.5] text-ink-dim">
                <ThreadGlyph />
                {change}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-4 text-[15px] leading-[1.5] text-ink">
        {plural(draft.rewarded, "customer", "customers")} {draft.rewarded === 1 ? "gets" : "get"} cashback,{" "}
        {draft.heldBack} {draft.heldBack === 1 ? "is" : "are"} held back, {formatUsd(draft.totalMinor)} in total.
      </p>

      <button
        type="button"
        onClick={onReview}
        className={`${PRIMARY_BUTTON} mt-6 h-12 px-[22px] text-[15px] ${FOCUS_RING}`}
      >
        Review the plan
      </button>
    </motion.div>
  );
}

function Arrow() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      className="transition-transform duration-150 ease-out group-hover/primary:translate-x-[3px]"
    >
      <path d="M3 7h8M8 3.5 11.5 7 8 10.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type PlanStepProps = {
  api: ConsoleApi;
  onDrafted: (campaignId: string) => void;
  onReview: () => void;
};

export function PlanStep({ api, onDrafted, onReview }: PlanStepProps) {
  const still = useStill();
  const [goal, setGoal] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const [budget, setBudget] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const budgetInput = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const pending = outcome.kind === "pending";
  const elapsed = useElapsedSeconds(pending);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (outcome.kind === "needs_budget") budgetInput.current?.focus();
  }, [outcome]);

  const draftPlan = useCallback(async () => {
    const text = goal.trim();
    if (text === "") return;
    const dollars = budget.trim() === "" ? null : Number(budget);
    // The browser's own check (min 1, whole dollars) tells the person what is wrong with the field.
    if (dollars !== null && (!Number.isInteger(dollars) || dollars < 1)) return;
    controller.current?.abort();
    const mine = new AbortController();
    controller.current = mine;
    setOutcome({ kind: "pending" });
    try {
      const draft = await api.plan(text, {
        signal: mine.signal,
        // The route refuses more than 100,000,000 cents; the demo's own cap is far lower and Claude clamps to it.
        ...(dollars === null ? {} : { budgetMinor: Math.min(dollars, 1_000_000) * 100 }),
      });
      if (mine.signal.aborted) return;
      onDrafted(draft.campaignId);
      setOutcome({ kind: "drafted", draft });
    } catch (error) {
      if (mine.signal.aborted) return;
      if (error instanceof ApiError && error.code === "needs_budget") {
        setOutcome({ kind: "needs_budget", message: error.message });
        return;
      }
      setOutcome({ kind: "failed", failure: failureFor(error) });
    }
  }, [api, budget, goal, onDrafted]);

  function suggest(text: string) {
    setGoal(text);
    textarea.current?.focus();
  }

  const notice = outcome.kind === "drafted" ? (outcome.draft.plan?.notice ?? null) : null;
  const overLimit = budget.trim() !== "" && Number(budget) > BUDGET_LIMIT_DOLLARS;

  return (
    <section aria-labelledby="plan-title" aria-busy={pending}>
      <StepHeader
        tint="butter"
        kicker="Step 2 · Plan"
        titleId="plan-title"
        title="Ask Claude for a plan."
        icon="/world/icons/plan.webp"
      >
        <p className="mt-5 max-w-[60ch] text-[16px] leading-[1.55] text-ink-dim">
          Describe what you want in plain words. Claude turns it into a budget and a reward size within the
          demo&apos;s caps, then Mend&apos;s engine picks the customers and holds a random group back.
        </p>
      </StepHeader>

      <form
        className="patch p-7"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending) void draftPlan();
        }}
      >
        <label htmlFor="plan-goal" className={LABEL}>
          Your goal
        </label>
        <textarea
          id="plan-goal"
          ref={textarea}
          rows={3}
          maxLength={GOAL_LIMIT}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder={PLACEHOLDER}
          className={`mt-2 w-full resize-y ${FIELD} ${FOCUS_RING}`}
        />
        <p className="mt-2 text-right font-mono text-[11px] tabular-nums text-ink-faint">
          {goal.length} / {GOAL_LIMIT}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTIONS.map((text) => (
            <button
              key={text}
              type="button"
              onClick={() => suggest(text)}
              className={`min-h-[38px] rounded-[10px] border-[1.5px] border-dashed border-ink/30 bg-pale-sky px-[14px] py-[9px] text-left text-[15px] leading-5 text-ink transition-colors duration-150 ease-out hover:bg-felt-sky ${FOCUS_RING}`}
            >
              {text}
            </button>
          ))}
        </div>
        <div className="mt-6">
          <label htmlFor="plan-budget" className={`block ${LABEL}`}>
            Budget, USD (optional)
          </label>
          <input
            id="plan-budget"
            ref={budgetInput}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
            aria-describedby={overLimit ? "plan-budget-hint" : undefined}
            className={`mt-2 w-[140px] tabular-nums ${FIELD} ${FOCUS_RING}`}
          />
          {overLimit && (
            <p id="plan-budget-hint" className="mt-2 max-w-[300px] text-[14px] leading-[1.5] text-ink-dim">
              {OVER_BUDGET_HINT}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={goal.trim() === "" || pending}
          aria-busy={pending}
          className={`group/primary ${PRIMARY_BUTTON} mt-6 h-12 px-[22px] text-[15px] ${FOCUS_RING}`}
        >
          {pending ? (
            <>
              Drafting
              <Spinner />
            </>
          ) : (
            <>
              Draft the plan
              <Arrow />
            </>
          )}
        </button>
      </form>

      <div aria-live="polite">
        {outcome.kind === "pending" && (
          <div className="patch mt-6 p-7">
            <LoomLine />
            <p className="mt-4 text-[14px] leading-[1.5] text-ink-dim">
              Claude reads your goal, then Mend&apos;s engine picks the customers and holds a random group back.
            </p>
            <p className="mt-2 font-mono text-[12px] tabular-nums text-ink-faint">{elapsed} s</p>
          </div>
        )}

        {outcome.kind === "needs_budget" && (
          <NoticePanel>
            <span className="block">
              <span className="block">{outcome.message}</span>
              <span className="mt-2 block text-ink-dim">Add an amount to your goal, or fill in the budget.</span>
            </span>
          </NoticePanel>
        )}

        {outcome.kind === "failed" && (
          <NoticePanel
            alert
            action={outcome.failure.kind === "busy" ? <TextButton onClick={() => void draftPlan()}>Try again</TextButton> : undefined}
          >
            {failureText(outcome.failure)}
          </NoticePanel>
        )}

        {outcome.kind === "drafted" && (
          <>
            {notice !== null && <NoticePanel alert={false}>{notice}</NoticePanel>}
            <PlanPanel draft={outcome.draft} still={still} onReview={onReview} />
          </>
        )}
      </div>
    </section>
  );
}
