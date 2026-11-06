"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStill } from "@/components/motion/useStill";

const EASE = [0.22, 1, 0.36, 1] as const;
const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ink";

type DrawState = "drawing" | "failed" | { svg: string };

// The site's tokens as plain values: Mermaid builds its own stylesheet and cannot read CSS classes.
const PAPER = "#FBF5E9";
const PAPER_RAISED = "#FFFDF7";
const INK = "#123B3F";
const EDGE = "rgb(18 59 63 / 0.62)";
const LINE = "rgb(18 59 63 / 0.74)";

const THEME_VARIABLES = {
  background: PAPER,
  primaryColor: PAPER_RAISED,
  primaryTextColor: INK,
  primaryBorderColor: EDGE,
  lineColor: LINE,
  fontFamily: "var(--font-instrument), sans-serif",
  // The rest keep Mermaid from filling in its own tints (blue-grey groups, yellow notes).
  secondaryColor: PAPER_RAISED,
  tertiaryColor: PAPER_RAISED,
  textColor: INK,
  mainBkg: PAPER_RAISED,
  nodeBorder: EDGE,
  clusterBkg: "rgb(18 59 63 / 0.04)",
  clusterBorder: EDGE,
  edgeLabelBackground: PAPER,
  actorBkg: PAPER_RAISED,
  actorBorder: EDGE,
  actorTextColor: INK,
  actorLineColor: LINE,
  signalColor: LINE,
  signalTextColor: INK,
  labelBoxBkgColor: PAPER_RAISED,
  labelBoxBorderColor: EDGE,
  labelTextColor: INK,
  loopTextColor: INK,
  noteBkgColor: PAPER_RAISED,
  noteBorderColor: EDGE,
  noteTextColor: INK,
  activationBkgColor: "rgb(18 59 63 / 0.12)",
  activationBorderColor: EDGE,
  sequenceNumberColor: PAPER,
};

let initialised = false;

async function loadMermaid() {
  const { default: mermaid } = await import("mermaid");
  if (!initialised) {
    // useMaxWidth off keeps each drawing's own size: the box scales it down to fit the column and
    // "Open full size" shows it at that size. The tighter sequence spacing keeps the campaign
    // diagram near 1,100 px wide, so the full-size view fits a laptop screen without sideways scrolling.
    mermaid.initialize({
      startOnLoad: false,
      theme: "base",
      themeVariables: THEME_VARIABLES,
      flowchart: { useMaxWidth: false },
      sequence: { useMaxWidth: false, actorMargin: 16, width: 96, boxMargin: 6, noteMargin: 6, messageMargin: 28, diagramMarginX: 8 },
    });
    initialised = true;
  }
  return mermaid;
}

/**
 * Draws a Mermaid diagram on the client. A short label shows while it draws, so raw diagram code
 * never flashes. The source text shows only if drawing fails. Once drawn, "Open full size" shows
 * the diagram at its real size in a full-screen view.
 */
export function Mermaid({ chart }: { chart: string }) {
  const renderId = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [state, setState] = useState<DrawState>("drawing");
  const [open, setOpen] = useState(false);
  const still = useStill();
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    loadMermaid()
      .then((mermaid) => mermaid.render(renderId, chart))
      .then((result) => {
        if (!cancelled) setState({ svg: result.svg });
      })
      .catch(() => {
        // Mermaid leaves a half-drawn error box at the end of the page when it fails.
        document.getElementById(`d${renderId}`)?.remove();
        if (!cancelled) setState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [chart, renderId]);

  useEffect(() => {
    if (!open) return;
    const trigger = openButtonRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const onOverlayKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      // Close is the only control in the full-size view, so Tab stays on it instead of reaching the page behind.
      if (event.key === "Tab") {
        event.preventDefault();
        closeButtonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onOverlayKey);
    return () => {
      document.removeEventListener("keydown", onOverlayKey);
      document.body.style.overflow = previousOverflow;
      trigger?.focus();
    };
  }, [open]);

  if (state === "drawing") {
    return (
      <div
        aria-busy="true"
        className="not-prose my-6 flex min-h-[180px] items-center justify-center rounded-[8px] border border-rule bg-paper"
      >
        <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-ink-faint">
          Drawing the diagram
        </span>
      </div>
    );
  }

  if (state === "failed") {
    return (
      <pre
        data-mermaid="source"
        className="not-prose fd-scroll-container my-6 overflow-x-auto rounded-[8px] border border-rule bg-paper-raised p-4 font-mono text-[13px] leading-[1.6] text-ink-dim"
      >
        {chart}
      </pre>
    );
  }

  return (
    <>
      <div
        role="region"
        aria-label="Diagram"
        tabIndex={0}
        data-mermaid="drawn"
        className={`not-prose fd-scroll-container my-6 overflow-x-auto rounded-[8px] border border-rule bg-paper p-4 [&_svg]:h-auto [&_svg]:max-w-full ${FOCUS_RING}`}
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
      <div className="not-prose -mt-4 mb-6 flex justify-end">
        <button
          ref={openButtonRef}
          type="button"
          onClick={() => setOpen(true)}
          className={`font-mono text-[12px] uppercase tracking-[0.14em] text-ink-dim underline-offset-4 transition-colors duration-150 ease-out hover:text-ink hover:underline ${FOCUS_RING}`}
        >
          Open full size
        </button>
      </div>
      {/* Every id in the drawing starts with the render id. The full-size copy gets its own, so no id appears twice on the page. */}
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              key="full-size"
              role="dialog"
              aria-modal="true"
              aria-label="Diagram, full size"
              className="fixed inset-0 z-50 bg-paper/95 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: still ? 0 : 0.2, ease: EASE } }}
              exit={{ opacity: 0, transition: { duration: still ? 0 : 0.15, ease: EASE } }}
            >
              <div className="flex h-14 items-center justify-between border-b border-rule px-4 md:px-6">
                <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-ink-faint">
                  Diagram
                </span>
                <button
                  ref={closeButtonRef}
                  type="button"
                  onClick={() => setOpen(false)}
                  className={`text-[14px] text-ink underline-offset-4 hover:underline ${FOCUS_RING}`}
                >
                  Close
                </button>
              </div>
              <div
                className="absolute inset-x-0 bottom-0 top-14 overflow-auto p-6"
                dangerouslySetInnerHTML={{ __html: state.svg.split(renderId).join(`${renderId}-full`) }}
              />
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
