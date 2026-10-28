// Covers the response headers next.config.ts asks Next.js to add, and that their source
// pattern matches the home page, the pages, the API routes and the webhook, read through
// the matcher Next.js builds for a header rule (server/lib/router-utils/filesystem.js
// buildCustomRoute, Next 16.4.2). Does NOT cover: a running server really sending them
// (check a deployed answer with curl -I), or browsers honouring Strict-Transport-Security,
// which they do only over https.
import { modifyRouteRegex } from "next/dist/lib/redirect-status";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { describe, expect, it } from "vitest";
import config from "../next.config";

describe("next.config.ts", () => {
  it("sends Strict-Transport-Security and X-Content-Type-Options nosniff on every answer", async () => {
    const rules = (await config.headers?.()) ?? [];
    expect(rules).toEqual([
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ]);
    const matches = getPathMatch(rules[0].source, { strict: true, removeUnnamedParams: true, regexModifier: (regex) => modifyRouteRegex(regex) });
    for (const pathname of ["/", "/docs", "/api/webhooks/paypal", "/api/join/paypal/start", "/api/campaigns/0b6c2f8e-6a4e-4c1b-9d2a-7e5f1a3b9c4d/approve"]) {
      expect(matches(pathname), pathname).not.toBe(false);
    }
  });
});
