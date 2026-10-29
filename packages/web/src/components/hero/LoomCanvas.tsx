"use client";

import { useEffect, useRef } from "react";
import { useStill } from "@/components/motion/useStill";
import {
  LOOM_RGB,
  heldProgress,
  layoutLoom,
  mendProgress,
  pushOffset,
  threadReveal,
  waveOffset,
  type LoomBreak,
  type LoomLayout,
} from "./loom";

const POINT_SPACING = 16;
const FIBERS = [
  { angle: (-22 * Math.PI) / 180, length: 9 },
  { angle: (-8 * Math.PI) / 180, length: 12 },
  { angle: (10 * Math.PI) / 180, length: 7 },
];

const bone = (alpha: number) => `rgba(${LOOM_RGB.bone},${alpha})`;
const accent = (alpha: number) => `rgba(${LOOM_RGB.accent},${alpha})`;

type Scene = { layout: LoomLayout; breakByRow: Map<number, LoomBreak> };
type PointerPush = { sx: number; sy: number; influence: number };

function buildScene(layout: LoomLayout): Scene {
  return { layout, breakByRow: new Map(layout.breaks.map((b) => [b.row, b])) };
}

function drawLoom(ctx: CanvasRenderingContext2D, scene: Scene, t: number, push: PointerPush) {
  const { layout, breakByRow } = scene;
  const { width, height, rows, breaks, gap, amplitude, glowRadius } = layout;
  const half = gap / 2;

  const yAt = (row: number, x: number) =>
    rows[row] +
    waveOffset(x, row, t, amplitude) +
    pushOffset(x, rows[row], push.sx, push.sy, push.influence);

  const trace = (row: number, from: number, to: number) => {
    ctx.moveTo(from, yAt(row, from));
    for (let x = (Math.floor(from / POINT_SPACING) + 1) * POINT_SPACING; x < to; x += POINT_SPACING) {
      ctx.lineTo(x, yAt(row, x));
    }
    ctx.lineTo(to, yAt(row, to));
  };

  ctx.clearRect(0, 0, width, height);
  ctx.lineJoin = "round";

  for (let i = 0; i < rows.length; i += 1) {
    const reveal = threadReveal(t, i);
    if (reveal <= 0) continue;

    const brk = breakByRow.get(i);
    const mend = brk && brk.kind === "mended" ? mendProgress(t, brk.order) : null;
    const alpha = 0.2 + 0.3 * (mend ? mend.tint : 0);
    const visibleWidth = reveal * width;

    ctx.save();
    ctx.beginPath();
    if (i % 2 === 0) ctx.rect(0, 0, visibleWidth, height);
    else ctx.rect(width - visibleWidth, 0, visibleWidth, height);
    ctx.clip();

    ctx.strokeStyle = bone(alpha);
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (brk) {
      trace(i, 0, brk.x - half);
      trace(i, brk.x + half, width);
    } else {
      trace(i, 0, width);
    }
    ctx.stroke();

    if (brk) {
      const strength = mend ? alpha * (1 - mend.bridge) : alpha;
      if (strength > 0) {
        const left = brk.x - half;
        const right = brk.x + half;
        const leftY = yAt(i, left);
        const rightY = yAt(i, right);
        ctx.strokeStyle = bone(strength);
        ctx.beginPath();
        for (const fiber of FIBERS) {
          const dx = Math.cos(fiber.angle) * fiber.length;
          const dy = Math.sin(fiber.angle) * fiber.length;
          ctx.moveTo(left, leftY);
          ctx.lineTo(left + dx, leftY + dy);
          ctx.moveTo(right, rightY);
          ctx.lineTo(right - dx, rightY + dy);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  for (const brk of breaks) {
    if (brk.kind !== "mended") continue;
    const { bridge, stitches, glow } = mendProgress(t, brk.order);

    if (glow > 0) {
      const cx = brk.x;
      const cy = yAt(brk.row, cx);
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowRadius);
      gradient.addColorStop(0, accent(0.35 * glow));
      gradient.addColorStop(1, accent(0));
      ctx.fillStyle = gradient;
      ctx.fillRect(cx - glowRadius, cy - glowRadius, glowRadius * 2, glowRadius * 2);
    }

    ctx.strokeStyle = accent(1);
    ctx.lineWidth = 1.5;
    ctx.lineCap = "round";

    if (bridge > 0) {
      const from = brk.x - half - 6;
      ctx.beginPath();
      trace(brk.row, from, from + (gap + 12) * bridge);
      ctx.stroke();
    }

    for (let k = 0; k < 3; k += 1) {
      const scale = stitches[k];
      if (scale === 0) continue;
      const x = brk.x - half + (gap * (k + 1)) / 4;
      const y = yAt(brk.row, x);
      const reach = 3.5 * scale;
      ctx.beginPath();
      ctx.moveTo(x - reach, y - reach);
      ctx.lineTo(x + reach, y + reach);
      ctx.moveTo(x - reach, y + reach);
      ctx.lineTo(x + reach, y - reach);
      ctx.stroke();
    }

    ctx.lineCap = "butt";
  }

  ctx.fillStyle = bone(0.7);
  for (const brk of breaks) {
    if (brk.kind !== "held") continue;
    const progress = heldProgress(t, brk.order);
    if (progress <= 0) continue;
    const first = brk.x - half + 3;
    const last = first + (gap - 6) * progress;
    ctx.beginPath();
    for (let x = first; x <= last; x += 6) {
      const y = yAt(brk.row, x);
      ctx.moveTo(x + 1.25, y);
      ctx.arc(x, y, 1.25, 0, Math.PI * 2);
    }
    ctx.fill();
  }
}

export function Loom() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const still = useStill();

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !parent || !ctx) return;

    const startedAt = performance.now();
    const pointer = {
      clientX: 0,
      clientY: 0,
      present: false,
      placed: false,
      sx: 0,
      sy: 0,
      influence: 0,
    };

    let scene: Scene | null = null;
    let cssWidth = 0;
    let cssHeight = 0;
    let ratio = 0;
    let frameId = 0;
    let onScreen = true;

    const drawStill = () => {
      if (scene) drawLoom(ctx, scene, Infinity, { sx: 0, sy: 0, influence: 0 });
    };

    const resize = () => {
      const width = parent.clientWidth;
      const height = parent.clientHeight;
      const nextRatio = Math.min(window.devicePixelRatio || 1, 2);
      if (width === cssWidth && height === cssHeight && nextRatio === ratio) return;
      cssWidth = width;
      cssHeight = height;
      ratio = nextRatio;
      if (width === 0 || height === 0) {
        scene = null;
        return;
      }
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const layout = layoutLoom(width, height);
      scene = buildScene(still ? { ...layout, amplitude: 0 } : layout);
      if (still) drawStill();
    };

    const followPointer = () => {
      const rect = canvas.getBoundingClientRect();
      const localX = pointer.clientX - rect.left;
      const localY = pointer.clientY - rect.top;
      const inside =
        pointer.present && localX >= 0 && localX <= rect.width && localY >= 0 && localY <= rect.height;

      if (pointer.present) {
        if (pointer.placed) {
          pointer.sx += (localX - pointer.sx) * 0.12;
          pointer.sy += (localY - pointer.sy) * 0.12;
        } else {
          pointer.sx = localX;
          pointer.sy = localY;
          pointer.placed = true;
        }
      }
      pointer.influence += ((inside ? 1 : 0) - pointer.influence) * 0.08;
      // Once the push has faded out, a hard zero lets the drawing skip its exponential maths.
      if (!inside && pointer.influence < 0.001) pointer.influence = 0;
    };

    const frame = () => {
      frameId = requestAnimationFrame(frame);
      if (!scene) return;
      followPointer();
      drawLoom(ctx, scene, performance.now() - startedAt, pointer);
    };

    const syncLoop = () => {
      const shouldRun = onScreen && !document.hidden;
      if (shouldRun && frameId === 0) {
        frameId = requestAnimationFrame(frame);
      } else if (!shouldRun && frameId !== 0) {
        cancelAnimationFrame(frameId);
        frameId = 0;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      pointer.clientX = event.clientX;
      pointer.clientY = event.clientY;
      pointer.present = true;
    };
    const onPointerLeave = () => {
      pointer.present = false;
    };

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(parent);

    if (still) {
      return () => resizeObserver.disconnect();
    }

    const visibilityObserver = new IntersectionObserver((entries) => {
      onScreen = entries[entries.length - 1].isIntersecting;
      syncLoop();
    });
    visibilityObserver.observe(canvas);

    window.addEventListener("pointermove", onPointerMove);
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
    document.addEventListener("visibilitychange", syncLoop);
    syncLoop();

    return () => {
      if (frameId !== 0) cancelAnimationFrame(frameId);
      frameId = 0;
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", syncLoop);
    };
  }, [still]);

  return <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />;
}
