/** One earlier message of the chat, in the shape the agent route takes as history. */
export type HistoryEntry = { role: "owner" | "agent"; text: string };

export const QUESTION_LIMIT = 2000;
export const HISTORY_LIMIT = 10;
export const HISTORY_TEXT_LIMIT = 4000;

export const TOOL_LABELS: Record<string, string> = {
  shop_summary: "shop numbers",
  quiet_regulars: "quiet regulars",
  draft_campaign: "drafted a campaign",
  view_campaign: "campaign plan",
  campaign_results: "campaign results",
  request_approval: "asked for approval",
  get_order: "PayPal order",
  list_disputes: "PayPal disputes",
  get_dispute: "PayPal dispute",
  show_product_details: "PayPal product",
};

/** The words for a tool in the chips. A name the list does not know is shown as it came. */
export function toolLabel(name: string): string {
  return Object.hasOwn(TOOL_LABELS, name) ? TOOL_LABELS[name] : name;
}

// The route counts characters the way JavaScript does, so a cut at 4000 can land between the two
// halves of an emoji. A lone half is not valid text, so it goes too.
function cutText(text: string): string {
  if (text.length <= HISTORY_TEXT_LIMIT) return text;
  const last = text.charCodeAt(HISTORY_TEXT_LIMIT - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, splitsPair ? HISTORY_TEXT_LIMIT - 1 : HISTORY_TEXT_LIMIT);
}

/**
 * The messages to send along as history: the last 10, each text cut to 4000. Only role and text
 * are kept, because the route refuses a message that carries anything else.
 */
export function trimHistory(messages: readonly HistoryEntry[]): HistoryEntry[] {
  return messages.slice(-HISTORY_LIMIT).map((message) => ({ role: message.role, text: cutText(message.text) }));
}

/** The line shown when a question gets no answer, from the route's status and error code. */
export function askFailureText(status: number, code: string): string {
  if (status === 503 && code === "no_key") return "Claude isn't available on this server right now.";
  if (status === 429 && (code === "limit_reached" || code === "claude_token_cap")) {
    return "This session has used its Claude questions for today.";
  }
  if (status === 400 || status === 413) return "That question is too long. Keep it under 2,000 characters.";
  return "Claude didn't answer. Try again.";
}

/** The three questions offered on an empty chat. The third is about the session's own PayPal order once there is one. */
export function suggestionsFor(orderId: string | null): string[] {
  return [
    "How many quiet regulars does the shop have?",
    "Which regulars are worth a nudge right now?",
    orderId === null ? "Which of these customers can be paid?" : `What happened with PayPal order ${orderId}?`,
  ];
}
