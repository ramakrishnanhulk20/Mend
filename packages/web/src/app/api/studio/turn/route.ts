import { randomUUID } from "node:crypto";
import { z } from "zod";
import { aiRefusal, failureStatus, hasClaudeKey } from "@/server/claude";
import { readJsonBody, stateChangeProblem } from "@/server/csrf";
import { writeLog } from "@/server/log";
import { authorize, failed, refuse, reply, signedIn } from "@/server/permissions";
import { clientAddress } from "@/server/ratelimit";
import { runStudioTurn, STUDIO_TOOLS, TURN_BODY } from "@/server/studio-agent";

export const runtime = "nodejs";

const ROUTE = "POST /api/studio/turn";
const MAX_BODY_BYTES = 64 * 1024;
const BODY_STATUS = { not_json: 415, too_large: 413 } as const;

const ID = z.string().min(1).max(128);
const TOOL_NAME = z.enum(STUDIO_TOOLS);

const EVENT = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("TEXT_MESSAGE_START"), messageId: ID, role: z.literal("assistant") }),
  z.strictObject({ type: z.literal("TEXT_MESSAGE_CONTENT"), messageId: ID, delta: z.string() }),
  z.strictObject({ type: z.literal("TEXT_MESSAGE_END"), messageId: ID }),
  z.strictObject({ type: z.literal("TOOL_CALL_START"), toolCallId: ID, toolCallName: TOOL_NAME }),
  z.strictObject({ type: z.literal("TOOL_CALL_ARGS"), toolCallId: ID, delta: z.string() }),
  z.strictObject({ type: z.literal("TOOL_CALL_END"), toolCallId: ID }),
]);

const OUTPUT = z.discriminatedUnion("type", [
  z.strictObject({ id: ID, kind: z.literal("output"), type: z.literal("message"), role: z.literal("assistant"), status: z.literal("completed"), content: z.array(z.strictObject({ type: z.literal("text"), text: z.string(), annotations: z.tuple([]) })) }),
  z.strictObject({ id: ID, kind: z.literal("output"), type: z.literal("function_call"), callId: ID, name: TOOL_NAME, arguments: z.string(), status: z.literal("completed") }),
]);

const ANSWER = z.strictObject({
  events: z.array(EVENT),
  response: z.strictObject({
    id: ID,
    createdAt: z.number().int(),
    status: z.enum(["completed", "incomplete"]),
    incompleteDetails: z.strictObject({ reason: z.literal("max_output_tokens") }).optional(),
    output: z.array(OUTPUT),
    usage: z.strictObject({ inputTokens: z.number().int(), outputTokens: z.number().int(), totalTokens: z.number().int(), cachedInputTokens: z.number().int(), cacheWriteTokens: z.number().int() }),
    model: z.string(),
  }),
});

/**
 * One round of the AG Studio chat panel's loop (C2, C11, C12, C14, C20). Body: Studio's
 * AgLlmRequest, at most 64 KB, with only the tools in STUDIO_TOOLS and no model but
 * Mend's own. Same origin and CSRF token required. Every Claude call counts on the
 * dashboard's own counts, so it can never crowd out a plan or Ask Mend, and a demo session
 * runs one at a time. Answers 200 with the events and final response Studio's adapter hands on; 503
 * saying plainly that a key is needed when none is set; 429 with a clear message once
 * a limit or the session's queue is full; or a refusal.
 */
export async function POST(request: Request): Promise<Response> {
  const ref = randomUUID();
  try {
    const problem = stateChangeProblem(request);
    if (problem !== null) return refuse(ROUTE, ref, 403, "csrf_refused", { reason: problem });
    const access = await authorize("agent.chat", request);
    const principal = access.ok ? signedIn(access.principal) : null;
    if (!access.ok || principal === null) return refuse(ROUTE, ref, access.ok ? 403 : access.status, "not_allowed");
    const reading = await readJsonBody(request, MAX_BODY_BYTES);
    if ("problem" in reading) {
      const status = reading.problem === "not_json" || reading.problem === "too_large" ? BODY_STATUS[reading.problem] : 400;
      return refuse(ROUTE, ref, status, "invalid_input", { reason: reading.problem });
    }
    const body = TURN_BODY.safeParse(reading.body);
    if (!body.success) return refuse(ROUTE, ref, 400, "invalid_input", { reason: "schema" });
    if (!hasClaudeKey()) return aiRefusal(ROUTE, ref, 503, "no_key");

    const turn = await runStudioTurn(principal, body.data, ref, clientAddress(request.headers), request.signal);
    // An owner's calls all share one count, so the owner's plans do not "still work" and the plain words stand.
    if (turn.kind === "failed") return aiRefusal(ROUTE, ref, failureStatus(turn.failure), turn.failure, { ai_calls: turn.aiCalls }, principal.role === "demo" ? "studio" : null);
    writeLog({ kind: "api", route: ROUTE, ref, status: 200, outcome: "replied", tools: turn.tools.join(","), ai_calls: turn.aiCalls });
    return reply(200, ANSWER.parse({ events: turn.events, response: turn.response }));
  } catch (error) {
    return failed(ROUTE, ref, error);
  }
}
