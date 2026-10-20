import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A second build directory lets a proof build run while a dev server owns .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  // Otherwise next dev re-creates the scaffold AGENTS.md this repo does not keep.
  agentRules: false,
};

export default nextConfig;
