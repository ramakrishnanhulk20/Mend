import { handleDelivery, refuseDeclaredLength } from "@/server/webhooks";

export const runtime = "nodejs";

/**
 * PayPal webhook deliveries. The body is read as raw text so the exact bytes PayPal
 * signed are the bytes verified and stored. A declared length over the cap is refused
 * before the body is read.
 */
export async function POST(request: Request): Promise<Response> {
  const result = refuseDeclaredLength(request.headers) ?? (await handleDelivery(await request.text(), request.headers));
  return new Response(result.body, {
    status: result.status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
