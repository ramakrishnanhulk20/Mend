"use client";

import { useCallback, useEffect, useState } from "react";
import { ShopSummarySchema, type ShopSummary } from "./summary";

type SummaryState = "loading" | "ready" | "unavailable";

const SLOW_AFTER_MS = 2000;
const MAX_RETRIES = 2;

// Seconds from a Retry-After header, only when the engine asks for 1 to 30 of them.
function retryAfterSeconds(header: string | null): number | null {
  if (header === null || !/^\d{1,2}$/.test(header.trim())) return null;
  const seconds = Number(header);
  return seconds >= 1 && seconds <= 30 ? seconds : null;
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

// null means unavailable. A 503 that names a short wait is tried again, at most twice;
// anything else that is not a good answer in the right shape is not shown.
async function load(signal: AbortSignal): Promise<ShopSummary | null> {
  for (let retries = 0; ; retries += 1) {
    const response = await fetch("/api/shop/summary", { cache: "no-store", signal });
    if (response.status === 503 && retries < MAX_RETRIES) {
      const seconds = retryAfterSeconds(response.headers.get("retry-after"));
      if (seconds === null) return null;
      await wait(seconds * 1000, signal);
      continue;
    }
    if (!response.ok) return null;
    const parsed = ShopSummarySchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  }
}

export function useShopSummary(): {
  state: SummaryState;
  summary: ShopSummary | null;
  slow: boolean;
  retry: () => void;
} {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SummaryState>("loading");
  const [summary, setSummary] = useState<ShopSummary | null>(null);
  const [slowTimerFired, setSlowTimerFired] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const slowTimer = setTimeout(() => setSlowTimerFired(true), SLOW_AFTER_MS);

    load(controller.signal)
      .then((data) => {
        clearTimeout(slowTimer);
        if (controller.signal.aborted) return;
        setSummary(data);
        setState(data === null ? "unavailable" : "ready");
      })
      .catch(() => {
        clearTimeout(slowTimer);
        if (controller.signal.aborted) return;
        setSummary(null);
        setState("unavailable");
      });

    return () => {
      controller.abort();
      clearTimeout(slowTimer);
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setState("loading");
    setSummary(null);
    setSlowTimerFired(false);
    setAttempt((current) => current + 1);
  }, []);

  return { state, summary, slow: state === "loading" && slowTimerFired, retry };
}
