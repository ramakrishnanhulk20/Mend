"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { MotionConfig, motion, useScroll, useTransform } from "motion/react";
import { Mark } from "@/components/brand/Mark";
import { formatCount, formatUsdCompact } from "@/components/live/summary";
import { HeroFilm } from "./HeroFilm";
import "./world.css";

// One gentle wave every 100px, long enough to cover "went quiet" at any title size.
const STITCH_PATH =
  "M3 7 Q28 3 53 7" +
  Array.from({ length: 19 }, (_, index) => ` T${103 + index * 50} 7`).join("");

export function WorldHero({
  live,
}: {
  live: { quietRegulars: number; paid12mMinor: number } | null;
}) {
  const { scrollY } = useScroll();
  const filmShift = useTransform(scrollY, [0, 600], [0, 40]);
  const heroRef = useRef<HTMLElement>(null);
  const patchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const hero = heroRef.current;
    const patch = patchRef.current;
    if (!hero || !patch) return;
    const measure = () => hero.style.setProperty("--patch-h", `${patch.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(patch);
    return () => observer.disconnect();
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <section ref={heroRef} id="top" className="world-hero">
        <div className="world-film">
          <motion.div className="world-film-shift" style={{ y: filmShift }}>
            <HeroFilm />
          </motion.div>

          <nav className="world-nav" aria-label="Main">
            <Link className="world-brand brand-word group" href="/#top">
              <Mark size={22} spinOnHover />
              Mend
            </Link>
            <div className="world-nav-links">
              <Link className="world-link" href="/#how-it-works">
                How it works
              </Link>
              <Link className="world-link" href="/#results">
                Results
              </Link>
              <Link className="world-link" href="/docs">
                Docs
              </Link>
            </div>
            <div className="world-nav-end">
              <Link className="world-link world-link--phone" href="/docs">
                Docs
              </Link>
              <Link className="world-btn world-btn--primary world-btn--small" href="/demo">
                Run the demo
              </Link>
            </div>
          </nav>
        </div>

        <motion.div
          ref={patchRef}
          className="world-patch"
          initial={{ y: 44, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
        >
          <div className="world-grid">
            <h1 className="poster-title world-title">
              Win back the regulars who{" "}
              <span className="world-nobreak">
                <span className="world-quiet">
                  went quiet
                  <motion.svg
                    className="world-stitch"
                    aria-hidden="true"
                    initial={{ clipPath: "inset(0% 100% 0% 0%)" }}
                    animate={{ clipPath: "inset(0% 0% 0% 0%)" }}
                    transition={{ duration: 0.8, delay: 0.65, ease: "easeOut" }}
                  >
                    <path d={STITCH_PATH} />
                  </motion.svg>
                </span>
                .
              </span>
            </h1>

            <div>
              <p className="world-copy">
                Mend finds the regulars who are drifting away, has Claude draft a small cashback
                thank-you, pays it through PayPal, and holds a random few back so you can measure
                whether it worked.
              </p>
              <div className="world-actions">
                <Link className="world-btn world-btn--primary" href="/demo">
                  Run the live demo
                </Link>
                <Link className="world-btn world-btn--secondary" href="/#how-it-works">
                  How it works
                </Link>
              </div>
              <div className="world-live-slot">
                {live ? (
                  <p className="world-live">
                    <span className="world-live-dot" aria-hidden="true" />
                    Live from the demo shop: {formatCount(live.quietRegulars)} quiet regulars &middot;{" "}
                    {formatUsdCompact(live.paid12mMinor)} spent last year
                  </p>
                ) : (
                  <p className="world-live">
                    <span className="world-live-dot" aria-hidden="true" />
                    Now showing in the PayPal sandbox
                  </p>
                )}
              </div>
              <p className="world-credits">
                PayPal Payouts &middot; Log in with PayPal &middot; Planned with Claude
              </p>
            </div>
          </div>
        </motion.div>
      </section>
    </MotionConfig>
  );
}
