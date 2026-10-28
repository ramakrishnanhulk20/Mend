import { randomUUID } from "node:crypto";
import { joinLimits } from "@/server/address-limits";
import { EngineUnavailable, runAndWait } from "@/server/engine";
import { failed, refuse } from "@/server/permissions";
import { clientAddress, recordMemoryRefusal } from "@/server/ratelimit";
import { finishedResponse } from "@/server/runs";

export const runtime = "nodejs";

const ROUTE = "GET /api/join/consent";
const WAIT_MS = 15_000;

/**
 * The words a customer agrees to by joining, as the engine holds them now: 200
 * {shopName, text, hash}. Public, no session. The join link carries hash back, so a
 * join is bound to the exact words shown (C28). 429 past 60 a minute per client
 * address or 1200 from everyone, counted in memory, and 429 too_many_running while two
 * engine calls already run for this address; 503 when the engine has not answered
 * within 15 seconds.
 */
export async function GET(request: Request): Promise<Response> {
  const ref = randomUUID();
  try {
    const address = clientAddress(request.headers);
    const hit = joinLimits.consent.take(address);
    if (!hit.allowed) {
      await recordMemoryRefusal(hit, address);
      return refuse(ROUTE, ref, 429, "rate_limited", { bucket: hit.limit.bucket }, { "retry-after": String(hit.retryAfterSeconds) });
    }
    const waited = await runAndWait("consent_text", [], WAIT_MS, { address });
    if (waited.state === "pending") {
      return refuse(ROUTE, ref, 503, "engine_unavailable", { reason: "consent_still_running", run_id: waited.runId });
    }
    return finishedResponse(ROUTE, ref, "consent_text", waited.runId, waited);
  } catch (error) {
    return failed(ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}
