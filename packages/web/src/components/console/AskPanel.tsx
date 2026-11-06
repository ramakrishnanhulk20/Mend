"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useStill } from "@/components/motion/useStill";
import { QUESTION_LIMIT, askFailureText, suggestionsFor, toolLabel, trimHistory } from "./agent";
import { ApiError, type ConsoleApi } from "./api";
import { EASE, FOCUS_RING, NoticePanel, PRIMARY_BUTTON, SECONDARY_BUTTON, Spinner, useElapsedSeconds } from "./ui";

const CAPTION = "font-mono text-[12px] uppercase tracking-[0.14em] text-ink-dim";

type Message = {
  id: number;
  role: "owner" | "agent";
  text: string;
  tools: string[];
  stopped: "tool_limit" | "declined" | null;
  unanswered: boolean;
};

function ThreadGlyph() {
  return (
    <svg width="16" height="8" viewBox="0 0 16 8" fill="none" aria-hidden="true" className="shrink-0">
      <circle cx="1.5" cy="4" r="1.5" className="fill-ink/40" />
      <path d="M3 4h13" className="stroke-ink/40" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ToolChips({ tools }: { tools: string[] }) {
  return (
    <ul aria-label="Tools Claude used" className="mt-3 flex flex-wrap gap-x-3 gap-y-[6px]">
      {tools.map((name, index) => (
        <li key={`${name}-${index}`} className="flex items-center gap-[6px]">
          <ThreadGlyph />
          <span className="rounded-[6px] border border-ink/30 px-2 py-[2px] font-mono text-[12px] text-ink-dim">
            {toolLabel(name)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Entry({ message, still }: { message: Message; still: boolean }) {
  const enter = {
    initial: still ? (false as const) : { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: still ? 0 : 0.25, ease: EASE },
  };

  if (message.role === "owner") {
    return (
      <motion.div className="flex flex-col items-end" {...enter}>
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-[12px] bg-paper px-4 py-[10px] text-[14px] text-ink [overflow-wrap:anywhere]">
          {message.text}
        </p>
        {message.unanswered && <span className="mt-1 font-mono text-[12px] text-ink-dim">not answered</span>}
      </motion.div>
    );
  }

  return (
    <motion.div className="rounded-[12px] bg-paper-raised px-4 py-[14px]" {...enter}>
      <p className={CAPTION}>Claude</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-[1.55] text-ink [overflow-wrap:anywhere]">
        {message.text}
      </p>
      {message.tools.length > 0 && <ToolChips tools={message.tools} />}
      {message.stopped === "tool_limit" && (
        <p className="mt-2 text-[12px] text-ink-dim">Claude stopped after using its tools.</p>
      )}
      {message.stopped === "declined" && <p className="mt-2 text-[12px] text-ink-dim">Claude declined this one.</p>}
    </motion.div>
  );
}

type AskPanelProps = {
  api: ConsoleApi;
  /** The PayPal order this session simulated on the results step, when there is one. */
  orderId: string | null;
  /** The page raises this number each time the visitor taps the Ask Mend shortcut. */
  openRequest?: number;
};

/**
 * A chat with Claude about the shop, a campaign or a PayPal order. Claude answers through Mend's
 * read-only tools and the panel shows which ones it used. The chat lives in this component only:
 * a reload clears it. Below lg the panel folds behind a button but stays mounted, so a question
 * in flight is not lost when it is closed.
 */
export function AskPanel({ api, orderId, openRequest = 0 }: AskPanelProps) {
  const still = useStill();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const controller = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const elapsed = useElapsedSeconds(pending);
  // Starts at the value the panel mounted with, so a panel that remounts later (a new session)
  // does not replay a tap from the old one.
  const handledRequest = useRef(openRequest);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  // The panel is display:none below lg until it is opened, so it opens first and the scroll and
  // the focus wait two frames: React's render of the open panel can land after one.
  useEffect(() => {
    if (openRequest <= 0 || openRequest <= handledRequest.current) return;
    setOpen(true);
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        handledRequest.current = openRequest;
        document.getElementById("ask-mend")?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
        textarea.current?.focus({ preventScroll: true });
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [openRequest, still]);

  // Scrolls the list itself, never the page, so a new line never pulls the visitor away from the step.
  useEffect(() => {
    const list = log.current;
    if (list === null) return;
    list.scrollTo({ top: list.scrollHeight, behavior: still ? "auto" : "smooth" });
  }, [messages, pending, open, still]);

  // From lg the panel sits in a sticky column that scrolls inside itself, and a long answer can push the
  // box to type in past that column's edge. Below lg the panel is in the page, which is left alone.
  useEffect(() => {
    if (pending || messages.length === 0 || !window.matchMedia("(min-width: 64rem)").matches) return;
    textarea.current?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "nearest" });
  }, [messages, pending, still]);

  async function send(text: string) {
    const question = text.trim();
    if (question === "" || pending) return;
    // A question Claude never answered would read as one it ignored, so it stays out of the history.
    const history = trimHistory(messages.filter((message) => !message.unanswered));
    const mine = new AbortController();
    controller.current = mine;
    const asked: Message = { id: nextId.current++, role: "owner", text: question, tools: [], stopped: null, unanswered: false };
    setMessages((current) => [...current, asked]);
    setDraft("");
    setFailure(null);
    setPending(true);
    textarea.current?.focus({ preventScroll: true });
    try {
      const answer = await api.ask(question, history, { signal: mine.signal });
      if (mine.signal.aborted) return;
      const reply: Message = {
        id: nextId.current++,
        role: "agent",
        text: answer.reply,
        tools: answer.toolsUsed,
        stopped: answer.stopped,
        unanswered: false,
      };
      setMessages((current) => [...current, reply]);
    } catch (error) {
      if (mine.signal.aborted) return;
      setMessages((current) => current.map((message) => (message.id === asked.id ? { ...message, unanswered: true } : message)));
      setFailure(error instanceof ApiError ? askFailureText(error.status, error.code) : askFailureText(0, "network"));
    } finally {
      if (!mine.signal.aborted) setPending(false);
    }
  }

  const empty = messages.length === 0;

  return (
    <div id="ask-mend" className="order-last scroll-mt-20 lg:mt-6">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="ask-panel"
        onClick={() => setOpen((current) => !current)}
        className={`${SECONDARY_BUTTON} h-12 w-full px-4 text-[15px] lg:hidden ${FOCUS_RING}`}
      >
        Ask Mend, powered by Claude
      </button>

      <section
        id="ask-panel"
        aria-labelledby="ask-title"
        className={`patch patch-tinted min-w-0 bg-pale-teal p-[26px] lg:mt-0 lg:block ${open ? "mt-3" : "hidden"}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h2 id="ask-title" className="text-[16px] font-semibold text-ink">
            Ask Mend
          </h2>
          <span className="label-tag h-6">Claude &middot; read-only</span>
        </div>
        <p className="mt-2 text-[13px] leading-[1.5] text-ink-dim">
          Ask about the shop, a campaign or a PayPal order. Claude reads through Mend&apos;s tools; it has no tool that
          sends money.
        </p>

        <div
          ref={log}
          role="log"
          aria-live="polite"
          aria-label="Conversation with Claude"
          tabIndex={empty ? undefined : 0}
          className={
            empty
              ? ""
              : `mt-4 flex max-h-[420px] flex-col gap-4 overflow-y-auto [scrollbar-color:var(--color-ink-faint)_transparent] [scrollbar-width:thin] ${FOCUS_RING}`
          }
        >
          {messages.map((message) => (
            <Entry key={message.id} message={message} still={still} />
          ))}
          {pending && (
            <div className="flex items-center gap-3 text-[13px] text-ink-dim">
              <Spinner />
              <span>Claude is reading</span>
              <span aria-hidden="true" className="font-mono tabular-nums text-ink-dim">
                {elapsed} s
              </span>
            </div>
          )}
        </div>

        {empty && (
          <div className="mt-4 flex flex-wrap gap-2">
            {suggestionsFor(orderId).map((text) => (
              <button
                key={text}
                type="button"
                onClick={() => void send(text)}
                className={`rounded-[10px] border-[1.5px] border-dashed border-ink/30 bg-paper-raised px-3 py-[7px] text-left text-[14px] leading-5 text-ink transition-colors duration-150 ease-out hover:bg-pale-butter ${FOCUS_RING}`}
              >
                {text}
              </button>
            ))}
          </div>
        )}

        {failure !== null && <NoticePanel>{failure}</NoticePanel>}

        <form
          className="mt-4 flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send(draft);
          }}
        >
          <textarea
            ref={textarea}
            rows={2}
            maxLength={QUESTION_LIMIT}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void send(draft);
            }}
            aria-label="Your question for Claude"
            placeholder="Ask Claude about the shop"
            className={`min-w-0 flex-1 resize-y rounded-[14px] border-2 border-ink/20 bg-paper-raised px-4 py-[14px] text-[17px] text-ink placeholder:text-ink-faint focus:border-accent ${FOCUS_RING}`}
          />
          <button
            type="submit"
            disabled={draft.trim() === "" || pending}
            className={`${PRIMARY_BUTTON} h-12 shrink-0 px-5 text-[15px] ${FOCUS_RING}`}
          >
            Ask
          </button>
        </form>
      </section>
    </div>
  );
}
