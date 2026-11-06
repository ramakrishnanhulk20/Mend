"use client";

import type { AgWidgetParams } from "ag-studio";
import { useEffect, useRef, useState } from "react";
import { useStill } from "../../motion/useStill";
import { verdictShares, type CampaignVerdictRow } from "../dashboard-data";
import type { VerdictWidgetState } from "./index";
import { INK, INK_THREAD, Thread, useBoxWidth, YARN, type ThreadLook } from "./thread-art";

const COMPACT_BELOW = 400;
const TITLE_MIN = 28;
const TITLE_MAX = 40;
const ROW_HEIGHT = 44;
const SHARE_WIDTH = 96;

const PAID_THREAD: ThreadLook = { line: "solid", color: YARN, stitch: YARN, weight: 3, gap: 0 };
const HELD_THREAD: ThreadLook = { line: "bridged", color: INK_THREAD, stitch: null, weight: 2, gap: 44 };

type Arm = { readonly name: string; readonly customers: number; readonly cameBack: number; readonly simulated: number; readonly share: number | null; readonly look: ThreadLook; readonly fill: string };

type Shown = { readonly title: string; readonly note: string; readonly arms: readonly [Arm, Arm] };

function shownFrom(row: CampaignVerdictRow): Shown {
  const shares = verdictShares(row);
  return {
    title: row.verdict_title,
    note: row.window_note,
    arms: [
      { name: "Paid", customers: row.paid_customers, cameBack: row.paid_came_back, simulated: row.paid_simulated, share: shares?.paid ?? null, look: PAID_THREAD, fill: YARN },
      { name: "Held back", customers: row.held_customers, cameBack: row.held_came_back, simulated: row.held_simulated, share: shares?.held ?? null, look: HELD_THREAD, fill: INK_THREAD },
    ],
  };
}

function ArmRow({ arm, compact, still }: { readonly arm: Arm; readonly compact: boolean; readonly still: boolean }) {
  const count = `${arm.cameBack} of ${arm.customers} came back`;
  const simulated = arm.simulated > 0 ? `${arm.simulated} simulated, kept apart` : null;
  const thread = (
    <div style={{ position: "relative", height: 28 }}>
      <Thread look={arm.look} still={still} />
    </div>
  );
  const share =
    arm.share === null ? null : (
      <div aria-hidden="true" data-part="share" data-share={Math.round(arm.share * 100)} style={{ height: 4, width: SHARE_WIDTH, borderRadius: 4, background: "rgb(18 59 63 / 0.12)" }}>
        <div style={{ height: "100%", width: `${Math.round(arm.share * 100)}%`, borderRadius: 4, background: arm.fill }} />
      </div>
    );
  const simulatedLine = simulated === null ? null : <p data-part="simulated" className="font-mono text-[12px] leading-4 text-ink-faint">{simulated}</p>;

  if (compact) {
    return (
      <div data-arm={arm.name} style={{ minHeight: ROW_HEIGHT }}>
        <div className="flex items-baseline justify-between gap-3 text-[15px] leading-5">
          <span className="font-medium">{arm.name}</span>
          <span data-part="count" className="tabular-nums">{count}</span>
        </div>
        {thread}
        {simulatedLine}
        {share !== null && <div className="mt-1 flex justify-end">{share}</div>}
      </div>
    );
  }
  return (
    <div data-arm={arm.name} className="grid items-center gap-x-4" style={{ gridTemplateColumns: "84px minmax(0, 1fr) auto", gridTemplateRows: "28px 16px", height: ROW_HEIGHT }}>
      <span className="text-[15px] font-medium leading-[28px]">{arm.name}</span>
      {thread}
      <span data-part="count" className="text-right text-[15px] tabular-nums">{count}</span>
      <div style={{ gridColumn: 2 }}>{simulatedLine}</div>
      <div style={{ gridColumn: 3 }} className="flex justify-end">
        {share}
      </div>
    </div>
  );
}

/**
 * "Did it work?": the verdict in words, then one thread for each group with how many came back.
 * It draws a share of customers only when Mend has a verdict to give, so it can never suggest a
 * result that "Too early to tell" denies. Rows are read through the widget API, never from props.
 */
export function VerdictWidget(params: AgWidgetParams<VerdictWidgetState>) {
  const [shown, setShown] = useState<Shown | null>(null);
  const hasShown = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const width = useBoxWidth(box);
  const still = useStill();

  // Studio hands a fresh params object on every refresh, so this runs again whenever the data or a filter moves.
  useEffect(() => {
    const { widgetApi, dataMapping } = params;
    const { title, paidCustomers, paidCameBack, paidSimulated, heldCustomers, heldCameBack, heldSimulated, windowNote } = dataMapping;
    if (!title?.[0] || !paidCustomers?.[0] || !paidCameBack?.[0] || !heldCustomers?.[0] || !heldCameBack?.[0]) {
      widgetApi.setDisplayState("incompleteDataMapping");
      return;
    }
    const fields = [title[0], paidCustomers[0], paidCameBack[0], heldCustomers[0], heldCameBack[0]];
    const optional = [paidSimulated?.[0], heldSimulated?.[0], windowNote?.[0]];
    const mine = new AbortController();
    widgetApi.setDisplayState("loading", { prominent: !hasShown.current });
    widgetApi
      .getData({ fields: [...fields, ...optional.filter((field) => field !== undefined)] }, { signal: mine.signal })
      .then(({ results }) => {
        if (mine.signal.aborted) return;
        const first = results.rows[0];
        if (first === undefined) {
          hasShown.current = false;
          setShown(null);
          widgetApi.setDisplayState("noData");
          return;
        }
        const count = (field: (typeof fields)[number] | undefined) => (field === undefined ? 0 : Number(first[field.key] ?? 0));
        hasShown.current = true;
        setShown(
          shownFrom({
            verdict_title: String(first[title[0].key] ?? ""),
            paid_customers: count(paidCustomers[0]),
            paid_came_back: count(paidCameBack[0]),
            paid_simulated: count(paidSimulated?.[0]),
            held_customers: count(heldCustomers[0]),
            held_came_back: count(heldCameBack[0]),
            held_simulated: count(heldSimulated?.[0]),
            window_note: windowNote?.[0] === undefined ? "" : String(first[windowNote[0].key] ?? ""),
          }),
        );
        widgetApi.setDisplayState("displayed");
      })
      .catch(() => {
        if (!mine.signal.aborted) widgetApi.setDisplayState("noData");
      });
    return () => mine.abort();
  }, [params]);

  const compact = width > 0 && width < COMPACT_BELOW;
  const titleSize = Math.min(TITLE_MAX, Math.max(TITLE_MIN, Math.round(width * 0.06)));

  return (
    <div ref={box} className="flex h-full min-h-0 flex-col overflow-y-auto text-ink" style={{ paddingInline: 9, paddingBottom: 6 }}>
      {shown !== null && width > 0 && (
        <>
          <p data-part="verdict" className="font-display" style={{ fontWeight: 560, fontSize: titleSize, lineHeight: 1.1, color: INK }}>
            {shown.title}
          </p>
          <div className="mt-5 flex flex-col" style={{ gap: compact ? 16 : 0 }}>
            {shown.arms.map((arm) => (
              <ArmRow key={arm.name} arm={arm} compact={compact} still={still} />
            ))}
          </div>
          {shown.note !== "" && <p data-part="window" className="mt-auto pt-3 font-mono text-[12px] text-ink-faint">{shown.note}</p>}
        </>
      )}
    </div>
  );
}
