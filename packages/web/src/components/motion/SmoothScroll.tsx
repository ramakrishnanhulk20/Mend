"use client";

import "lenis/dist/lenis.css";
import { useEffect } from "react";
import Lenis from "lenis";
import { useStill } from "./useStill";

export function SmoothScroll() {
  const still = useStill();

  useEffect(() => {
    if (still) return;

    const lenis = new Lenis({ lerp: 0.1, smoothWheel: true });
    let frameId = 0;
    const tick = (time: number) => {
      lenis.raf(time);
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameId);
      lenis.destroy();
    };
  }, [still]);

  return null;
}
