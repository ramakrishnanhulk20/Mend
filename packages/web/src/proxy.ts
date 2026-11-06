import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

/** The Content-Security-Policy for one HTML page. Pure, so the exact text can be tested. */
export function buildCsp(nonce: string, isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-eval'" : ""}`,
    // Stays 'unsafe-inline': Motion and Mermaid write inline styles in the browser, which a nonce cannot reach.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "media-src 'self'",
    "font-src 'self'",
    `connect-src 'self'${isDev ? " ws:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Gives each HTML page a fresh 128-bit nonce and sends the policy naming it. The policy also
 * goes on the forwarded request, because that is where Next reads the nonce to stamp its scripts.
 */
export function proxy(request: NextRequest): NextResponse {
  const policy = buildCsp(randomBytes(16).toString("base64"), process.env.NODE_ENV === "development");
  const headers = new Headers(request.headers);
  headers.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", policy);
  return response;
}

// Skips by exact name, never by file extension, so a missing page such as /no-such.page still
// gets the policy. API routes set their own headers: /api/join/paypal/start sends a stricter one.
export const config = {
  matcher: [
    {
      source: "/((?!(?:api|_next|world)(?:/|$)|(?:icon\\.svg|favicon\\.ico|robots\\.txt|sitemap\\.xml)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
