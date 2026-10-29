import { Banner } from "fumadocs-ui/components/banner";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Mark } from "@/components/brand/Mark";
import { source } from "@/lib/source";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-bone";

// The same classes as the demo console's primary button. They are repeated here because that
// file is a client module, and a server layout gets a reference from it, not the string.
const PRIMARY_BUTTON =
  "inline-flex items-center rounded-[8px] bg-accent font-semibold text-ink transition-[background-color,translate] duration-150 ease-out hover:-translate-y-px hover:bg-accent-hi active:translate-y-0";

function HomeLink() {
  return (
    <Link
      href="/"
      className={`group/link relative text-[14px] text-bone-dim transition-colors duration-200 ease-out hover:text-bone motion-reduce:transition-none ${FOCUS_RING}`}
    >
      Home
      <span
        aria-hidden="true"
        className="absolute inset-x-0 -bottom-1 h-px origin-left scale-x-0 bg-bone transition-transform duration-200 ease-out group-hover/link:scale-x-100 motion-reduce:transition-none"
      />
    </Link>
  );
}

function DemoButton() {
  return (
    <Link href="/demo" className={`${PRIMARY_BUTTON} h-9 px-4 text-[14px] ${FOCUS_RING}`}>
      Try the demo
    </Link>
  );
}

// Fumadocs shows this title in its small-screen header. From md up the bar below takes over
// and the copy at the top of the sidebar is hidden in docs.css.
const NAV_TITLE = (
  <>
    <Mark size={20} />
    {/* Inline, because .poster-title sits outside Tailwind's layers and would beat a tracking class. */}
    <span className="poster-title text-[20px]" style={{ letterSpacing: "0.04em" }}>
      Mend
    </span>
    <span className="font-mono text-[12px] font-normal uppercase tracking-[0.14em] text-bone-faint">Docs</span>
  </>
);

// The docs are dark only. Fumadocs keys its dark styles off a .dark class, so the wrapper carries
// it and the theme library is off: that library edits the class on <html>, and the root layout
// does not allow for that (it would cause a hydration mismatch).
export default function DocsRootLayout({ children }: { children: ReactNode }) {
  return (
    <RootProvider theme={{ enabled: false }}>
      <div className="mend-docs dark">
        <Banner
          changeLayout={false}
          height="4rem"
          className="mend-docs-bar justify-between whitespace-nowrap border-b border-rule bg-ink/90 px-10 text-left backdrop-blur max-md:hidden"
        >
          <div className="flex items-center gap-4">
            <Link href="/" className={`group inline-flex items-center gap-[10px] text-bone ${FOCUS_RING}`}>
              <Mark size={20} spinOnHover />
              {/* Inline, because .poster-title sits outside Tailwind's layers and would beat a tracking class. */}
              <span className="poster-title text-[20px]" style={{ letterSpacing: "0.04em" }}>
                Mend
              </span>
            </Link>
            <span className="font-mono text-[12px] font-normal uppercase tracking-[0.14em] text-bone-faint">Docs</span>
          </div>
          <div className="flex items-center gap-6">
            <DemoButton />
            <HomeLink />
          </div>
        </Banner>
        <DocsLayout
          tree={source.getPageTree()}
          nav={{ title: NAV_TITLE, url: "/" }}
          themeSwitch={{ enabled: false }}
          tabs={false}
          sidebar={{
            collapsible: false,
            banner: (
              <div className="flex items-center justify-between gap-4 md:hidden">
                <DemoButton />
                <HomeLink />
              </div>
            ),
          }}
        >
          {children}
        </DocsLayout>
      </div>
    </RootProvider>
  );
}
