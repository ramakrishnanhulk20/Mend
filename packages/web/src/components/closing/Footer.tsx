import Link from "next/link";
import { Mark } from "@/components/brand/Mark";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-bone";

const UNDERLINE_DRAW =
  "absolute inset-x-0 -bottom-1 h-px origin-left scale-x-0 bg-bone transition-transform duration-200 ease-out";

const LINKS = [
  { label: "How it works", href: "/#how-it-works" },
  { label: "Results", href: "/#results" },
  { label: "Guardrails", href: "/#safety" },
  { label: "Docs", href: "/docs" },
];

export function Footer() {
  return (
    <footer className="flex flex-col gap-6 border-t border-rule bg-ink px-4 py-10 md:flex-row md:items-center md:justify-between md:px-10">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 md:block">
        <div className="flex items-center gap-[10px] text-bone">
          <Mark size={20} />
          {/* Inline, because .poster-title sits outside Tailwind's layers and would beat a tracking class. */}
          <span className="poster-title text-[20px]" style={{ letterSpacing: "0.04em" }}>
            Mend
          </span>
        </div>
        <p className="text-[13px] text-bone-dim md:mt-2">Sandbox only. No real money moves.</p>
      </div>

      <nav aria-label="Footer" className="flex flex-wrap gap-x-7 gap-y-3">
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={`group/link relative text-[14px] text-bone-dim transition-colors duration-200 ease-out hover:text-bone ${FOCUS_RING}`}
          >
            {link.label}
            <span aria-hidden="true" className={`${UNDERLINE_DRAW} group-hover/link:scale-x-100`} />
          </Link>
        ))}
      </nav>
    </footer>
  );
}
