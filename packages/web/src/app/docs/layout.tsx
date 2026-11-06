import { Banner } from "fumadocs-ui/components/banner";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Mark } from "@/components/brand/Mark";
import { source } from "@/lib/source";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ink";

// The same class as the demo console's primary button. It is repeated here because that
// file is a client module, and a server layout gets a reference from it, not the string.
const PRIMARY_BUTTON = "btn-felt";

function HomeLink() {
  return (
    <Link
      href="/"
      className={`group/link relative text-[14px] text-ink-dim transition-colors duration-200 ease-out hover:text-ink motion-reduce:transition-none ${FOCUS_RING}`}
    >
      Home
      <span
        aria-hidden="true"
        className="absolute inset-x-0 -bottom-1 h-px origin-left scale-x-0 bg-ink transition-transform duration-200 ease-out group-hover/link:scale-x-100 motion-reduce:transition-none"
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
    <span className="brand-word text-[20px]">
      Mend
    </span>
    <span className="font-mono text-[12px] font-normal uppercase tracking-[0.14em] text-ink-faint">Docs</span>
  </>
);

// The docs are light only. The theme library is off, and so is its switch: that library edits
// the class on <html>, and the root layout does not allow for that (it would cause a hydration
// mismatch).
export default function DocsRootLayout({ children }: { children: ReactNode }) {
  return (
    <RootProvider theme={{ enabled: false }}>
      <div className="mend-docs">
        <Banner
          changeLayout={false}
          height="4rem"
          className="mend-docs-bar justify-between whitespace-nowrap border-b border-rule bg-paper/90 px-10 text-left backdrop-blur max-md:hidden"
        >
          <div className="flex items-center gap-4">
            <Link href="/" className={`group inline-flex items-center gap-[10px] text-ink ${FOCUS_RING}`}>
              <Mark size={20} spinOnHover />
              <span className="brand-word text-[20px]">
                Mend
              </span>
            </Link>
            <span className="font-mono text-[12px] font-normal uppercase tracking-[0.14em] text-ink-faint">Docs</span>
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
