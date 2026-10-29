import type { NextConfig } from "next";

// Lets the lab page show the live site's real numbers on a machine with no engine running.
// Only the dev server reads it, and only an https address with no path counts, so a typo
// or a production build can never send visitors' requests somewhere else.
function devSummaryOrigin(): string | null {
  if (process.env.NODE_ENV !== "development") return null;
  const raw = process.env.MEND_DEV_SUMMARY_ORIGIN;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const bare = url.protocol === "https:" && url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === "";
    return bare ? url.origin : null;
  } catch {
    return null;
  }
}

const nextConfig: NextConfig = {
  // A second build directory lets a proof build run while a dev server owns .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  // Otherwise next dev re-creates the scaffold AGENTS.md this repo does not keep.
  agentRules: false,
  // On every answer, pages and API routes alike: browsers keep to https for a year once
  // they have seen it over https (it is ignored over plain http in development), and never
  // guess a content type other than the one sent.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
  async rewrites() {
    const origin = devSummaryOrigin();
    if (origin === null) return { beforeFiles: [] };
    return { beforeFiles: [{ source: "/api/shop/summary", destination: `${origin}/api/shop/summary` }] };
  },
};

export default nextConfig;
