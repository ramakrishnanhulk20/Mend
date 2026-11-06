"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { useStill } from "@/components/motion/useStill";
import { ApproveStep } from "./ApproveStep";
import { createConsoleApi } from "./api";
import { AskPanel } from "./AskPanel";
import { BreakItStep } from "./BreakItStep";
import { PayoutStep } from "./PayoutStep";
import { PlanStep } from "./PlanStep";
import { RegularsStep } from "./RegularsStep";
import { ResultsStep } from "./ResultsStep";
import { ShopCard } from "./ShopCard";
import { StartStep } from "./StartStep";
import { stepFromQuery } from "./steps";
import { StepProgress, type Step } from "./StepRail";
import { TopBar, type SessionInfo } from "./TopBar";
import { EASE, FOCUS_RING } from "./ui";

const STEP_KEY = "mend-console-step";
const CAMPAIGN_KEY = "mend-console-campaign";
const ENDED_NOTICE = "Your demo session ended. Start a new one to carry on.";
const ASK_VISIBLE_RATIO = 0.15;

// Steps that need a drafted plan fall back to drafting one when a reload finds none.
const NEEDS_CAMPAIGN: readonly Step[] = ["approve", "payout", "results"];
const BUILT_STEPS: readonly Step[] = [
  "regulars",
  "plan",
  "approve",
  "payout",
  "results",
  "breakit",
];

// Private browsing and blocked storage throw on access, and the console works without it.
function readSaved(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSaved(key: string, value: string | null) {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // Nothing to do: the console just starts at the first step after a reload.
  }
}

function readSavedStep(): Step | null {
  const saved = readSaved(STEP_KEY);
  return BUILT_STEPS.find((step) => step === saved) ?? null;
}

function saveStep(step: Step) {
  if (BUILT_STEPS.includes(step)) writeSaved(STEP_KEY, step);
}

export function Console() {
  const still = useStill();
  const [checked, setChecked] = useState(false);
  const [step, setStep] = useState<Step>("start");
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  // The PayPal order this session simulated on the results step. It belongs to the session, so a
  // new plan keeps it and only a new or ended session clears it.
  const [orderId, setOrderId] = useState<string | null>(null);
  const [askRequest, setAskRequest] = useState(0);
  const [askOnScreen, setAskOnScreen] = useState(false);
  const signedIn = session !== null;
  // The step "Back to the demo" returns to. "start" never counts: with a session open there is nothing to go back to there.
  const lastJourneyStep = useRef<Step>("regulars");
  // null until the address bar has been read. A ref, not state, because strict mode runs the mount effect twice and
  // the first run has already cleared the query by the time the second one looks.
  const openBreakIt = useRef<boolean | null>(null);

  const goTo = useCallback((next: Step) => {
    setStep(next);
    saveStep(next);
  }, []);

  useEffect(() => {
    if (step !== "breakit" && step !== "start") lastJourneyStep.current = step;
  }, [step]);

  const forgetEverything = useCallback(() => {
    writeSaved(STEP_KEY, null);
    writeSaved(CAMPAIGN_KEY, null);
    setCampaignId(null);
    setOrderId(null);
  }, []);

  const sessionEnded = useCallback(() => {
    forgetEverything();
    setSession(null);
    setStep("start");
    setNotice(ENDED_NOTICE);
  }, [forgetEverything]);

  // Any step's request that comes back 401 lands here: one place for every step. sessionEnded
  // only uses setters that never change, so the first one is the one to keep.
  const [api] = useState(() =>
    createConsoleApi(undefined, { onUnauthorized: sessionEnded }),
  );

  useEffect(() => {
    // A link such as /demo?step=break-it asks for Break it. The query goes at once so a reload does not repeat it.
    if (openBreakIt.current === null) {
      openBreakIt.current = stepFromQuery(window.location.search) === "breakit";
      if (openBreakIt.current) window.history.replaceState(null, "", "/demo");
    }

    let current = true;
    api
      .session()
      .then((answer) => {
        if (!current) return;
        if (answer.signedIn && answer.role === "demo") {
          const campaign = readSaved(CAMPAIGN_KEY);
          const saved = readSavedStep() ?? "regulars";
          setSession({ expiresAt: answer.expiresAt });
          setCampaignId(campaign);
          if (openBreakIt.current) {
            openBreakIt.current = false;
            goTo("breakit");
          } else {
            setStep(
              NEEDS_CAMPAIGN.includes(saved) && campaign === null
                ? "plan"
                : saved,
            );
          }
        }
        setChecked(true);
      })
      .catch(() => {
        if (current) setChecked(true);
      });
    return () => {
      current = false;
    };
  }, [api, goTo]);

  // The Ask Mend shortcut steps aside while the panel (toggle included) is on screen.
  useEffect(() => {
    if (!signedIn) return;
    const panel = document.getElementById("ask-mend");
    if (panel === null) return;
    const observer = new IntersectionObserver(
      ([entry]) => setAskOnScreen(entry.intersectionRatio >= ASK_VISIBLE_RATIO),
      { threshold: ASK_VISIBLE_RATIO },
    );
    observer.observe(panel);
    return () => observer.disconnect();
  }, [signedIn]);

  const started = useCallback(
    (expiresAt: string) => {
      setNotice(null);
      setSession({ expiresAt });
      forgetEverything();
      const next: Step = openBreakIt.current ? "breakit" : "regulars";
      openBreakIt.current = false;
      goTo(next);
    },
    [forgetEverything, goTo],
  );

  const endSession = useCallback(async () => {
    setEnding(true);
    try {
      await api.logout();
    } catch {
      // Either way this browser is done with the session; starting again replaces any leftover one.
    }
    forgetEverything();
    setSession(null);
    setStep("start");
    setNotice(null);
    setEnding(false);
  }, [api, forgetEverything]);

  // The plan is saved the moment it is drafted, so a reload while reading it lands on the approve step.
  const drafted = useCallback((id: string) => {
    setCampaignId(id);
    writeSaved(CAMPAIGN_KEY, id);
    writeSaved(STEP_KEY, "approve");
  }, []);

  const newPlan = useCallback(() => {
    writeSaved(CAMPAIGN_KEY, null);
    setCampaignId(null);
    goTo("plan");
  }, [goTo]);

  const toPlan = useCallback(() => goTo("plan"), [goTo]);
  const toApprove = useCallback(() => goTo("approve"), [goTo]);
  const toPayout = useCallback(() => goTo("payout"), [goTo]);
  const toResults = useCallback(() => goTo("results"), [goTo]);

  // The rail has the Break it item from lg up and the phone progress line has the button below it. Both need a session to open it in.
  const toBreakIt = session !== null ? () => goTo("breakit") : undefined;

  function renderStep() {
    if (step === "regulars") return <RegularsStep api={api} onPlan={toPlan} />;
    if (step === "approve" && campaignId !== null) {
      return (
        <ApproveStep
          api={api}
          campaignId={campaignId}
          onNewPlan={newPlan}
          onSend={toPayout}
        />
      );
    }
    if (step === "payout" && campaignId !== null) {
      return (
        <PayoutStep
          api={api}
          campaignId={campaignId}
          onNewPlan={newPlan}
          onResults={toResults}
        />
      );
    }
    if (step === "results" && campaignId !== null) {
      return (
        <ResultsStep api={api} campaignId={campaignId} onNewPlan={newPlan} onOrder={setOrderId} />
      );
    }
    if (step === "breakit") {
      return (
        <BreakItStep
          api={api}
          campaignId={campaignId}
          sessionKey={session?.expiresAt ?? null}
          onBack={() => goTo(lastJourneyStep.current)}
        />
      );
    }
    if (step === "plan" || NEEDS_CAMPAIGN.includes(step)) {
      return <PlanStep api={api} onDrafted={drafted} onReview={toApprove} />;
    }
    return <StartStep api={api} notice={notice} onStarted={started} />;
  }

  return (
    <MotionConfig reducedMotion="user">
      {/* Below lg the Ask Mend shortcut floats over the bottom corner, so the page ends far enough down to clear it. */}
      <div className="min-h-svh bg-paper pb-20 text-ink lg:pb-0">
        <TopBar
          step={step}
          session={session}
          ending={ending}
          onEnd={endSession}
          onBreakIt={toBreakIt}
        />
        <StepProgress step={step} onBreakIt={toBreakIt} />

        <div className="mx-auto max-w-[1440px] px-4 pb-10 pt-7 md:px-8">
          <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-8">
            {/* Below lg the aside steps aside (contents) so the shop card sits first and the Ask panel last, under the step.
                From lg up it scrolls inside itself when shop card and a long chat are taller than the screen, so the box to type in is never out of reach.
                The padding with the matching negative margin leaves room inside the scroll box for the patches' shadows. */}
            <aside className="contents lg:-mx-6 lg:-mb-[56px] lg:-mt-6 lg:block lg:order-last lg:sticky lg:top-[72px] lg:max-h-[calc(100svh-5.5rem)] lg:self-start lg:overflow-y-auto lg:px-6 lg:pb-[56px] lg:pt-6 lg:[scrollbar-color:var(--color-ink-faint)_transparent] lg:[scrollbar-width:thin]">
              <ShopCard />
              {session !== null && <AskPanel api={api} orderId={orderId} openRequest={askRequest} />}
            </aside>

            <main id="main" className="min-w-0">
              {/* The next step starts at its own top; the jump happens while neither step is on screen. */}
              <AnimatePresence mode="wait" onExitComplete={() => window.scrollTo({ top: 0 })}>
                {checked && (
                  <motion.div
                    key={step}
                    initial={still ? false : { opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={still ? { opacity: 0 } : { opacity: 0, y: -12 }}
                    transition={{ duration: still ? 0 : 0.3, ease: EASE }}
                  >
                    {renderStep()}
                  </motion.div>
                )}
              </AnimatePresence>
            </main>
          </div>
        </div>

        <AnimatePresence>
          {session !== null && step !== "breakit" && !askOnScreen && (
            <motion.button
              key="ask-shortcut"
              type="button"
              onClick={() => setAskRequest((count) => count + 1)}
              className={`fixed bottom-4 right-4 z-30 inline-flex h-11 items-center gap-2 rounded-full border border-rule bg-paper-raised/95 px-4 text-[14px] text-ink shadow-[0_10px_26px_rgb(18_59_63/0.25)] backdrop-blur lg:hidden ${FOCUS_RING}`}
              initial={still ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: still ? 0 : 0.15 } }}
              transition={{ duration: still ? 0 : 0.3, ease: EASE }}
            >
              <span aria-hidden="true" className="h-[6px] w-[6px] rounded-full bg-accent" />
              Ask Mend
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
