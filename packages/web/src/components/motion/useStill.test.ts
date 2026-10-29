import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readStill, readStillOnServer, subscribeToStill, useStill } from "./useStill";

const QUERY = "(prefers-reduced-motion: reduce)";

function stubMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  const asked: string[] = [];
  const list = {
    get matches() {
      return matches;
    },
    addEventListener: (type: string, listener: () => void) => {
      if (type === "change") listeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === "change") listeners.delete(listener);
    },
  };
  vi.stubGlobal("window", {
    matchMedia: (query: string) => {
      asked.push(query);
      return list;
    },
  });
  return {
    asked,
    listeners,
    change(next: boolean) {
      matches = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useStill", () => {
  it("reads the reduced-motion media query", () => {
    const media = stubMedia(true);
    expect(readStill()).toBe(true);
    expect(media.asked).toEqual([QUERY]);
  });

  it("returns false when the visitor has not asked for less motion", () => {
    stubMedia(false);
    expect(readStill()).toBe(false);
  });

  it("tells a subscriber when the setting changes, and stops after unsubscribing", () => {
    const media = stubMedia(false);
    const onChange = vi.fn();
    const unsubscribe = subscribeToStill(onChange);

    media.change(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(readStill()).toBe(true);

    unsubscribe();
    expect(media.listeners.size).toBe(0);
    media.change(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("answers false on the server, even if a window says otherwise", () => {
    stubMedia(true);
    expect(readStillOnServer()).toBe(false);
  });

  it("renders false on the server, so the first paint matches for every visitor", () => {
    stubMedia(true);
    function Probe() {
      return createElement("span", null, String(useStill()));
    }
    expect(renderToString(createElement(Probe))).toBe("<span>false</span>");
  });
});
