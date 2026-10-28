import { receiveDelivery } from "@/server/webhooks";

export const runtime = "nodejs";

/**
 * PayPal webhook deliveries. Only rejected deliveries are counted, in memory, so PayPal's
 * own never wait behind an attacker; a sender past its count gets header and signature
 * checks before any query. The body is read as raw bytes up to the size cap, so the exact
 * bytes PayPal signed are the bytes verified and stored (webhooks.ts receiveDelivery).
 */
export async function POST(request: Request): Promise<Response> {
  const result = await receiveDelivery(request);
  const headers = new Headers({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  if (result.retryAfterSeconds !== undefined) headers.set("retry-after", String(result.retryAfterSeconds));
  return new Response(result.body, { status: result.status, headers });
}
