import { studioTheme } from "ag-studio";
import { STITCH } from "./dashboard-report";

// The site's own colour tokens from globals.css, written out as plain values.
const INK = "#123B3F";
const PAPER = "#FBF5E9";
const PAPER_RAISED = "#FFFDF7";
const ACCENT = "#D72A16";

// Teal, accent red, butter, sky, peach, sage. Charts with more series than that repeat the list.
const PALETTE = ["#3FBFAE", ACCENT, "#FFD45E", "#6EC5F0", "#FFB27A", "#8FD18F"] as const;
const PALETTE_SIZE = 12;

const SANS = "var(--font-instrument)";
const DISPLAY = "var(--font-fraunces)";

function palette(kind: "Fills" | "Strokes") {
  return Object.fromEntries(
    Array.from({ length: PALETTE_SIZE }, (_, index) => [`chartPalette${kind}${index + 1}Color`, PALETTE[index % PALETTE.length]]),
  );
}

/** Mend's quilt look for Studio: paper behind, raised paper widgets with a dashed stitch, Fraunces titles. Light only. */
export const dashboardTheme = studioTheme.withParams({
  browserColorScheme: "light",
  backgroundColor: PAPER,
  foregroundColor: INK,
  subtleTextColor: "rgb(18 59 63 / 0.62)",
  accentColor: ACCENT,
  borderColor: "rgb(18 59 63 / 0.14)",
  fontFamily: SANS,

  // Studio blends its wrapper and canvas colours from the foreground, which turns the paper grey, so both are set to the paper itself.
  studioWrapperBackgroundColor: PAPER,
  studioCanvasBackgroundColor: PAPER,
  studioWidgetBackgroundColor: PAPER_RAISED,
  studioWidgetBorder: { style: "dashed", width: 1.5, color: STITCH },
  studioWidgetBorderRadius: 18,
  studioWidgetPadding: 7,
  studioWidgetTitleFontFamily: DISPLAY,
  studioWidgetTitleFontWeight: 560,
  studioWidgetTitleFontSize: 20,
  studioWidgetTitleTextColor: INK,
  studioValueWidgetFontSize: 38,

  gridFontFamily: SANS,
  gridFontSize: 14,
  gridDataBackgroundColor: PAPER_RAISED,
  gridHeaderBackgroundColor: PAPER_RAISED,

  chartFontFamily: SANS,
  ...palette("Fills"),
  ...palette("Strokes"),
});
