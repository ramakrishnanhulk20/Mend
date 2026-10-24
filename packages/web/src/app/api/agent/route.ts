import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runAgent } from "@/server/agent";
import { aiRefusal, failureStatus, hasClaudeKey } from "@/server/claude";
import { readJsonBody, stateChangeProblem } from "@/server/csrf";
import { EngineUnavailable } from "@/server/engine";
import { writeLog } from "@/server/log";
import { authorize, failed, refuse, reply, signedIn } from "@/server/permissions";

export const runtime = "nodejs";

const ROUTE = "POST /api/agent";
const MAX_BODY_BYTES = 64 * 1024;
const BODY_STATUS = { not_json: 415, too_large: 413 } as const;
const TOOL_NAME = /^[a-z][a-z_]{0,40}$/;

const BODY = z.strictObject({
  message: z.string().min(1).max(2000),
  history: z
    .array(z.strictObject({ role: z.enum(["owner", "agent"]), text: z.string().min(1).max(4000) }))
    .max(10)
    .optional(),
});

const ANSWER = z.strictObject({
  reply: z.string().min(1).max(4000),
  toolsUsed: z.array(z.string().regex(TOOL_NAME)).max(20),
  stopped: z.enum(["tool_limit", "declined"]).nullable(),
  aiCalls: z.number().int().min(0),
});

/**
 * Ask the assistant (C2, C11, C12, C14, C20). Body: message, plus up to 10 earlier
 * messages of this browser's own chat as history. Same origin and CSRF token
 * required; every Claude call, each tool-runner round included, counts against the
 * daily caps. The assistant answers through Mend's guarded tools only and can never
 * approve, pay or refund. Answers 200 with a plain-text reply, the tools it used and
 * the Claude calls it made; 503 saying plainly that a key is needed when none is set;
 * 429 with a clear message once the daily limit is used up; or a refusal.
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
    const body = BODY.safeParse(reading.body);
    if (!body.success) return refuse(ROUTE, ref, 400, "invalid_input", { reason: "schema" });
    if (!hasClaudeKey()) return aiRefusal(ROUTE, ref, 503, "no_key");

    const answer = await runAgent(principal, body.data.message, body.data.history ?? [], ref);
    if (answer.kind === "failed") {
      return aiRefusal(ROUTE, ref, failureStatus(answer.failure), answer.failure, { tools: answer.toolsUsed.join(","), ai_calls: answer.aiCalls });
    }
    writeLog({ kind: "api", route: ROUTE, ref, status: 200, outcome: "replied", tools: answer.toolsUsed.join(","), stopped: answer.stopped, ai_calls: answer.aiCalls });
    return reply(200, ANSWER.parse({ reply: answer.reply, toolsUsed: answer.toolsUsed.slice(0, 20), stopped: answer.stopped, aiCalls: answer.aiCalls }));
  } catch (error) {
    return failed(ROUTE, ref, error, error instanceof EngineUnavailable ? 503 : 500);
  }
}
