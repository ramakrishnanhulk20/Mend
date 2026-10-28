const SPIN_CLASSES =
  "[transform-box:fill-box] origin-center transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:rotate-90 motion-reduce:transition-none";

type MarkProps = {
  size?: number;
  className?: string;
  /** Turns the red stitch a quarter turn when a parent with the `group` class is hovered. */
  spinOnHover?: boolean;
};

export function Mark({ size = 22, className, spinOnHover = false }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path d="M4 16h8M20 16h8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path
        d="M13 12l6 8M19 12l-6 8"
        stroke="#ff4d2e"
        strokeWidth="2.5"
        strokeLinecap="round"
        className={spinOnHover ? SPIN_CLASSES : undefined}
      />
    </svg>
  );
}
