import type { AgAiEvent, AgLlmAdapter, AgLlmRequest, AgLlmResponse } from "ag-studio";
import { readError, SessionSchema } from "../console/api";

type Answer = { readonly events: readonly AgAiEvent[]; readonly response: AgLlmResponse };

async function csrfToken(signal: AbortSignal | undefined): Promise<string> {
  const response = await fetch("/api/session", { credentials: "same-origin", signal });
  if (!response.ok) throw await readError(response);
  return SessionSchema.parse(await response.json()).csrf;
}

async function askRoute(request: AgLlmRequest, signal: AbortSignal | undefined): Promise<Answer> {
  const response = await fetch("/api/studio/turn", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-mend-csrf": await csrfToken(signal) },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as Answer;
}

/**
 * Hands Studio's whole request to our own route, which calls Claude and does all the
 * translating. A failed turn is reported once, through complete, as Studio's loop expects.
 */
export const studioAdapter: AgLlmAdapter = {
  executeTurn(request, options) {
    const turn = askRoute(request, options?.signal);
    const complete = turn.then((answer) => answer.response);
    // Nothing else may hold the failure: Studio can stop reading a stream without awaiting complete.
    void complete.catch(() => undefined);
    async function* events(): AsyncGenerator<AgAiEvent> {
      const answer = await turn.catch(() => null);
      if (answer !== null) yield* answer.events;
    }
    return { stream: { [Symbol.asyncIterator]: events }, complete };
  },
};
