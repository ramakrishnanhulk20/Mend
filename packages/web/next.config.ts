import type { NextConfig } from "next";

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
};

export default nextConfig;
