export const runtime = "nodejs";

/** Liveness only: says the server answers, and nothing about PayPal or the database. */
export function GET(): Response {
  return new Response("ok", {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
