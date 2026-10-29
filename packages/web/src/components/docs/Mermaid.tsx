"use client";

import { useEffect, useId, useState } from "react";

// The site's tokens as plain values: Mermaid builds its own stylesheet and cannot read CSS classes.
const INK = "#0b0a0a";
const INK_RAISED = "#151312";
const BONE = "#ede6da";
const EDGE = "rgb(237 230 218 / 0.38)";
const LINE = "rgb(237 230 218 / 0.5)";

const THEME_VARIABLES = {
  background: INK,
  primaryColor: INK_RAISED,
  primaryTextColor: BONE,
  primaryBorderColor: EDGE,
  lineColor: LINE,
  fontFamily: "var(--font-instrument), sans-serif",
  // The rest keep Mermaid from filling in its own tints (blue-grey groups, yellow notes).
  secondaryColor: INK_RAISED,
  tertiaryColor: INK_RAISED,
  textColor: BONE,
  mainBkg: INK_RAISED,
  nodeBorder: EDGE,
  clusterBkg: "rgb(237 230 218 / 0.04)",
  clusterBorder: EDGE,
  edgeLabelBackground: INK,
  actorBkg: INK_RAISED,
  actorBorder: EDGE,
  actorTextColor: BONE,
  actorLineColor: LINE,
  signalColor: LINE,
  signalTextColor: BONE,
  labelBoxBkgColor: INK_RAISED,
  labelBoxBorderColor: EDGE,
  labelTextColor: BONE,
  loopTextColor: BONE,
  noteBkgColor: INK_RAISED,
  noteBorderColor: EDGE,
  noteTextColor: BONE,
  activationBkgColor: "rgb(237 230 218 / 0.12)",
  activationBorderColor: EDGE,
  sequenceNumberColor: INK,
};

let initialised = false;

async function loadMermaid() {
  const { default: mermaid } = await import("mermaid");
  if (!initialised) {
    // useMaxWidth off keeps the text at its real size. A wide diagram then scrolls inside its
    // own box instead of shrinking until it cannot be read.
    mermaid.initialize({
      startOnLoad: false,
      theme: "base",
      themeVariables: THEME_VARIABLES,
      flowchart: { useMaxWidth: false },
      sequence: { useMaxWidth: false },
    });
    initialised = true;
  }
  return mermaid;
}

/** Draws a Mermaid diagram on the client. The source text shows until the drawing is ready, and stays if drawing fails. */
export function Mermaid({ chart }: { chart: string }) {
  const renderId = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadMermaid()
      .then((mermaid) => mermaid.render(renderId, chart))
      .then((result) => {
        if (!cancelled) setSvg(result.svg);
      })
      .catch(() => {
        // Mermaid leaves a half-drawn error box at the end of the page when it fails.
        document.getElementById(`d${renderId}`)?.remove();
        if (!cancelled) setSvg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [chart, renderId]);

  if (svg !== null) {
    return (
      <div
        role="region"
        aria-label="Diagram"
        tabIndex={0}
        data-mermaid="drawn"
        className="not-prose fd-scroll-container my-6 overflow-x-auto rounded-[8px] border border-rule bg-ink p-4 focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-bone"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }

  return (
    <pre
      data-mermaid="source"
      className="not-prose fd-scroll-container my-6 overflow-x-auto rounded-[8px] border border-rule bg-ink-raised p-4 font-mono text-[13px] leading-[1.6] text-bone-dim"
    >
      {chart}
    </pre>
  );
}
