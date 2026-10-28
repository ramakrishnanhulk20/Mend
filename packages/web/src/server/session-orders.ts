/**
 * The PayPal orders each session bought through the simulate button, so the assistant
 * shows a demo visitor only PayPal data that visitor created (C18, C19, PayPal Developer
 * Agreement 10.1.4(b)). runs.ts writes here when a simulate answer reaches its session;
 * agent.ts reads here before a demo visitor's get_order is sent to PayPal.
 *
 * Kept in this process's memory: at most 50 orders per session, each for 24 hours from
 * when it was bought, swept on every write, so memory stays bounded by the simulate caps
 * (ratelimit.ts). Ids are compared exactly as PayPal wrote them; get_order's input schema
 * accepts the same capitals and digits, so both sides come out of one form.
 *
 * Fails closed: a restart, or a second web instance, forgets orders, which only means a
 * demo visitor is refused an order it did buy. Does not cover the owner, who may read any
 * of the shop's orders.
 */
export const MAX_ORDERS_PER_SESSION = 50;
export const ORDER_MEMORY_MS = 24 * 60 * 60 * 1000;
const SESSION_ID = /^[0-9a-f]{64}$/;
const ORDER_ID = /^[A-Z0-9]{1,36}$/;

// Session id hash, then order id, then when it was bought. Maps keep insertion order, so
// the first entry of a session is always its oldest order.
const bought = new Map<string, Map<string, number>>();

function sweep(now: number): void {
  for (const [session, orders] of bought) {
    for (const [order, at] of orders) if (now - at >= ORDER_MEMORY_MS) orders.delete(order);
    if (orders.size === 0) bought.delete(session);
  }
}

/** Remember that the session with id hash sessionId bought orderId at now. Ids of any other shape are ignored. */
export function rememberSessionOrder(sessionId: string, orderId: string, now: number = Date.now()): void {
  if (!SESSION_ID.test(sessionId) || !ORDER_ID.test(orderId)) return;
  sweep(now);
  const orders = bought.get(sessionId) ?? new Map<string, number>();
  if (!orders.has(orderId)) orders.set(orderId, now);
  while (orders.size > MAX_ORDERS_PER_SESSION) {
    const oldest = orders.keys().next().value;
    if (oldest === undefined) break;
    orders.delete(oldest);
  }
  bought.set(sessionId, orders);
}

/** True only when the session with id hash sessionId bought orderId through simulate in the last 24 hours. */
export function sessionBoughtOrder(sessionId: string, orderId: string, now: number = Date.now()): boolean {
  const at = bought.get(sessionId)?.get(orderId);
  return at !== undefined && now - at < ORDER_MEMORY_MS;
}
