"use client";

import type { AgWidgetParams } from "ag-studio";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { threadKind, type ThreadKind } from "../dashboard-data";
import type { ThreadsWidgetState } from "./index";
import { INK, INK_THREAD, Thread, useBoxWidth, YARN, type ThreadLook } from "./thread-art";

const COMPACT_BELOW = 420;
const ROW_HEIGHT = 40;
const COMPACT_THREAD_HEIGHT = 32;
const NAME_WIDTH = 120;
const AMOUNT_WIDTH = 92;
const LINE_TOP = 3;
const LINE_BOX = 24;
const KNOT = 7;
// The rows are drawn finished. Only the verdict widget's two threads draw themselves in.
const DRAWN = true;
const LOOKS: Record<ThreadKind, ThreadLook> = {
  claimed: { line: "solid", color: YARN, stitch: YARN, weight: 2, gap: 0 },
  waiting: { line: "solid", color: INK_THREAD, stitch: INK, weight: 2, gap: 0 },
  returned: { line: "cut", color: INK_THREAD, stitch: null, weight: 2, gap: 36 },
  held: { line: "dotted", color: INK_THREAD, stitch: null, weight: 2, gap: 0 },
};

type CameBack = "real" | "simulated" | null;

type ThreadRow = {
  readonly rank: number;
  readonly name: string;
  /** The payment words the Payout step uses, exactly as the table holds them. */
  readonly status: string;
  readonly kind: ThreadKind;
  readonly amount: string;
  readonly cameBack: CameBack;
  /** False when another widget's selection leaves this customer out and this widget highlights rather than filters. */
  readonly lit: boolean;
};

const CAME_BACK_WORDS: Record<Exclude<CameBack, null>, string> = { real: "came back", simulated: "came back (simulated)" };

function describe(row: ThreadRow): string {
  const parts = [`${row.name}: ${row.status}`];
  if (row.amount !== "") parts.push(row.amount);
  if (row.cameBack !== null) parts.push(CAME_BACK_WORDS[row.cameBack]);
  return parts.join(", ");
}

function ThreadCell({ row, height }: { readonly row: ThreadRow; readonly height: number }) {
  return (
    <div data-part="thread" style={{ position: "relative", height }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: LINE_TOP, height: LINE_BOX }}>
        <Thread look={LOOKS[row.kind]} still={DRAWN} />
      </div>
      {row.cameBack !== null && (
        <>
          <span
            aria-hidden="true"
            style={{ position: "absolute", right: 0, top: LINE_TOP + LINE_BOX / 2 - KNOT / 2, width: KNOT, height: KNOT, borderRadius: KNOT, background: INK, boxShadow: "0 0 0 2px var(--color-paper-raised)" }}
          />
          <span data-part="came-back" className="absolute bottom-px right-0 font-mono text-[11px] leading-3 text-ink">{CAME_BACK_WORDS[row.cameBack]}</span>
        </>
      )}
    </div>
  );
}

function Row({ row, selected, compact, onPick }: { readonly row: ThreadRow; readonly selected: boolean; readonly compact: boolean; readonly onPick: () => void }) {
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onPick();
  };
  const amount = <span data-part="amount" className="text-right text-[14px] tabular-nums">{row.amount}</span>;
  const name = <span data-part="name" className="truncate text-[14px] leading-5">{row.name}</span>;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={describe(row)}
      title={row.status}
      data-kind={row.kind}
      onClick={onPick}
      onKeyDown={onKey}
      className={`cursor-pointer rounded-[10px] px-2 text-ink outline-none transition-[background-color,opacity] duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink motion-reduce:transition-none ${selected ? "bg-pale-butter" : "hover:bg-pale-butter"}`}
      style={{ opacity: row.lit ? 1 : 0.4, boxShadow: selected ? "inset 3px 0 0 var(--color-accent)" : undefined, ...(compact ? {} : { height: ROW_HEIGHT }) }}
    >
      {compact ? (
        <div className="py-1">
          <div className="flex items-baseline justify-between gap-3">
            {name}
            {amount}
          </div>
          <ThreadCell row={row} height={COMPACT_THREAD_HEIGHT} />
        </div>
      ) : (
        <div className="grid items-start gap-x-3" style={{ gridTemplateColumns: `${NAME_WIDTH}px minmax(0, 1fr) ${AMOUNT_WIDTH}px`, height: ROW_HEIGHT }}>
          <span data-part="name" className="truncate text-[14px] leading-[30px]">{row.name}</span>
          <ThreadCell row={row} height={ROW_HEIGHT} />
          <span data-part="amount" className="text-right text-[14px] leading-[30px] tabular-nums">{row.amount}</span>
        </div>
      )}
    </div>
  );
}

/**
 * "Every customer's thread": one thread per customer, drawn by where the payment stands. A click picks
 * that payment status for the whole page through the widget API, so the table beside it follows. Rows are
 * read through the widget API only, and every word is drawn as text.
 */
export function ThreadsWidget(params: AgWidgetParams<ThreadsWidgetState>) {
  const [rows, setRows] = useState<readonly ThreadRow[] | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const hasRows = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const width = useBoxWidth(box);

  // Studio hands a fresh params object on every refresh, so this runs again whenever the data or a selection moves.
  useEffect(() => {
    const { widgetApi, dataMapping } = params;
    const { rank, name, status, cameBack, simulated, amount } = dataMapping;
    if (!rank?.[0] || !name?.[0] || !status?.[0] || !cameBack?.[0] || !simulated?.[0] || !amount?.[0]) {
      widgetApi.setDisplayState("incompleteDataMapping");
      return;
    }
    const [rankField, nameField, statusField, cameBackField, simulatedField, amountField] = [rank[0], name[0], status[0], cameBack[0], simulated[0], amount[0]];
    const mine = new AbortController();
    widgetApi.setDisplayState("loading", { prominent: !hasRows.current });
    // A held-back customer has no amount, and by default the engine drops a row whose measures are all empty.
    // Studio's request type still lists the old word "none", which its engine now refuses in favour of "preserve".
    widgetApi
      .getData({ fields: [rankField, nameField, statusField, cameBackField, simulatedField, amountField], sort: [{ field: rankField, direction: "asc" }] }, { signal: mine.signal, nonEmpty: "preserve" as "none" })
      .then((answer) => {
        if (mine.signal.aborted) return;
        if (answer.results.rows.length === 0) {
          hasRows.current = false;
          setRows(null);
          widgetApi.setDisplayState("noData");
          return;
        }
        const lit = answer.crossFilter === undefined ? null : new Set(answer.crossFilter.rows.map((row) => Number(row[rankField.key])));
        setRows(
          answer.results.rows.map((row) => {
            const value = row[amountField.key];
            const state = String(row[statusField.key] ?? "");
            return {
              rank: Number(row[rankField.key]),
              name: String(row[nameField.key] ?? ""),
              status: state,
              kind: threadKind(state),
              amount: value === null || value === undefined ? "" : widgetApi.formatFieldValue(amountField, value),
              cameBack: row[cameBackField.key] === "Yes" ? "real" : row[simulatedField.key] === "Yes" ? "simulated" : null,
              lit: lit === null || lit.has(Number(row[rankField.key])),
            };
          }),
        );
        const chosen = widgetApi.getCrossFilterSelections()?.find((selection) => selection.type === "value");
        setPicked(new Set(chosen?.type === "value" ? chosen.values.map(String) : []));
        hasRows.current = true;
        widgetApi.setDisplayState("displayed");
      })
      .catch(() => {
        if (!mine.signal.aborted) widgetApi.setDisplayState("noData");
      });
    return () => mine.abort();
  }, [params]);

  function pick(status: string) {
    const statusField = params.dataMapping.status?.[0];
    if (statusField === undefined) return;
    params.widgetApi.toggleCrossFilter({ type: "value", field: statusField, value: status, group: 0 });
  }

  const compact = width > 0 && width < COMPACT_BELOW;
  return (
    <div ref={box} role="group" aria-label="Every customer's thread. Pick one to filter the page by payment status." className="h-full overflow-y-auto overflow-x-hidden">
      {rows !== null && width > 0 && rows.map((row) => <Row key={row.rank} row={row} selected={picked.has(row.status)} compact={compact} onPick={() => pick(row.status)} />)}
    </div>
  );
}
