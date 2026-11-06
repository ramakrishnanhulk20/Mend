"use client";

import { AgStudioAiModule, enableStudioDevValidations, type AgPanelConfig, type AgReportState, type AgStudioApi, type AgStudioApiReadyEvent, type AgStudioLocaleText, type AgStudioMode } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShopSummary } from "../live/useShopSummary";
import { mendTeam, READ_TOOL_DISPLAY } from "./agents";
import type { DashboardData } from "./dashboard-data";
import { dashboardLayout, withTexts, type ReportTexts } from "./dashboard-report";
import { dashboardTheme } from "./studio-theme";
import { mendWidgets, type MendRegistry } from "./widgets";

if (process.env.NODE_ENV !== "production") enableStudioDevValidations();

const MODULES = [AgStudioAiModule];
const FILL = { width: "100%", height: "100%" };
// Studio's types list the AI panel for edit mode only, but its panel code accepts it in view mode. A panel set that names only one mode leaves the other with no panels at all. In edit mode the AI panel steps aside so the page keeps the width it has in view mode.
const DASHBOARD_PANELS = { view: { left: ["ai"], right: [] }, edit: { left: [], right: ["edit", "data"] } } as unknown as AgPanelConfig;
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
        panels={DASHBOARD_PANELS}
        ai={team.setup}
        aiToolDisplay={READ_TOOL_DISPLAY}
        localeText={PANEL_WORDS}
        theme={dashboardTheme}
        loadThemeGoogleFonts={false}
        onApiReady={ready}
      />
    </AgStudioProvider>
  );
}
