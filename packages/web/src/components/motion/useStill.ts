"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

export function subscribeToStill(onChange: () => void): () => void {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function readStill(): boolean {
  return window.matchMedia(QUERY).matches;
}

// The server and the first client render both answer false, so the page hydrates without a
// mismatch. A visitor who asked for less motion switches to the still state right after.
export function readStillOnServer(): boolean {
  return false;
}

/** True when the visitor's system asks for reduced motion. */
export function useStill(): boolean {
  return useSyncExternalStore(subscribeToStill, readStill, readStillOnServer);
}
