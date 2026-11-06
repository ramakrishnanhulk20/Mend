"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useShopSummary } from "@/components/live/useShopSummary";
import { dashboardData, sameData, sentResults, type DashboardData, type DashboardInputs } from "@/components/studio/dashboard-data";
import { dashboardReport, LIST_SIZE, PAGES, type PageId, type ReportTexts } from "@/components/studio/dashboard-report";
import { ApiError, type CampaignView, type ConsoleApi, type QuietRegulars, type Results } from "./api";
import { FOCUS_RING, LoomLine, NoticePanel, SECONDARY_BUTTON, TextButton, useElapsedSeconds } from "./ui";

// Studio is megabytes of script, so it loads only when this step opens.
const StudioView = dynamic(() => import("@/components/studio/StudioView"), { ssr: false, loading: () => <LoadingPatch /> });

const REFRESH_EVERY_MS = 20_000;
const BUSY_RETRY_DEFAULT_SECONDS = 5;
const BUSY_RETRY_MAX_SECONDS = 30;
const SHOW_SECONDS_AFTER = 2;
const NARROW_QUERY = "(max-width: 859px)";
// What Studio does in edit mode: a plain drag moves a widget into a free spot, a drag held with Alt swaps two, and the edges resize.
const EDIT_HINT = "Drag a widget to move it into an empty spot. Hold Alt (Option on a Mac) while you drop it on another widget to swap them. Drag an edge to resize.";
// A campaign in either of these will not change again, so the page stops asking.
const FINAL_STATUSES = ["completed", "voided"];

function subscribeToWidth(onChange: () => void): () => void {
  const media = window.matchMedia(NARROW_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribeToWidth,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function isBusy(error: ApiError): boolean {
  return error.status === 503 || error.code === "still_running";
}

// A busy engine gets one more try after the wait it asked for, as the Regulars step does.
async function loadRegulars(api: ConsoleApi, signal: AbortSignal): Promise<QuietRegulars> {
  try {
    return await api.quietRegulars(LIST_SIZE, { signal });
  } catch (error) {
    if (!(error instanceof ApiError) || !isBusy(error)) throw error;
    await wait(Math.min(error.retryAfterSeconds ?? BUSY_RETRY_DEFAULT_SECONDS, BUSY_RETRY_MAX_SECONDS) * 1000, signal);
    return await api.quietRegulars(LIST_SIZE, { signal });
  }
}

type Part = { regulars: QuietRegulars; view: CampaignView | null; results: Results | null };

// A campaign the server no longer knows reads as no campaign, not as a failure.
async function loadResults(api: ConsoleApi, campaignId: string, signal: AbortSignal): Promise<Results | null> {
  try {
    return await api.results(campaignId, { signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

type Load = { kind: "loading" } | ({ kind: "ready" } & Part) | { kind: "failed"; text: string; canRetry: boolean };

function loadFailure(error: unknown): { text: string; canRetry: boolean } {
  if (error instanceof ApiError && error.status === 429) {
    return { text: "You have opened the dashboard many times this hour. Try again later.", canRetry: false };
  }
  return { text: "The dashboard didn't load.", canRetry: true };
}

function LoadingPatch() {
  const elapsed = useElapsedSeconds(true);
  return (
    <div role="status" className="patch p-7">
      <LoomLine />
      <p className="mt-4 text-[14px] leading-[1.5] text-ink-dim">Loading the dashboard</p>
      {elapsed >= SHOW_SECONDS_AFTER && <p className="mt-2 font-mono text-[12px] tabular-nums text-ink-faint">{elapsed} s</p>}
    </div>
  );
}

const TAB_BASE = "h-10 rounded-[10px] border-[1.5px] border-dashed border-stitch px-4 text-[15px] font-semibold text-ink transition-colors duration-150 ease-out";

type StageProps = {
  licenseKey: string;
  data: DashboardData;
  page: PageId;
  narrow: boolean;
  editing: boolean;
  texts: ReportTexts;
  horizonWeeks: number | undefined;
};

// Remounted when the width crosses the phone line, because Studio reads its report only at start.
function Stage({ licenseKey, data, page, narrow, editing, texts, horizonWeeks }: StageProps) {
  const [report] = useState(() => dashboardReport({ selected: page, narrow, source: texts.source, horizonWeeks }));
  return (
    <StudioView
      licenseKey={licenseKey}
      dashboard={{ data, report, narrow, mode: editing ? "edit" : "view", selectedPageId: page, texts }}
    />
  );
}

type DashboardStepProps = {
  api: ConsoleApi;
  /** The campaign the session is working on, or null when none has been planned yet. */
  campaignId: string | null;
  licenseKey: string;
  onPlan: () => void;
  onBack: () => void;
};

export function DashboardStep({ api, campaignId, licenseKey, onPlan, onBack }: DashboardStepProps) {
  const narrow = useNarrow();
  const shop = useShopSummary();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<PageId>(campaignId === null ? "shop" : "campaign");
  const [editing, setEditing] = useState(false);
  // Set when the server says the hour's reads are used up, so the refresh stops asking.
  const readsUsedUp = useRef(false);

  useEffect(() => {
    const mine = new AbortController();
    readsUsedUp.current = false;
    // The server runs at most two calls at once for a session, so the plan view waits until these two are back.
    Promise.all([loadRegulars(api, mine.signal), campaignId === null ? null : loadResults(api, campaignId, mine.signal)])
      .then(([regulars, results]) => {
        if (mine.signal.aborted) return;
        setLoad({ kind: "ready", regulars, view: null, results });
        if (campaignId === null || results === null) return;
        // Only the Amount column needs the plan view, so a refusal leaves those cells blank instead of failing the page.
        api
          .view(campaignId, { signal: mine.signal })
          .then((view) => {
            if (!mine.signal.aborted) setLoad((current) => (current.kind === "ready" ? { ...current, view } : current));
          })
          .catch(() => undefined);
      })
      .catch((error: unknown) => {
        if (!mine.signal.aborted) setLoad({ kind: "failed", ...loadFailure(error) });
      });
    return () => mine.abort();
  }, [api, campaignId, attempt]);

  const ready = load.kind === "ready";
  const final = load.kind === "ready" && load.results !== null && FINAL_STATUSES.includes(load.results.status);

  useEffect(() => {
    if (!ready || campaignId === null || final) return;
    const mine = new AbortController();
    async function refresh() {
      if (document.hidden || readsUsedUp.current) return;
      try {
        const results = await api.results(campaignId as string, { signal: mine.signal });
        if (!mine.signal.aborted) setLoad((current) => (current.kind === "ready" ? { ...current, results } : current));
      } catch (error) {
        if (mine.signal.aborted) return;
        if (error instanceof ApiError && error.status === 429) readsUsedUp.current = true;
      }
    }
    const timer = setInterval(() => void refresh(), REFRESH_EVERY_MS);
    const onVisible = () => void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mine.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [api, campaignId, ready, final]);

  const inputs = useMemo<DashboardInputs | null>(
    () => (shop.summary !== null && load.kind === "ready" ? { summary: shop.summary, regulars: load.regulars, view: load.view, results: sentResults(load.results) } : null),
    [shop.summary, load],
  );

  // Studio gets a new data object only when a table really changed, so a refresh that finds the same numbers redraws nothing.
  const [shown, setShown] = useState<{ inputs: DashboardInputs; data: DashboardData } | null>(null);
  if (inputs !== null && shown?.inputs !== inputs) {
    const next = dashboardData(inputs);
    setShown({ inputs, data: shown !== null && sameData(shown.data, next) ? shown.data : next });
  }

  const source = shown?.inputs.summary?.backtest?.source ?? null;
  const texts = useMemo<ReportTexts>(() => ({ source }), [source]);
  // The stage is only drawn once the summary has loaded, so the chart titles it is built with already know this.
  const horizonWeeks = shown?.inputs.summary?.backtest?.bands?.horizonWeeks;

  const failed = shop.state === "unavailable" ? { text: "The dashboard didn't load.", canRetry: true } : load.kind === "failed" ? load : null;
  const empty = page === "campaign" && (shown?.inputs.results ?? null) === null;
  const editingNow = editing && !narrow;

  function retry() {
    shop.retry();
    setLoad({ kind: "loading" });
    setAttempt((current) => current + 1);
  }

  return (
    <section aria-labelledby="dashboard-title" aria-busy={shown === null && failed === null}>
      <header className="mb-5 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-x-5">
            <p className="font-mono text-[13px] uppercase tracking-[0.08em] text-ink-dim">Step 7 &middot; Dashboard</p>
            <TextButton mono onClick={onBack}>
              Back to the demo
            </TextButton>
          </div>
          <h1 id="dashboard-title" className="poster-title mt-2 text-[34px] text-ink">
            Your shop at a glance.
          </h1>
          <p className="mt-3 max-w-[60ch] text-[16px] leading-[1.55] text-ink-dim">
            Every number is live from Mend and PayPal&apos;s sandbox. Rearrange it however you like.
          </p>
        </div>

        {shown !== null && (
          <div className="flex flex-wrap items-center gap-3">
            <div role="group" aria-label="Dashboard pages" className="flex flex-wrap gap-2">
              {PAGES.map((item) => {
                const active = item.id === page;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setPage(item.id)}
                    className={`${TAB_BASE} ${active ? "bg-felt-butter" : "bg-paper-raised hover:bg-pale-butter"} ${FOCUS_RING}`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
            {!narrow && (
              <button type="button" onClick={() => setEditing((current) => !current)} className={`${SECONDARY_BUTTON} h-10 px-4 text-[15px] ${FOCUS_RING}`}>
                {editing ? "Done" : "Edit layout"}
              </button>
            )}
          </div>
        )}
      </header>

      {shown !== null && failed === null && narrow && <p className="mb-3 text-[14px] leading-[1.5] text-ink-dim">Open this page on a computer to use the Mend analyst.</p>}
      {shown !== null && failed === null && editingNow && <p className="mb-3 text-[14px] leading-[1.5] text-ink-dim">{EDIT_HINT}</p>}

      {failed !== null ? (
        <NoticePanel action={failed.canRetry ? <TextButton onClick={retry}>Try again</TextButton> : undefined}>{failed.text}</NoticePanel>
      ) : shown === null ? (
        <LoadingPatch />
      ) : (
        <div className="patch -mx-4 p-[10px] md:mx-0" style={{ height: "calc(100svh - 170px)", minHeight: 640 }}>
          {/* The two pixels of margin leave the patch's stitch showing between its edge and Studio. Studio hyphenates a wrapped widget title mid-word, so the class below lets it break between words only. */}
          <div className="relative h-full overflow-x-hidden">
            <div
              className={`m-[2px] h-[calc(100%-4px)] overflow-hidden rounded-[17px] [&_.ag-studio-layout-widget-label-wrap]:hyphens-none! ${empty ? "invisible" : ""}`}
              aria-hidden={empty}
              inert={empty}
            >
              <Stage key={narrow ? "narrow" : "wide"} licenseKey={licenseKey} data={shown.data} page={page} narrow={narrow} editing={editingNow} texts={texts} horizonWeeks={horizonWeeks} />
            </div>
            {empty && (
              <div className="absolute inset-0 grid place-items-center">
                <div className="patch p-7 text-center">
                  <p className="text-[16px] leading-6 text-ink">Send a campaign to see it here.</p>
                  <div className="mt-2">
                    <TextButton onClick={onPlan}>Plan a campaign</TextButton>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
