"use client";

import { AgStudioAiModule, enableStudioDevValidations, type AgReportState, type AgStudioApi, type AgStudioApiReadyEvent, type AgStudioLocaleText, type AgStudioMode } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShopSummary } from "../live/useShopSummary";
import { mendTeam } from "./agents";
import type { DashboardData } from "./dashboard-data";
import { dashboardLayout, dashboardPanels, toolWords, TOOL_NAMES, withTexts, type ReportTexts } from "./dashboard-report";
import { dashboardTheme } from "./studio-theme";
import { mendWidgets, type MendRegistry } from "./widgets";

if (process.env.NODE_ENV !== "production") enableStudioDevValidations();

const MODULES = [AgStudioAiModule];
const FILL = { width: "100%", height: "100%" };
// Every step in the chat panel reads in plain words. A tool with no entry here would show its own name.
const TOOL_DISPLAY = Object.fromEntries(TOOL_NAMES.map((name) => [name, { label: ({ args }: { readonly args: Readonly<Record<string, unknown>> }) => ({ text: toolWords(name, args) }) }]));
const PANEL_WORDS: AgStudioLocaleText = { panelTitleAi: "Mend analyst", aiMessageInputPlaceholder: "Ask the Mend analyst..." };

/** What the owner's dashboard hands Studio. The report is read once at start; the other fields can change while it runs. */
export type DashboardStudio = {
  readonly data: DashboardData;
  readonly report: AgReportState<MendRegistry>;
  readonly narrow: boolean;
  readonly mode: AgStudioMode;
  readonly selectedPageId: string;
  readonly texts: ReportTexts;
};

/** The owner's dashboard in the demo. */
export default function StudioView({ licenseKey, dashboard }: { readonly licenseKey: string; readonly dashboard: DashboardStudio }) {
  const { data, report, narrow, mode, selectedPageId, texts } = dashboard;
  const [layout] = useState(() => dashboardLayout(narrow));
  const [panels] = useState(() => dashboardPanels(narrow));
  // The first view of the dashboard is its widgets, on every screen size. The panel opens from its own control.
  const [initialState] = useState<AgReportState<MendRegistry>>(() => ({ ...report, panels: { ...report.panels, ai: { collapsed: true } } }));
  const api = useRef<AgStudioApi<MendRegistry> | null>(null);

  // The analyst's tools hand back what the page shows at the moment they run. The rule words sit in the same summary the page already reads.
  const bands = useShopSummary().summary?.backtest?.bands ?? null;
  const [team] = useState(() => mendTeam({ data, bands }));
  useEffect(() => team.update({ data, bands }), [team, data, bands]);

  // The tabs and the live words reach Studio through its own state, so a layout the owner has dragged about is kept.
  const sync = useCallback(() => {
    const current = api.current;
    if (current === null) return;
    const state = current.getState();
    const moved = withTexts(state, texts);
    const next = moved.selectedPageId === selectedPageId ? moved : { ...moved, selectedPageId };
    if (next !== state) current.setState(next);
  }, [selectedPageId, texts]);

  useEffect(sync, [sync]);

  const ready = useCallback(
    (event: AgStudioApiReadyEvent) => {
      // The ready event types its api for Studio's own widgets only. This Studio also runs Mend's two.
      api.current = event.api as unknown as AgStudioApi<MendRegistry>;
      sync();
    },
    [sync],
  );

  return (
    <AgStudioProvider modules={MODULES} licenseKey={licenseKey === "" ? undefined : licenseKey}>
      <AgStudio<MendRegistry>
        style={FILL}
        data={data}
        mode={mode}
        widgets={mendWidgets}
        initialState={initialState}
        layout={layout}
        panels={panels}
        ai={team.setup}
        aiToolDisplay={TOOL_DISPLAY}
        localeText={PANEL_WORDS}
        theme={dashboardTheme}
        loadThemeGoogleFonts={false}
        onApiReady={ready}
      />
    </AgStudioProvider>
  );
}
