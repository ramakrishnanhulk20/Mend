"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { z } from "zod";
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
import { FOCUS_RING, NoticePanel, PRIMARY_BUTTON, Spinner, StepHeader, StitchedThread, TextButton, UNDERLINE_DRAW } from "./ui";

const GROUPS: readonly AttackGroup[] = ["Money", "AI", "Web"];
const DOCS_PATH = "/docs/security/try-to-break-it";
const SENT_STATUSES: readonly string[] = ["submitted", "completed"];
const STORAGE_KEY = "mend-breakit";

const WAITING_MESSAGE: Record<"test-draft" | "sent-campaign", string> = {
  "test-draft": 'Waiting: run "Talk Claude into overspending" first.',
  "sent-campaign": "Waiting: send a campaign in step 4, then come back to this card.",
};

const ATTACK_BY_ID = new Map<AttackId, Attack>(ATTACKS.map((attack) => [attack.id, attack]));

type Results = Partial<Record<AttackId, AttackResult>>;

type Inputs = {
  /** The draft "overspend" made, which "tamper" and "unapproved" use. */
  testDraftId: string | null;
  /** A campaign this session already sent, which "twice" uses. */
  sentCampaignId: string | null;
};

export type SavedRun = {
  results: Results;
  testDraftId: string | null;
  ranAll: boolean;
};

const SavedRunSchema = z.object({
  session: z.string(),
  results: z.record(
    z.string(),
    z.object({
      outcome: z.enum(["held", "not-held", "limited", "error"]),
      exchange: z.object({ sent: z.string(), answer: z.string(), status: z.number(), code: z.string().nullable() }),
      testDraftId: z.string().optional(),
      headline: z.string().optional(),
    }),
  ),
  testDraftId: z.string().nullable(),
  ranAll: z.boolean(),
});

/** Blocked storage (private browsing, a locked-down browser) throws on access, and the page works without it. */
function browserStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The run saved for this demo session. A record left by an older session, a damaged one, or
 * storage that cannot be read all come back as nothing saved, so a visitor never sees
 * results that were not theirs or not real.
 */
export function loadSavedRun(sessionKey: string | null, storage: Pick<Storage, "getItem"> | null): SavedRun | null {
  if (sessionKey === null || storage === null) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = SavedRunSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.session !== sessionKey) return null;
    const results: Results = {};
    for (const attack of ATTACKS) {
      const saved = parsed.data.results[attack.id];
      if (saved !== undefined) results[attack.id] = saved;
    }
    return { results, testDraftId: parsed.data.testDraftId, ranAll: parsed.data.ranAll };
  } catch {
    return null;
  }
}

export function saveRun(sessionKey: string | null, run: SavedRun, storage: Pick<Storage, "setItem"> | null): void {
  if (sessionKey === null || storage === null) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ session: sessionKey, ...run }));
  } catch {
    // Full or blocked storage: the results still show on this page, they just do not survive leaving it.
  }
}

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

type Tally = { held: number; notHeld: number; limited: number; waiting: number; couldNotRun: number };

/** An attack with no result never ran, because it waits on an earlier step. One that ran and errored is counted apart. */
export function tally(results: Results): Tally {
  const counts: Tally = { held: 0, notHeld: 0, limited: 0, waiting: 0, couldNotRun: 0 };
  for (const attack of ATTACKS) {
    const result = results[attack.id];
    if (result === undefined) counts.waiting += 1;
    else if (result.outcome === "error") counts.couldNotRun += 1;
    else if (result.outcome === "held") counts.held += 1;
    else if (result.outcome === "not-held") counts.notHeld += 1;
    else counts.limited += 1;
  }
  return counts;
}

export function runAllSummary(counts: Tally): string {
  const parts = [
    `${counts.held} held`,
    `${counts.notHeld} not held`,
    `${counts.limited} stopped by the rate limit`,
    `${counts.waiting} waiting on an earlier step`,
  ];
  if (counts.couldNotRun > 0) parts.push(`${counts.couldNotRun} could not run`);
  return parts.join(" · ");
}

// Opens in a new tab so the demo tab, with its results on screen, stays where the visitor left it.
function DocsLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener"
      className={`group/text inline-flex items-center py-2 font-mono text-[12px] uppercase tracking-[0.14em] text-ink-dim transition-colors duration-200 ease-out hover:text-ink focus-visible:text-ink ${FOCUS_RING}`}
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

function Label({ children }: { children: ReactNode }) {
  return <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-ink-dim">{children}</p>;
}

function ExchangeBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="min-w-0">
      <Label>{label}</Label>
      <pre className="mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[12px] bg-pale-teal p-4 font-mono text-[13px] leading-[1.6] text-ink [overflow-wrap:anywhere]">
        {text}
      </pre>
    </div>
  );
}

function ResultBlock({ attack, result }: { attack: Attack; result: AttackResult }) {
  const held = result.outcome === "held";
  return (
    <>
      <p className="mt-4 flex items-center gap-2 text-[18px] font-semibold">
        {held ? (
          <StitchedThread />
        ) : (
          <span aria-hidden="true" className="block h-[6px] w-[6px] shrink-0 rounded-full border border-ink-faint" />
        )}
        <span className={held ? "text-ink" : "text-ink-dim"}>{summarise(result)}</span>
      </p>

      {result.outcome === "not-held" && (
        <NoticePanel>
          This one was not refused. The real answer is below. If you see this, Mend has a bug, and we want to know.
        </NoticePanel>
      )}

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <ExchangeBlock label="Sent" text={result.exchange.sent} />
        <ExchangeBlock label="Answer" text={result.exchange.answer} />
      </div>

      {held && (
        <div className="mt-4">
          <Label>What stopped it</Label>
          <p className="mt-2 flex items-start gap-3 text-[14px] leading-[1.5] text-ink">
            <span aria-hidden="true" className="mt-[7px] h-[6px] w-[6px] shrink-0 rounded-full bg-accent" />
            {attack.stoppedBy}
          </p>
        </div>
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

export function AttackCard({ attack, running, result, needMet, locked, onRun }: AttackCardProps) {
  // While the card waits on an earlier step there is nothing to run and nothing to show, so no button and no result.
  const waitingMessage = !needMet && attack.needs !== "nothing" ? WAITING_MESSAGE[attack.needs] : null;
  const shown = waitingMessage === null ? result : undefined;
  const thread: ThreadState = running ? "running" : (shown?.outcome ?? "idle");

  return (
    <li className="patch grid grid-cols-1 gap-y-4 p-7 md:grid-cols-[200px_minmax(0,1fr)] md:gap-x-10 lg:gap-x-6 xl:gap-x-10">
      <div>
        <AttackThread state={thread} />
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <h3 className="font-sans text-[17px] font-semibold text-ink">{attack.title}</h3>
          {waitingMessage === null && (
            <span title={shown === undefined ? undefined : attack.costNote}>
              <TextButton mono onClick={onRun} disabled={running || locked}>
                {running ? (
                  <span className="inline-flex items-center gap-2">
                    <Spinner />
                    Running
                  </span>
                ) : shown === undefined ? (
                  "Run it"
                ) : (
                  "Run again"
                )}
              </TextButton>
            </span>
          )}
        </div>

        <p className="mt-1 text-[14px] leading-[1.5] text-ink-dim">{attack.tries}</p>
        <p className="mt-1 font-mono text-[12px] text-ink-dim">{attack.costNote}</p>

        {waitingMessage === null ? (
          <div aria-live="polite">{shown !== undefined && <ResultBlock attack={attack} result={shown} />}</div>
        ) : (
          <p className="mt-4 text-[14px] text-ink-dim">{waitingMessage}</p>
        )}
      </div>
    </li>
  );
}

type BreakItStepProps = {
  api: ConsoleApi;
  campaignId: string | null;
  /** Names the demo session, so results saved for an older session are never shown in a newer one. */
  sessionKey: string | null;
  onBack: () => void;
};

export function BreakItStep({ api, campaignId, sessionKey, onBack }: BreakItStepProps) {
  // Console mounts this step only in the browser, after it has read the session, so reading storage
  // while choosing the first state cannot differ from what a server render would have drawn.
  const [saved] = useState(() => loadSavedRun(sessionKey, browserStorage()));
  const [results, setResults] = useState<Results>(saved?.results ?? {});
  const [running, setRunning] = useState<ReadonlySet<AttackId>>(() => new Set());
  const [inputs, setInputs] = useState<Inputs>({ testDraftId: saved?.testDraftId ?? null, sentCampaignId: null });
  const [runAllActive, setRunAllActive] = useState(false);
  const [progress, setProgress] = useState(0);
  const [ranAll, setRanAll] = useState(saved?.ranAll ?? false);

  // The run-all loop reads these between awaits, where the values in a render's closure are already old.
  const inputsRef = useRef(inputs);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    saveRun(sessionKey, { results, testDraftId: inputs.testDraftId, ranAll }, browserStorage());
  }, [sessionKey, results, inputs.testDraftId, ranAll]);

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
      <StepHeader
        tint="peach"
        kicker="Step 6 · Break it"
        titleId="breakit-title"
        title="Try to break it."
        icon="/world/icons/breakit.webp"
      >
        <div className="mt-3 md:absolute md:right-11 md:top-[33px] md:mt-0">
          <TextButton mono onClick={onBack}>
            Back to the demo
          </TextButton>
        </div>
        <p className="mt-5 max-w-[60ch] text-[16px] leading-[1.55] text-ink-dim">
          Each attack sends a real request from your browser to the live app, and you see exactly what came back.
          Nothing here is staged, and nothing you try here can move money.
        </p>
        <p className="mt-2 font-mono text-[12px] text-ink-dim">
          Eleven attacks &middot; each one is real &middot; results stay in this tab
        </p>
      </StepHeader>

      <div className="patch p-7">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <button
            type="button"
            onClick={runEvery}
            disabled={anyRunning}
            aria-busy={runAllActive}
            className={`${PRIMARY_BUTTON} h-12 px-[22px] text-[15px] ${runAllActive ? "disabled:opacity-100" : ""} ${FOCUS_RING}`}
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
          {ranAll && !anyRunning && <p className="w-full font-mono text-[12px] text-ink-dim">{runAllSummary(counts)}</p>}
        </div>
        {/* "At least": Mend's assistant makes one Claude call per round, and a round that uses a tool adds another. */}
        <p className="mt-3 font-mono text-[12px] text-ink-dim">
          Running them all uses at least 3 Claude calls and 2 of this session&apos;s 5 drafts a day. Nothing is paid.
        </p>
      </div>

      {GROUPS.map((group) => {
        const attacks = ATTACKS.filter((attack) => attack.group === group);
        const headingId = group.toLowerCase();
        return (
          <section key={group} aria-labelledby={headingId} className="mt-12">
            <div className="flex items-baseline justify-between border-b-[1.5px] border-dashed border-stitch pb-3">
              <h2 id={headingId} className="font-mono text-[13px] uppercase tracking-[0.08em] text-ink-dim">
                {group}
              </h2>
              <span className="font-mono text-[12px] text-ink-dim">{`${attacks.length} attacks`}</span>
            </div>
            <ul role="list" className="mt-4 flex flex-col gap-4">
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
