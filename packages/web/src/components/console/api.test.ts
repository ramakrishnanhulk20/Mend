// Covers the console's fetch client against a scripted fake fetch: the token handling, error
// reading, polling a 202 run and answer checking. Does NOT cover the real routes, cookies or
// the browser; those are checked by hand against a running app.
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, QuietRegularsSchema, createConsoleApi, parseRetryAfter, readError } from "./api";

const CAMPAIGN = "0b6f1c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e";
const HASH = "ab".repeat(32);

type Call = { url: string; method: string; headers: Record<string, string>; credentials: string | undefined };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function fakeFetch(answer: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      credentials: init?.credentials,
    };
    calls.push(call);
    return answer(call, calls.length - 1);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const DEMO_ANSWER = { signedIn: true, role: "demo", expiresAt: "2026-10-28T12:00:00.000Z", csrf: "c2.second" };

afterEach(() => {
  vi.useRealTimers();
});

describe("the token", () => {
  it("is read from the session, sent on the next POST, and replaced by the demo answer's", async () => {
    const { fetchFn, calls } = fakeFetch((call) => {
      if (call.url === "/api/session") return json(200, { signedIn: false, csrf: "c2.first" });
      if (call.url === "/api/session/demo") return json(200, DEMO_ANSWER);
      if (call.url === "/api/session/logout") return json(200, { signedIn: false });
      throw new Error(`nothing scripted for ${call.url}`);
    });
    const api = createConsoleApi(fetchFn);

    await api.session();
    const demo = await api.startDemo();
    await api.logout();

    expect(demo.csrf).toBe("c2.second");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/session", "POST /api/session/demo", "POST /api/session/logout"]);
    expect(calls[0].headers["x-mend-csrf"]).toBeUndefined();
    expect(calls[1].headers["x-mend-csrf"]).toBe("c2.first");
    expect(calls[2].headers["x-mend-csrf"]).toBe("c2.second");
    expect(calls.every((c) => c.credentials === "same-origin")).toBe(true);
  });

  it("is fetched first when a POST goes out before any session read, and dropped after logout", async () => {
    let reads = 0;
    const { fetchFn, calls } = fakeFetch((call) => {
      if (call.url === "/api/session") {
        reads += 1;
        return json(200, { signedIn: false, csrf: `c2.read${reads}` });
      }
      if (call.url === "/api/session/demo") return json(200, DEMO_ANSWER);
      return json(200, { signedIn: false });
    });
    const api = createConsoleApi(fetchFn);

    await api.startDemo();
    await api.logout();
    await api.request("POST", "/api/anything", z.looseObject({}));

    expect(calls[1].headers["x-mend-csrf"]).toBe("c2.read1");
    expect(calls[2].headers["x-mend-csrf"]).toBe("c2.second");
    expect(calls[3].url).toBe("/api/session");
    expect(calls[4].headers["x-mend-csrf"]).toBe("c2.read2");
  });

  it("makes one request when the session is read twice at once", async () => {
    const { fetchFn, calls } = fakeFetch(() => json(200, { signedIn: false, csrf: "c2.only" }));
    const api = createConsoleApi(fetchFn);

    const [a, b] = await Promise.all([api.session(), api.session()]);

    expect(calls).toHaveLength(1);
    expect(a).toBe(b);
  });
});

describe("a refusal", () => {
  it("becomes an ApiError with the status, code, ref and Retry-After", async () => {
    const { fetchFn } = fakeFetch(() => json(429, { error: "rate_limited", message: "Too many.", ref: "abc-123" }, { "retry-after": "120" }));
    const api = createConsoleApi(fetchFn);

    const error = await api.request("GET", "/api/x", z.looseObject({})).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: "rate_limited", retryAfterSeconds: 120, ref: "abc-123" });
  });

  it("reads a body that is not JSON as code unexpected", async () => {
    const response = new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
    const error = await readError(response);

    expect(error).toMatchObject({ status: 502, code: "unexpected", retryAfterSeconds: null, ref: null });
  });

  it("reads a JSON body with no error code as code unexpected", async () => {
    const error = await readError(json(500, { detail: "nope" }));

    expect(error).toMatchObject({ status: 500, code: "unexpected" });
  });

  it("is a network ApiError when the request never arrives", async () => {
    const fetchFn = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const api = createConsoleApi(fetchFn);

    await expect(api.request("GET", "/api/x", z.looseObject({}))).rejects.toMatchObject({ status: 0, code: "network" });
  });
});

describe("a run that is still going", () => {
  it("is polled every 2 seconds until the final body arrives", async () => {
    vi.useFakeTimers();
    const { fetchFn, calls } = fakeFetch((call, index) => {
      if (index === 0) return json(202, { status: "running", runId: "brn-abc123" });
      if (index === 1) return json(202, { status: "running", runId: "brn-abc123" });
      return json(200, { total: 1357 });
    });
    const api = createConsoleApi(fetchFn);

    const result = api.request("GET", "/api/shop/quiet-regulars?limit=50", z.looseObject({ total: z.number() }));
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(result).resolves.toMatchObject({ total: 1357 });
    expect(calls.map((c) => c.url)).toEqual([
      "/api/shop/quiet-regulars?limit=50",
      "/api/runs/brn-abc123",
      "/api/runs/brn-abc123",
    ]);
  });

  it("gives up with still_running after 120 seconds", async () => {
    vi.useFakeTimers();
    const { fetchFn, calls } = fakeFetch(() => json(202, { status: "running", runId: "brn-abc123" }));
    const api = createConsoleApi(fetchFn);

    const outcome = expect(api.request("GET", "/api/x", z.looseObject({}))).rejects.toMatchObject({
      status: 504,
      code: "still_running",
    });
    await vi.advanceTimersByTimeAsync(125_000);

    await outcome;
    expect(calls).toHaveLength(61);
  });

  it("throws the refusal a poll answers with", async () => {
    vi.useFakeTimers();
    const { fetchFn } = fakeFetch((call, index) =>
      index === 0 ? json(202, { status: "running", runId: "brn-abc123" }) : json(404, { error: "not_found", ref: "r1" }),
    );
    const api = createConsoleApi(fetchFn);

    const outcome = expect(api.request("GET", "/api/x", z.looseObject({}))).rejects.toMatchObject({ status: 404, code: "not_found" });
    await vi.advanceTimersByTimeAsync(2000);

    await outcome;
  });
});

describe("an answer", () => {
  it("that fails its schema is an unexpected_answer ApiError", async () => {
    const { fetchFn } = fakeFetch(() => json(200, { total: "many", rows: [] }));
    const api = createConsoleApi(fetchFn);

    await expect(api.quietRegulars(50)).rejects.toMatchObject({ code: "unexpected_answer" });
  });

  it("that fits the quiet regulars shape comes back with its fields", async () => {
    const answer = {
      asOf: "2026-10-16",
      total: 1357,
      worthANudge: 1110,
      likelyGone: 77,
      likelyBack: 170,
      rows: [{ position: 1, displayName: "Priya X.", purchaseDays: 7, daysSilent: 95, score: 0.08, paidNetMinor: 4821, member: true, extra: 1 }],
    };
    const { fetchFn, calls } = fakeFetch(() => json(200, answer));
    const api = createConsoleApi(fetchFn);

    const result = await api.quietRegulars(50);

    expect(calls[0].url).toBe("/api/shop/quiet-regulars?limit=50");
    expect(QuietRegularsSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ total: 1357, worthANudge: 1110, likelyGone: 77, likelyBack: 170 });
    expect(result.rows[0]).toMatchObject({ displayName: "Priya X.", paidNetMinor: 4821, member: true });
  });

  it.each([
    ["no forecast group counts", { worthANudge: undefined, likelyGone: undefined, likelyBack: undefined }],
    ["no worth-a-nudge count", { worthANudge: undefined }],
    ["a group count as text", { likelyGone: "77" }],
    ["a group count that is not a whole number", { likelyBack: 1.5 }],
    ["a negative group count", { likelyGone: -1 }],
  ])("that has %s is an unexpected_answer ApiError", async (_label, change) => {
    const answer = { asOf: "2026-10-16", total: 1357, worthANudge: 1110, likelyGone: 77, likelyBack: 170, rows: [], ...change };
    const { fetchFn } = fakeFetch(() => json(200, answer));

    await expect(createConsoleApi(fetchFn).quietRegulars(50)).rejects.toMatchObject({ code: "unexpected_answer" });
  });
});

const DRAFT = { campaignId: CAMPAIGN, candidates: 10, rewarded: 5, heldBack: 5, totalMinor: 1000 };
const PLAN = {
  settings: {
    goalText: "Bring back my quiet regulars",
    asOf: "2026-10-16",
    budgetMinor: 1000,
    perRecipientMinor: 200,
    holdoutShare: "0.50",
    maxCandidates: 10,
  },
  changes: ["The reward was cut to USD 2.00, the demo's cap per person."],
  goal: "read",
  notice: null,
};

describe("the plan call", () => {
  it("posts the goal and reads the draft with its plan", async () => {
    const { fetchFn, calls } = fakeFetch((call) => {
      if (call.url === "/api/session") return json(200, { signedIn: false, csrf: "c2.first" });
      return json(201, { ...DRAFT, plan: PLAN, aiCalls: 1 });
    });
    const api = createConsoleApi(fetchFn);

    const draft = await api.plan("Bring back my quiet regulars");

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/session", "POST /api/campaigns/plan"]);
    expect(calls[1].headers["x-mend-csrf"]).toBe("c2.first");
    expect(draft.rewarded).toBe(5);
    expect(draft.plan?.settings?.holdoutShare).toBe("0.50");
    expect(draft.plan?.changes).toHaveLength(1);
  });

  it("reads a 422 needs_budget as an ApiError that keeps the server's message", async () => {
    const message = "The AI service is busy right now. Try again in a minute. Give a budget, in the goal or in the form.";
    const { fetchFn } = fakeFetch((call) =>
      call.url === "/api/session"
        ? json(200, { signedIn: false, csrf: "c2.first" })
        : json(422, { error: "needs_budget", message, ref: "r-1" }),
    );
    const api = createConsoleApi(fetchFn);

    const error = await api.plan("Win them back").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: "needs_budget", message, ref: "r-1" });
  });

  it("reads a polled answer, which has no plan, as a draft", async () => {
    vi.useFakeTimers();
    const { fetchFn, calls } = fakeFetch((call) => {
      if (call.url === "/api/session") return json(200, { signedIn: false, csrf: "c2.first" });
      if (call.url === "/api/campaigns/plan") return json(202, { status: "running", runId: "brn-plan1", plan: PLAN, aiCalls: 1 });
      return json(201, DRAFT);
    });
    const api = createConsoleApi(fetchFn);

    const result = api.plan("Win them back");
    await vi.advanceTimersByTimeAsync(2000);
    const draft = await result;

    expect(calls.map((c) => c.url)).toEqual(["/api/session", "/api/campaigns/plan", "/api/runs/brn-plan1"]);
    expect(draft.plan).toBeUndefined();
    expect(draft).toMatchObject({ campaignId: CAMPAIGN, rewarded: 5, heldBack: 5, totalMinor: 1000 });
  });
});

describe("the campaign calls", () => {
  const VIEW = {
    campaignId: CAMPAIGN,
    status: "draft",
    goalText: "Bring back my quiet regulars",
    asOf: "2026-10-16",
    budgetMinor: 1000,
    perRecipientMinor: 200,
    holdoutShare: "0.50",
    totalMinor: 1000,
    rows: [
      { ref: "R1", role: "reward", rank: 1, amountMinor: 200, note: "Thank you for the tea.", standIn: false },
      { ref: "R7", role: "holdout", rank: 2, amountMinor: null, note: null, standIn: true },
    ],
    reviewHash: HASH,
    reviewProblem: null,
  };

  it("reads a campaign view with its rows and review hash", async () => {
    const { fetchFn, calls } = fakeFetch(() => json(200, VIEW));
    const api = createConsoleApi(fetchFn);

    const view = await api.view(CAMPAIGN);

    expect(calls[0]).toMatchObject({ method: "GET", url: `/api/campaigns/${CAMPAIGN}` });
    expect(view.rows.map((r) => r.role)).toEqual(["reward", "holdout"]);
    expect(view.rows[1]).toMatchObject({ amountMinor: null, note: null, standIn: true });
    expect(view.reviewHash).toBe(HASH);
  });

  it("keeps a row's displayName when it is a string", async () => {
    const named = { ...VIEW, rows: [{ ...VIEW.rows[0], displayName: "Priya X." }] };
    const { fetchFn } = fakeFetch(() => json(200, named));
    const view = await createConsoleApi(fetchFn).view(CAMPAIGN);

    expect(view.rows[0].displayName).toBe("Priya X.");
  });

  it("reads a row whose displayName is null because the customer left the list", async () => {
    const left = { ...VIEW, rows: [{ ...VIEW.rows[0], displayName: null }] };
    const { fetchFn } = fakeFetch(() => json(200, left));
    const view = await createConsoleApi(fetchFn).view(CAMPAIGN);

    expect(view.rows[0].displayName).toBeNull();
  });

  it("reads a row with no displayName at all, as older answers have", async () => {
    const { fetchFn } = fakeFetch(() => json(200, VIEW));
    const view = await createConsoleApi(fetchFn).view(CAMPAIGN);

    expect(view.rows[0].displayName).toBeUndefined();
  });

  it("refuses a view whose displayName is not text", async () => {
    const bad = { ...VIEW, rows: [{ ...VIEW.rows[0], displayName: 7 }] };
    const { fetchFn } = fakeFetch(() => json(200, bad));

    await expect(createConsoleApi(fetchFn).view(CAMPAIGN)).rejects.toMatchObject({ code: "unexpected_answer" });
  });

  it("sends the presented hash with an approval", async () => {
    let sent: unknown = null;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/session") return json(200, { signedIn: false, csrf: "c2.first" });
      sent = JSON.parse(String(init?.body));
      return json(200, { campaignId: CAMPAIGN, snapshotHash: HASH, approvedAt: "2026-10-28T10:15:00.000Z" });
    }) as typeof fetch;
    const api = createConsoleApi(fetchFn);

    const approved = await api.approve(CAMPAIGN, HASH);

    expect(sent).toEqual({ presentedHash: HASH });
    expect(approved.snapshotHash).toBe(HASH);
  });

  it("turns a 409 hash_mismatch into an ApiError with that code", async () => {
    const { fetchFn } = fakeFetch((call) =>
      call.url === "/api/session" ? json(200, { signedIn: false, csrf: "c2.first" }) : json(409, { error: "hash_mismatch", ref: "r-2" }),
    );
    const api = createConsoleApi(fetchFn);

    await expect(api.approve(CAMPAIGN, HASH)).rejects.toMatchObject({ status: 409, code: "hash_mismatch" });
  });

  it("reads the notes counts", async () => {
    const { fetchFn, calls } = fakeFetch((call) =>
      call.url === "/api/session"
        ? json(200, { signedIn: false, csrf: "c2.first" })
        : json(200, { campaignId: CAMPAIGN, rewarded: 5, written: 4, template: 1, skipped: 0, ai: "used", stopped: null, notice: null, aiCalls: 5 }),
    );
    const api = createConsoleApi(fetchFn);

    const notes = await api.writeNotes(CAMPAIGN);

    expect(calls[1]).toMatchObject({ method: "POST", url: `/api/campaigns/${CAMPAIGN}/notes` });
    expect(notes).toMatchObject({ written: 4, template: 1, ai: "used" });
  });

  it("refuses a view whose rows have an unknown role", async () => {
    const bad = { ...VIEW, rows: [{ ...VIEW.rows[0], role: "bonus" }] };
    const { fetchFn } = fakeFetch(() => json(200, bad));
    const api = createConsoleApi(fetchFn);

    await expect(api.view(CAMPAIGN)).rejects.toMatchObject({ code: "unexpected_answer" });
  });
});

const RESULTS = {
  campaignId: CAMPAIGN,
  status: "approved",
  rewarded: { members: 5, realReturns: 0, realRate: 0, simulatedReturns: 1 },
  holdout: { members: 5, realReturns: 0, realRate: null, simulatedReturns: 0 },
  spendMinor: 1000,
  feesMinor: 0,
  windowStartsAt: "2026-10-28T10:15:00+00:00",
  windowEndsAt: "2026-11-27T10:15:00+00:00",
  windowOpen: true,
  pValue: null,
  verdict: "too early to tell",
  payouts: {
    items: 5,
    byStatus: { UNCLAIMED: 4, SUCCESS: 1 },
    claimedMinor: 200,
    unclaimedMinor: 800,
    returnedMinor: 0,
    failedMinor: 0,
    pendingMinor: 0,
    unclaimedReturnBy: "2026-11-27T10:15:00+00:00",
  },
  rows: [
    { ref: "R1", role: "reward", rank: 1, standIn: false, payoutStatus: "SUCCESS", simulatedReturn: false, realReturn: false },
    { ref: "R2", role: "reward", rank: 2, standIn: true, payoutStatus: "UNCLAIMED", simulatedReturn: true, realReturn: false },
    { ref: "R6", role: "holdout", rank: 6, standIn: true, payoutStatus: null, simulatedReturn: false, realReturn: false },
  ],
};

const CANCEL_WHOLE = {
  campaignId: CAMPAIGN,
  cancelled: 4,
  returnedMinor: 800,
  stillUnclaimed: 0,
  notCancellable: 1,
  incomplete: false,
  paypalStatus: null,
  paypalName: null,
};

const CANCEL_PARTIAL = {
  campaignId: CAMPAIGN,
  cancelled: 2,
  returnedMinor: 400,
  stillUnclaimed: 2,
  notCancellable: 0,
  incomplete: true,
  paypalStatus: 500,
  paypalName: "INTERNAL_SERVICE_ERROR",
};

function withSession(answer: (call: Call, index: number) => Response) {
  return fakeFetch((call, index) =>
    call.url === "/api/session" ? json(200, { signedIn: false, csrf: "c2.first" }) : answer(call, index),
  );
}

describe("the payout and results calls", () => {
  it("submits with no body and reads the batch id", async () => {
    const { fetchFn, calls } = withSession(() =>
      json(200, { campaignId: CAMPAIGN, status: "submitted", sent: true, payoutBatchId: "BATCH123" }),
    );
    const api = createConsoleApi(fetchFn);

    const sent = await api.submit(CAMPAIGN);

    expect(calls[1]).toMatchObject({ method: "POST", url: `/api/campaigns/${CAMPAIGN}/submit` });
    expect(calls[1].headers["x-mend-csrf"]).toBe("c2.first");
    expect(sent).toMatchObject({ sent: true, payoutBatchId: "BATCH123" });
  });

  it("reads a repeat submit that sent nothing", async () => {
    const { fetchFn } = withSession(() =>
      json(200, { campaignId: CAMPAIGN, status: "submitted", sent: false, payoutBatchId: null }),
    );
    const api = createConsoleApi(fetchFn);

    await expect(api.submit(CAMPAIGN)).resolves.toMatchObject({ sent: false, payoutBatchId: null });
  });

  it("reads the results with the payouts and every row", async () => {
    const { fetchFn, calls } = fakeFetch(() => json(200, RESULTS));
    const api = createConsoleApi(fetchFn);

    const results = await api.results(CAMPAIGN);

    expect(calls[0]).toMatchObject({ method: "GET", url: `/api/campaigns/${CAMPAIGN}/results` });
    expect(results.verdict).toBe("too early to tell");
    expect(results.rewarded.realRate).toBe(0);
    expect(results.holdout.realRate).toBeNull();
    expect(results.payouts).toMatchObject({ unclaimedMinor: 800, byStatus: { UNCLAIMED: 4, SUCCESS: 1 } });
    expect(results.rows.map((row) => [row.ref, row.payoutStatus, row.simulatedReturn])).toEqual([
      ["R1", "SUCCESS", false],
      ["R2", "UNCLAIMED", true],
      ["R6", null, false],
    ]);
  });

  it("reads a results row's displayName as a string, as null, or absent", async () => {
    const mixed = {
      ...RESULTS,
      rows: [{ ...RESULTS.rows[0], displayName: "Priya X." }, { ...RESULTS.rows[1], displayName: null }, RESULTS.rows[2]],
    };
    const { fetchFn } = fakeFetch(() => json(200, mixed));
    const results = await createConsoleApi(fetchFn).results(CAMPAIGN);

    expect(results.rows.map((row) => row.displayName)).toEqual(["Priya X.", null, undefined]);
  });

  it("refuses results whose rows have an unknown role", async () => {
    const bad = { ...RESULTS, rows: [{ ...RESULTS.rows[0], role: "bonus" }] };
    const { fetchFn } = fakeFetch(() => json(200, bad));
    const api = createConsoleApi(fetchFn);

    await expect(api.results(CAMPAIGN)).rejects.toMatchObject({ code: "unexpected_answer" });
  });

  it("posts the ref with a simulated purchase and reads PayPal's order", async () => {
    let sent: unknown = null;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/session") return json(200, { signedIn: false, csrf: "c2.first" });
      sent = JSON.parse(String(init?.body));
      return json(201, { campaignId: CAMPAIGN, ref: "R2", paypalOrderId: "5O190127TN364715T", paypalStatus: "COMPLETED" });
    }) as typeof fetch;
    const api = createConsoleApi(fetchFn);

    const order = await api.simulate(CAMPAIGN, "R2");

    expect(sent).toEqual({ ref: "R2" });
    expect(order).toMatchObject({ paypalOrderId: "5O190127TN364715T", paypalStatus: "COMPLETED" });
  });

  it("reads a whole take-back", async () => {
    const { fetchFn, calls } = withSession(() => json(200, CANCEL_WHOLE));
    const api = createConsoleApi(fetchFn);

    const cancelled = await api.cancelUnclaimed(CAMPAIGN);

    expect(calls[1]).toMatchObject({ method: "POST", url: `/api/campaigns/${CAMPAIGN}/cancel-unclaimed` });
    expect(cancelled).toMatchObject({ cancelled: 4, returnedMinor: 800, incomplete: false, paypalStatus: null });
  });

  it("reads a partial take-back with PayPal's error status and name", async () => {
    const { fetchFn } = withSession(() => json(200, CANCEL_PARTIAL));
    const api = createConsoleApi(fetchFn);

    const cancelled = await api.cancelUnclaimed(CAMPAIGN);

    expect(cancelled).toMatchObject({
      incomplete: true,
      stillUnclaimed: 2,
      paypalStatus: 500,
      paypalName: "INTERNAL_SERVICE_ERROR",
    });
  });

  it("turns a 409 not_submitted into an ApiError with that code", async () => {
    const { fetchFn } = withSession(() => json(409, { error: "not_submitted", ref: "r-3" }));
    const api = createConsoleApi(fetchFn);

    await expect(api.cancelUnclaimed(CAMPAIGN)).rejects.toMatchObject({ status: 409, code: "not_submitted" });
  });
});

describe("the agent call", () => {
  const ANSWER = { reply: "There are 1,357 quiet regulars.", toolsUsed: ["shop_summary", "quiet_regulars"], stopped: null, aiCalls: 3 };

  function recordBodies(status: number, body: unknown) {
    const sent: unknown[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/session") return json(200, { signedIn: false, csrf: "c2.first" });
      sent.push({ url: String(input), method: init?.method, csrf: (init?.headers as Record<string, string>)["x-mend-csrf"], body: JSON.parse(String(init?.body)) });
      return json(status, body);
    }) as typeof fetch;
    return { sent, api: createConsoleApi(fetchFn) };
  }

  it("posts the message alone when there is no history, and reads the reply with its tools", async () => {
    const { sent, api } = recordBodies(200, ANSWER);

    const answer = await api.ask("How many quiet regulars?", []);

    expect(sent).toEqual([{ url: "/api/agent", method: "POST", csrf: "c2.first", body: { message: "How many quiet regulars?" } }]);
    expect(answer).toMatchObject({ reply: ANSWER.reply, toolsUsed: ["shop_summary", "quiet_regulars"], stopped: null, aiCalls: 3 });
  });

  it("sends the history along when there is some", async () => {
    const history = [
      { role: "owner" as const, text: "How many quiet regulars?" },
      { role: "agent" as const, text: "There are 1,357." },
    ];
    const { sent, api } = recordBodies(200, ANSWER);

    await api.ask("And who is most at risk?", history);

    expect(sent[0]).toMatchObject({ body: { message: "And who is most at risk?", history } });
  });

  it.each(["tool_limit", "declined"] as const)("reads a reply that stopped with %s", async (stopped) => {
    const { api } = recordBodies(200, { ...ANSWER, toolsUsed: [], stopped });

    await expect(api.ask("Pay everyone", [])).resolves.toMatchObject({ stopped });
  });

  it.each([
    [503, "no_key"],
    [429, "limit_reached"],
    [429, "claude_token_cap"],
    [413, "invalid_input"],
  ])("turns %i %s into an ApiError with that status and code", async (status, code) => {
    const { api } = recordBodies(status, { error: code, message: "Not now.", ref: "r-5" });

    await expect(api.ask("Hello", [])).rejects.toMatchObject({ status, code, ref: "r-5" });
  });

  it("refuses an answer with an unknown stop reason or no reply", async () => {
    await expect(recordBodies(200, { ...ANSWER, stopped: "tired" }).api.ask("Hello", [])).rejects.toMatchObject({ code: "unexpected_answer" });
    await expect(recordBodies(200, { ...ANSWER, reply: "" }).api.ask("Hello", [])).rejects.toMatchObject({ code: "unexpected_answer" });
  });

  it("calls onUnauthorized on a 401", async () => {
    let handled = 0;
    const { fetchFn } = withSession(() => json(401, { error: "not_allowed" }));
    const api = createConsoleApi(fetchFn, { onUnauthorized: () => (handled += 1) });

    await expect(api.ask("Hello", [])).rejects.toMatchObject({ status: 401 });
    expect(handled).toBe(1);
  });
});

describe("the budget on a plan", () => {
  it("is sent as budgetMinor only when given", async () => {
    const bodies: unknown[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/session") return json(200, { signedIn: false, csrf: "c2.first" });
      bodies.push(JSON.parse(String(init?.body)));
      return json(201, DRAFT);
    }) as typeof fetch;
    const api = createConsoleApi(fetchFn);

    await api.plan("Win them back");
    await api.plan("Win them back", { budgetMinor: 1000 });

    expect(bodies).toEqual([{ goalText: "Win them back" }, { goalText: "Win them back", budgetMinor: 1000 }]);
  });
});

describe("a 401", () => {
  it("calls onUnauthorized before the error reaches the caller", async () => {
    const order: string[] = [];
    const { fetchFn } = fakeFetch(() => json(401, { error: "not_allowed", ref: "r-4" }));
    const api = createConsoleApi(fetchFn, { onUnauthorized: () => order.push("handler") });

    await api.results(CAMPAIGN).catch(() => order.push("caller"));

    expect(order).toEqual(["handler", "caller"]);
  });

  it("is still thrown as an ApiError with status 401", async () => {
    const { fetchFn } = fakeFetch(() => json(401, { error: "not_allowed" }));
    const api = createConsoleApi(fetchFn, { onUnauthorized: () => undefined });

    await expect(api.view(CAMPAIGN)).rejects.toMatchObject({ status: 401, code: "not_allowed" });
  });

  it("is caught when it comes from a polled run", async () => {
    vi.useFakeTimers();
    let handled = 0;
    const { fetchFn } = fakeFetch((call, index) =>
      index === 0 ? json(202, { status: "running", runId: "brn-abc123" }) : json(401, { error: "not_allowed" }),
    );
    const api = createConsoleApi(fetchFn, { onUnauthorized: () => (handled += 1) });

    const outcome = expect(api.request("GET", "/api/x", z.looseObject({}))).rejects.toMatchObject({ status: 401 });
    await vi.advanceTimersByTimeAsync(2000);

    await outcome;
    expect(handled).toBe(1);
  });

  it("does not call the handler for other refusals", async () => {
    let handled = 0;
    const { fetchFn } = fakeFetch(() => json(403, { error: "csrf_refused" }));
    const api = createConsoleApi(fetchFn, { onUnauthorized: () => (handled += 1) });

    await api.view(CAMPAIGN).catch(() => undefined);

    expect(handled).toBe(0);
  });

  it("works with no handler given", async () => {
    const { fetchFn } = fakeFetch(() => json(401, { error: "not_allowed" }));
    const api = createConsoleApi(fetchFn);

    await expect(api.view(CAMPAIGN)).rejects.toMatchObject({ status: 401 });
  });
});

describe("a quiet regular", () => {
  const ROW = { position: 1, displayName: "Priya X.", purchaseDays: 7, daysSilent: 95, score: 0.003, paidNetMinor: 100, member: true };
  const GROUPS = { worthANudge: 1, likelyGone: 0, likelyBack: 0 };

  it("is not a stand-in when the answer has no such field", async () => {
    const { fetchFn } = fakeFetch(() => json(200, { asOf: null, total: 1, ...GROUPS, rows: [ROW] }));
    const api = createConsoleApi(fetchFn);

    const result = await api.quietRegulars(50);

    expect(result.rows[0].standIn).toBe(false);
  });

  it("carries standIn when the answer has it", async () => {
    const { fetchFn } = fakeFetch(() => json(200, { asOf: null, total: 1, ...GROUPS, rows: [{ ...ROW, standIn: true }] }));
    const api = createConsoleApi(fetchFn);

    const result = await api.quietRegulars(50);

    expect(result.rows[0].standIn).toBe(true);
  });
});

describe("parseRetryAfter", () => {
  it.each([
    ["5", 5],
    ["0", 0],
    ["3600", 3600],
    ["3601", null],
    ["abc", null],
    ["-4", null],
    ["1.5", null],
    [null, null],
  ])("reads %j as %j", (value, expected) => {
    expect(parseRetryAfter(value)).toBe(expected);
  });
});
