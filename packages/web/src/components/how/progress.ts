export const PANEL_COUNT = 4;

// How far the visitor has scrolled through a tall pinned section: 0 when its top
// touches the top of the screen, 1 when its bottom touches the bottom of the screen.
export function sectionProgress(top: number, sectionHeight: number, viewportHeight: number): number {
  const travel = sectionHeight - viewportHeight;
  if (!(travel > 0)) return 0;
  const raw = -top / travel;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(1, Math.max(0, raw)) + 0;
}

export function activePanel(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  const index = Math.round(progress * (PANEL_COUNT - 1));
  return Math.min(PANEL_COUNT - 1, Math.max(0, index));
}
