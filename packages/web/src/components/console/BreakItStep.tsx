"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import type { ConsoleApi } from "./api";
import { AttackThread, type ThreadState } from "./AttackThread";
import {
  ATTACKS,
  RUN_ALL_ORDER,
  summarise,
  type Attack,
  type AttackContext,
  type AttackGroup,
  type AttackId,
  type AttackResult,
} from "./breakit";
import { FOCUS_RING, NoticePanel, PRIMARY_BUTTON, Spinner, TextButton, UNDERLINE_DRAW } from "./ui";

const GROUPS: readonly AttackGroup[] = ["Money", "AI", "Web"];
const DOCS_PATH = "/docs/security/try-to-break-it";
const SENT_STATUSES: readonly string[] = ["submitted", "completed"];

const NEED_MESSAGE: Record<"test-draft" | "sent-campaign", string> = {
  "test-draft": 'Run "Talk Claude into overspending" first: it makes the test draft this one uses.',
  "sent-campaign": "Send a campaign in step 4 first, then come back and send it twice.",
};

const ATTACK_BY_ID = new Map<AttackId, Attack>(ATTACKS.map((attack) => [attack.id, attack]));

type Results = Partial<Record<AttackId, AttackResult>>;

type Inputs = {
  /** The draft "overspend" made, which "tamper" and "unapproved" use. */
  testDraftId: string | null;
  /** A campaign this session already sent, which "twice" uses. */
  sentCampaignId: string | null;
};

function needIsMet(attack: Attack, inputs: Inputs): boolean {
  if (attack.needs === "test-draft") return inputs.testDraftId !== null;
  if (attack.needs === "sent-campaign") return inputs.sentCampaignId !== null;
  return true;
}

// An attack that throws is shown as an error with the real message, never as a crash.
async function execute(attack: Attack, context: AttackContext): Promise<AttackResult> {
  try {
    return await attack.run(context);
  } catch (error) {
    const message = error instanceof Error && error.message !== "" ? error.message : "The attack stopped without a message.";
    return {
      outcome: "error",
      exchange: { sent: "Not known: the attack stopped before it could report what it sent.", answer: message, status: 0, code: null },
      headline: "The attack stopped with an error",
    };
  }
}

function tally(results: Results) {
  let held = 0;
  let notHeld = 0;
  let limited = 0;
  let couldNotRun = 0;
  for (const attack of ATTACKS) {
    const result = results[attack.id];
    if (result === undefined || result.outcome === "error") couldNotRun += 1;
    else if (result.outcome === "held") held += 1;
    else if (result.outcome === "not-held") notHeld += 1;
    else limited += 1;
  }
  return { held, notHeld, limited, couldNotRun };
}

function DocsLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={`group/text inline-flex items-center py-2 font-mono text-[12px] uppercase tracking-[0.14em] text-bone-dim transition-colors duration-200 ease-out hover:text-bone focus-visible:text-bone ${FOCUS_RING}`}
    >
      <span className="relative">
        {children}
        <span
          aria-hidden="true"
          className={`${UNDERLINE_DRAW} group-hover/text:scale-x-100 group-focus-visible/text:scale-x-100`}
        />
      </span>
    </Link>
  );
}

function ExchangeBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-bone-faint">{label}</p>
      <pre className="mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-rule bg-ink-raised p-3 font-mono text-[12px] leading-[1.6] text-bone-dim [overflow-wrap:anywhere]">
        {text}
      </pre>
    </div>
  );
}

function CrossedStitch() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" className="shrink-0">
      <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" className="stroke-accent" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ResultBlock({ attack, result }: { attack: Attack; result: AttackResult }) {
  const held = result.outcome === "held";
  return (
    <>
      <p className="mt-4 flex items-center gap-2 text-[15px]">
        {held ? (
          <CrossedStitch />
        ) : (
          <span aria-hidden="true" className="block h-[6px] w-[6px] shrink-0 rounded-full border border-bone-faint" />
        )}
        <span className={held ? "text-bone" : "text-bone-dim"}>{summarise(result)}</span>
      </p>

      {result.outcome === "not-held" && (
        <NoticePanel>
          This one was not refused. The real answer is below. If you see this, Mend has a bug, and we want to know.
        </NoticePanel>
      )}

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <ExchangeBlock label="Sent" text={result.exchange.sent} />
        <ExchangeBlock label="Answer" text={result.exchange.answer} />
      </div>

      {held && (
        <p className="mt-4 flex items-start gap-3 text-[14px] leading-[1.5] text-bone">
          <span aria-hidden="true" className="mt-[7px] h-[6px] w-[6px] shrink-0 rounded-full bg-accent" />
          {attack.stoppedBy}
        </p>
      )}

      <div className="mt-2">
        <DocsLink href={`${DOCS_PATH}#${attack.group.toLowerCase()}`}>How this is tested</DocsLink>
      </div>
    </>
  );
}

type AttackCardProps = {
  attack: Attack;
  running: boolean;
  result: AttackResult | undefined;
  needMet: boolean;
  locked: boolean;
  onRun: () => void;
};

function AttackCard({ attack, running, result, needMet, locked, onRun }: AttackCardProps) {
  const thread: ThreadState = running ? "running" : (result?.outcome ?? "idle");
  const needMessage = attack.needs === "nothing" ? null : NEED_MESSAGE[attack.needs];

  return (
    <li className="-mx-3 grid grid-cols-1 gap-y-4 rounded-[8px] border-b border-rule px-3 py-7 transition-colors duration-150 ease-out hover:bg-ink-raised/40 md:grid-cols-[200px_minmax(0,1fr)] md:gap-x-10">
      <div>
        <AttackThread state={thread} />
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <h3 className="font-sans text-[17px] font-semibold text-bone">{attack.title}</h3>
          <span title={result === undefined ? undefined : attack.costNote}>
            <TextButton mono onClick={onRun} disabled={running || locked || !needMet}>
              {running ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner />
                  Running
                </span>
              ) : result === undefined ? (
                "Run it"
              ) : (
                "Run again"
              )}
            </TextButton>
          </span>
        </div>

        <p className="mt-1 text-[14px] leading-[1.5] text-bone-dim">{attack.tries}</p>
        <p className="mt-1 font-mono text-[11px] text-bone-faint">{attack.costNote}</p>

        {!needMet && needMessage !== null && <p className="mt-3 text-[13px] text-bone-faint">{needMessage}</p>}

        <div aria-live="polite">{result !== undefined && <ResultBlock attack={attack} result={result} />}</div>
      </div>
    </li>
  );
}

type BreakItStepProps = {
  api: ConsoleApi;
  campaignId: string | null;
  onBack: () => void;
};

export function BreakItStep({ api, campaignId, onBack }: BreakItStepProps) {
  const [results, setResults] = useState<Results>({});
  const [running, setRunning] = useState<ReadonlySet<AttackId>>(() => new Set());
  const [inputs, setInputs] = useState<Inputs>({ testDraftId: null, sentCampaignId: null });
  const [runAllActive, setRunAllActive] = useState(false);
  const [progress, setProgress] = useState(0);
  const [ranAll, setRanAll] = useState(false);

  // The run-all loop reads these between awaits, where the values in a render's closure are already old.
  const inputsRef = useRef(inputs);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const updateInputs = useCallback((patch: Partial<Inputs>) => {
    inputsRef.current = { ...inputsRef.current, ...patch };
    setInputs(inputsRef.current);
  }, []);

  // Only a campaign the server itself calls submitted or completed counts as sent. Any other answer leaves it empty.
  useEffect(() => {
    if (campaignId === null) return;
    let current = true;
    api
      .view(campaignId)
      .then((view) => {
        if (current && SENT_STATUSES.includes(view.status)) updateInputs({ sentCampaignId: campaignId });
      })
      .catch(() => {
        // No answer means "twice" stays locked, which is the honest state when the campaign cannot be read.
      });
    return () => {
      current = false;
    };
  }, [api, campaignId, updateInputs]);

  const setRunningFlag = useCallback((id: AttackId, on: boolean) => {
    setRunning((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const runAttack = useCallback(
    async (attack: Attack): Promise<void> => {
      setRunningFlag(attack.id, true);
      setResults((previous) => ({ ...previous, [attack.id]: undefined }));
      const context: AttackContext = {
        api,
        fetchFn: window.fetch.bind(window),
        testDraftId: inputsRef.current.testDraftId,
        sentCampaignId: inputsRef.current.sentCampaignId,
      };
      const result = await execute(attack, context);
      if (!aliveRef.current) return;
      if (result.testDraftId !== undefined) updateInputs({ testDraftId: result.testDraftId });
      setResults((previous) => ({ ...previous, [attack.id]: result }));
      setRunningFlag(attack.id, false);
    },
    [api, setRunningFlag, updateInputs],
  );

  const runEvery = useCallback(async () => {
    setResults({});
    setRanAll(false);
    setRunAllActive(true);
    for (const [index, id] of RUN_ALL_ORDER.entries()) {
      if (!aliveRef.current) return;
      const attack = ATTACK_BY_ID.get(id);
      setProgress(index + 1);
      if (attack === undefined || !needIsMet(attack, inputsRef.current)) continue;
      await runAttack(attack);
    }
    if (!aliveRef.current) return;
    setProgress(0);
    setRunAllActive(false);
    setRanAll(true);
  }, [runAttack]);

  const anyRunning = runAllActive || running.size > 0;
  const counts = tally(results);

  return (
    <section aria-labelledby="breakit-title">
      <div className="md:flex md:items-start md:justify-between md:gap-6">
        <div>
          <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-bone-faint">Step 6 &middot; Break it</p>
          <h1 id="breakit-title" className="poster-title mt-4 text-[40px] text-bone md:text-[56px]" style={{ lineHeight: 0.9 }}>
            Try to break it.
          </h1>
        </div>
        <div className="mt-3 md:-mt-2 md:shrink-0">
          <TextButton mono onClick={onBack}>
            Back to the demo
          </TextButton>
        </div>
      </div>
      <p className="mt-5 max-w-[60ch] text-[16px] leading-[1.55] text-bone-dim">
        Each attack sends a real request from your browser to the live app, and you see exactly what came back. Nothing
        here is staged, and nothing you try here can move money.
      </p>
      <p className="mt-2 font-mono text-[12px] text-bone-faint">
        Eleven attacks &middot; each one is real &middot; results stay in this tab
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
        <button
          type="button"
          onClick={runEvery}
          disabled={anyRunning}
          aria-busy={runAllActive}
          className={`${PRIMARY_BUTTON} h-12 gap-2 px-[22px] text-[15px] disabled:translate-y-0 disabled:cursor-default disabled:hover:translate-y-0 disabled:hover:bg-accent ${runAllActive ? "" : "disabled:opacity-50"} ${FOCUS_RING}`}
        >
          {runAllActive ? (
            <>
              <Spinner />
              {`Running ${progress} of ${RUN_ALL_ORDER.length}`}
            </>
          ) : (
            "Run every attack"
          )}
        </button>
        <DocsLink href={DOCS_PATH}>How each is tested</DocsLink>
        {ranAll && !anyRunning && (
          <p className="w-full font-mono text-[12px] text-bone-dim">
            {counts.held} held &middot; {counts.notHeld} not held &middot; {counts.limited} stopped by the rate limit
            &middot; {counts.couldNotRun} could not run
          </p>
        )}
      </div>

      {GROUPS.map((group) => {
        const attacks = ATTACKS.filter((attack) => attack.group === group);
        const headingId = group.toLowerCase();
        return (
          <section key={group} aria-labelledby={headingId} className="mt-14">
            <div className="flex items-baseline justify-between border-b border-rule pb-3">
              <h2 id={headingId} className="font-mono text-[12px] uppercase tracking-[0.14em] text-bone-faint">
                {group}
              </h2>
              <span className="font-mono text-[12px] text-bone-faint">{`${attacks.length} attacks`}</span>
            </div>
            <ul role="list">
              {attacks.map((attack) => (
                <AttackCard
                  key={attack.id}
                  attack={attack}
                  running={running.has(attack.id)}
                  result={results[attack.id]}
                  needMet={needIsMet(attack, inputs)}
                  locked={runAllActive}
                  onRun={() => void runAttack(attack)}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
