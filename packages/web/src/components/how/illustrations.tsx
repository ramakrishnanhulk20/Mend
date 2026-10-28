import type { CSSProperties, ReactNode } from "react";
import { motion, type Variants } from "motion/react";

const EASE = [0.22, 1, 0.36, 1] as const;

const INK = "#0b0a0a";
const BONE = "#ede6da";
const ACCENT = "#ff4d2e";
const THREAD = "rgb(237 230 218 / 0.35)";
const OUTLINE = "rgb(237 230 218 / 0.6)";
const LABEL = "rgb(237 230 218 / 0.64)";
const DOT = "rgb(237 230 218 / 0.7)";
const CHIP = "rgb(237 230 218 / 0.3)";

const POP_ORIGIN: CSSProperties = { transformBox: "fill-box", transformOrigin: "center" };

// A thread draws itself. The opacity step hides the round cap that some browsers
// paint as a dot when the drawn length is zero.
function draw(delayMs: number, durationMs = 900): Variants {
  return {
    hidden: { pathLength: 0, opacity: 0 },
    shown: {
      pathLength: 1,
      opacity: 1,
      transition: {
        pathLength: { duration: durationMs / 1000, delay: delayMs / 1000, ease: EASE },
        opacity: { duration: 0.01, delay: delayMs / 1000 },
      },
    },
  };
}

function pop(delayMs: number): Variants {
  return {
    hidden: { scale: 0 },
    shown: {
      scale: 1,
      transition: { type: "spring", stiffness: 500, damping: 22, delay: delayMs / 1000 },
    },
  };
}

function fade(delayMs: number, durationMs: number, rise = 0): Variants {
  return {
    hidden: rise ? { opacity: 0, y: rise } : { opacity: 0 },
    shown: {
      opacity: 1,
      ...(rise ? { y: 0 } : {}),
      transition: { duration: durationMs / 1000, delay: delayMs / 1000, ease: EASE },
    },
  };
}

type DrawingProps = { still: boolean };

function Drawing({
  still,
  className = "block h-auto",
  children,
}: DrawingProps & { className?: string; children: ReactNode }) {
  return (
    <motion.svg
      viewBox="0 0 640 220"
      width="100%"
      fill="none"
      aria-hidden="true"
      className={className}
      initial={still ? "shown" : "hidden"}
      whileInView={still ? undefined : "shown"}
      viewport={{ once: true, amount: 0.6 }}
    >
      {children}
    </motion.svg>
  );
}

// On a phone a drawing shrinks to about half its size, so its text is set larger below md.
function Label({ y, children }: { y: number; children: ReactNode }) {
  return (
    <text x={0} y={y} textAnchor="start" fill={LABEL} className="font-mono text-[18px] md:text-[12px]">
      {children}
    </text>
  );
}

function Thread({ d, variants }: { d: string; variants: Variants }) {
  return (
    <motion.path d={d} stroke={THREAD} strokeWidth={1.5} strokeLinecap="round" variants={variants} />
  );
}

const JOIN_THREAD = draw(0);
const JOIN_BUTTON = fade(300, 400, 12);
const JOIN_STITCH = pop(900);

export function JoinDrawing({ still }: DrawingProps) {
  return (
    <Drawing still={still}>
      <Thread d="M0 110H640" variants={JOIN_THREAD} />
      <motion.g variants={JOIN_BUTTON}>
        <rect x={220} y={82} width={200} height={56} rx={8} fill={INK} stroke={OUTLINE} strokeWidth={1.5} />
        <text
          x={320}
          y={116}
          textAnchor="middle"
          fill={BONE}
          fontWeight={600}
          className="text-[22px] md:text-[18px]"
          style={{ fontFamily: "var(--font-sans)" }}
        >
          Join with PayPal
        </text>
      </motion.g>
      <motion.path
        d="M473 103l14 14M487 103l-14 14"
        stroke={ACCENT}
        strokeWidth={2}
        strokeLinecap="round"
        style={POP_ORIGIN}
        variants={JOIN_STITCH}
      />
    </Drawing>
  );
}

const FORECAST_STEADY = draw(0);
const FORECAST_SLIPPING = draw(120);
const FORECAST_GONE = draw(240);
const FORECAST_FIBERS = ["M300 160l9 -3.6", "M300 160l12 -1.7", "M300 160l7 1.2"];
const FORECAST_FIBER_DRAW = draw(900, 300);

export function ForecastDrawing({ still }: DrawingProps) {
  return (
    <Drawing still={still}>
      <Label y={64}>steady</Label>
      <Label y={114}>slipping</Label>
      <Label y={164}>gone quiet</Label>
      <Thread d="M120 60H640" variants={FORECAST_STEADY} />
      <Thread d="M120 110H370M384 110H490M504 110H640" variants={FORECAST_SLIPPING} />
      <Thread d="M120 160H300" variants={FORECAST_GONE} />
      {FORECAST_FIBERS.map((d) => (
        <Thread key={d} d={d} variants={FORECAST_FIBER_DRAW} />
      ))}
    </Drawing>
  );
}

const SPLIT_PAID_Y = 70;
const SPLIT_HELD_Y = 150;
const SPLIT_DRAW = draw(0);

const SPLIT_COLUMNS = [0, 1, 2, 3, 4].map((k) => {
  const x0 = 120 + k * 104;
  const centre = x0 + 40;
  const segments = (y: number) => `M${x0} ${y}H${x0 + 28}M${x0 + 52} ${y}H${x0 + 80}`;
  return {
    k,
    paidSegments: segments(SPLIT_PAID_Y),
    heldSegments: segments(SPLIT_HELD_Y),
    stitch: `M${centre - 6} ${SPLIT_PAID_Y - 6}L${centre + 6} ${SPLIT_PAID_Y + 6}M${centre - 6} ${SPLIT_PAID_Y + 6}L${centre + 6} ${SPLIT_PAID_Y - 6}`,
    dots: [centre - 6, centre, centre + 6],
    stitchPop: pop(500 + k * 120),
    dotsFade: fade(1200 + k * 120, 200),
  };
});

export function SplitDrawing({ still }: DrawingProps) {
  return (
    <Drawing still={still}>
      <Label y={74}>paid</Label>
      <Label y={154}>held back</Label>
      {SPLIT_COLUMNS.map((column) => (
        <g key={column.k}>
          <Thread d={column.paidSegments} variants={SPLIT_DRAW} />
          <Thread d={column.heldSegments} variants={SPLIT_DRAW} />
          <motion.path
            d={column.stitch}
            stroke={ACCENT}
            strokeWidth={2}
            strokeLinecap="round"
            style={POP_ORIGIN}
            variants={column.stitchPop}
          />
          <motion.g variants={column.dotsFade}>
            {column.dots.map((cx) => (
              <circle key={cx} cx={cx} cy={SPLIT_HELD_Y} r={1.5} fill={DOT} />
            ))}
          </motion.g>
        </g>
      ))}
    </Drawing>
  );
}

const MEASURE_DRAW = draw(0);
const MEASURE_QUESTION = fade(700, 300);
const MEASURE_CHIPS = [
  { text: "yes", x: 470, y: 160, width: 44, stroke: CHIP, variants: fade(1000, 300) },
  { text: "no", x: 522, y: 160, width: 40, stroke: CHIP, variants: fade(1100, 300) },
  { text: "too early to tell", x: 470, y: 196, width: 170, stroke: ACCENT, variants: fade(1200, 300) },
];

// The last chip ends 4 units below the 220 high frame, so this drawing is allowed to paint past it.
export function MeasureDrawing({ still }: DrawingProps) {
  return (
    <Drawing still={still} className="block h-auto overflow-visible">
      <Label y={64}>paid</Label>
      <Label y={164}>held back</Label>
      <Thread d="M120 60H360C400 60 410 110 440 110" variants={MEASURE_DRAW} />
      <Thread d="M120 160H360C400 160 410 110 440 110" variants={MEASURE_DRAW} />
      <Thread d="M440 110H470" variants={MEASURE_DRAW} />
      <motion.g variants={MEASURE_QUESTION}>
        <rect x={470} y={86} width={150} height={48} rx={8} fill={INK} stroke={OUTLINE} strokeWidth={1.5} />
        <text x={545} y={116} textAnchor="middle" fill={BONE} className="font-mono text-[18px] md:text-[13px]">
          did it work?
        </text>
      </motion.g>
      {MEASURE_CHIPS.map((chip) => (
        <motion.g key={chip.text} variants={chip.variants}>
          <rect x={chip.x} y={chip.y} width={chip.width} height={28} rx={6} stroke={chip.stroke} />
          <text
            x={chip.x + chip.width / 2}
            y={chip.y + 18}
            textAnchor="middle"
            fill={LABEL}
            className="font-mono text-[15px] md:text-[11px]"
          >
            {chip.text}
          </text>
        </motion.g>
      ))}
    </Drawing>
  );
}
