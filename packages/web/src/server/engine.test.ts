// Covers the engine client in both modes: against a fake dev bridge on 127.0.0.1, and
// against Render's task-run API through the real @renderinc/sdk with fetch replaced.
// Does NOT cover: a real Render workflow (no Render call is made; the slug and the
// live status names are day-zero checks), the real engine behind the bridge
// (packages/engine tests and npm run prove:m7a), or runs read from another process.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "./config";
import { EngineUnavailable, getRun, isRunId, RunNotFound, runAndWait, runTask, statusForEngineError, waitForRun, type TaskName } from "./engine";

const TOKEN = "bridge-token-for-engine-tests-0123456789";
const FAKE_RENDER_KEY = "rnd_testkeyforengine";
const REF = "6f1c1d3e-2b9a-4f0e-9a51-3c1d2e4f5a6b";

type Seen = { readonly path: string; readonly token: string | undefined; readonly body: unknown };

const bridge = {
  delayMs: 0,
  answer: { status: 200, body: JSON.stringify({ ok: true, campaign_id: "x" }) } as { status: number; body: string },
  seen: [] as Seen[],
};

let server: Server;
let bridgeUrl: string;
let logLines: string[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settled(runId: string): Promise<Awaited<ReturnType<typeof getRun>>> {
  for (let n = 0; n < 100; n += 1) {
    const run = await getRun(runId);
    if (run.status !== "running") return run;
    await sleep(50);
  }
  throw new Error("run never settled");
}

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
    });
    request.on("end", () => {
      const token = request.headers["x-mend-bridge-token"];
      bridge.seen.push({ path: request.url ?? "", token: typeof token === "string" ? token : undefined, body: JSON.parse(text) });
      setTimeout(() => {
        response.writeHead(bridge.answer.status, { "content-type": "application/json" });
        response.end(bridge.answer.body);
      }, bridge.delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  bridgeUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

beforeEach(() => {
  bridge.delayMs = 0;
  bridge.answer = { status: 200, body: JSON.stringify({ ok: true, campaign_id: "x" }) };
  bridge.seen = [];
  logLines = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    logLines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("through the dev bridge", () => {
  beforeEach(() => {
    vi.stubEnv("MEND_DEV", "1");
    vi.stubEnv("MEND_BRIDGE_URL", bridgeUrl);
    vi.stubEnv("MEND_BRIDGE_TOKEN", TOKEN);
  });

  it("starts a run without waiting for it, sending the token and the positional arguments", async () => {
    bridge.delayMs = 300;
    const started = Date.now();
    const runId = await runTask("view_campaign", ["c-1", { role: "demo", session: "s" }]);
    expect(Date.now() - started).toBeLessThan(200);
    expect(runId).toMatch(/^brn-[0-9a-f-]{36}$/);
    expect((await getRun(runId)).status).toBe("running");
    expect(await settled(runId)).toEqual({ status: "succeeded", result: { ok: true, campaign_id: "x" } });
    expect(bridge.seen).toEqual([{ path: "/tasks/view_campaign", token: TOKEN, body: { args: ["c-1", { role: "demo", session: "s" }] } }]);
  });

  it("runAndWait returns the finished answer", async () => {
    const waited = await runAndWait("draft_campaign", [{}, {}], 5_000);
    expect(waited).toMatchObject({ state: "finished", status: "succeeded", result: { ok: true, campaign_id: "x" } });
  });

  it("runAndWait answers 202 with the run id when the run outlasts the wait, and the run carries on", async () => {
    bridge.delayMs = 1_500;
    const waited = await runAndWait("draft_campaign", [{}, {}], 600);
    expect(waited).toMatchObject({ state: "pending", httpStatus: 202 });
    expect((await settled(waited.runId)).status).toBe("succeeded");
  });

  it("passes an engine refusal through unchanged", async () => {
    bridge.answer = { status: 200, body: JSON.stringify({ ok: false, error: "budget_over_cap", ref: REF }) };
    const waited = await runAndWait("draft_campaign", [{}, {}], 5_000);
    expect(waited).toMatchObject({ state: "finished", status: "succeeded", result: { ok: false, error: "budget_over_cap", ref: REF } });
  });

  it.each([
    ["a bridge error", { status: 500, body: '{"error":"the task failed"}' }],
    ["an answer that is not JSON", { status: 200, body: "<html>" }],
    ["JSON that is not an engine answer", { status: 200, body: '{"hello":1}' }],
    ["a refusal with a code of the wrong shape", { status: 200, body: JSON.stringify({ ok: false, error: "Bad Code", ref: REF }) }],
    ["a refusal with extra detail", { status: 200, body: JSON.stringify({ ok: false, error: "internal", ref: REF, trace: "Traceback" }) }],
  ])("fails the run on %s, and logs it without the token", async (_label, answer) => {
    bridge.answer = answer;
    const waited = await runAndWait("view_campaign", [], 5_000);
    expect(waited).toMatchObject({ state: "finished", status: "failed" });
    expect("result" in waited && waited.result).toBeFalsy();
    expect(logLines.join("")).toContain('"outcome":"bridge_failed"');
    expect(logLines.join("")).not.toContain(TOKEN);
  });

  it("returns the first run for a repeated idempotency key and calls the bridge once", async () => {
    const first = await runTask("view_campaign", [], { idempotencyKey: "view-key-1" });
    const second = await runTask("view_campaign", [], { idempotencyKey: "view-key-1" });
    expect(second).toBe(first);
    await settled(first);
    expect(bridge.seen).toHaveLength(1);
  });

  it.each([
    ["MEND_BRIDGE_URL", "http://10.0.0.1:8765"],
    ["MEND_BRIDGE_URL", "https://127.0.0.1:8765"],
    ["MEND_BRIDGE_URL", "http://127.0.0.1.evil.example:8765"],
    ["MEND_BRIDGE_URL", "http://user:pw@127.0.0.1:8765"],
    ["MEND_BRIDGE_TOKEN", "short"],
  ])("refuses %s=%s before sending anything", async (name, value) => {
    vi.stubEnv(name, value);
    await expect(runTask("view_campaign", [])).rejects.toThrow(ConfigError);
    expect(bridge.seen).toHaveLength(0);
  });

  it("refuses task names and idempotency keys outside the engine's", async () => {
    await expect(runTask("drop_everything" as TaskName, [])).rejects.toThrow("unknown engine task");
    await expect(runTask("view_campaign", [], { idempotencyKey: "has space" })).rejects.toThrow("idempotency key");
    expect(bridge.seen).toHaveLength(0);
  });

  it("does not know run ids it never issued", async () => {
    await expect(getRun("brn-6f1c1d3e-2b9a-4f0e-9a51-3c1d2e4f5a6b")).rejects.toThrow(RunNotFound);
    await expect(getRun("trn-abc123")).rejects.toThrow(RunNotFound);
    await expect(waitForRun("brn-6f1c1d3e-2b9a-4f0e-9a51-3c1d2e4f5a6b", 0)).rejects.toThrow(RunNotFound);
  });

  it("keeps runs in one store on globalThis, so every route bundle in the process reads the same runs", async () => {
    const runId = await runTask("results", []);
    const store = (globalThis as Record<symbol, { runs: Map<string, unknown> } | undefined>)[Symbol.for("mend.engine.bridgeRuns")];
    expect(store?.runs.has(runId)).toBe(true);
    await settled(runId);
  });

  it("waitForRun with no time to wait reads a run once: pending while it runs, then its answer", async () => {
    bridge.delayMs = 400;
    const runId = await runTask("quiet_regulars", [{ role: "demo", session: "s" }, 10]);
    expect(await waitForRun(runId, 0)).toEqual({ state: "pending", httpStatus: 202, runId });
    await settled(runId);
    expect(await waitForRun(runId, 0)).toMatchObject({ state: "finished", status: "succeeded", runId });
  });

  it("knows the shape of its own run ids only", () => {
    expect(isRunId("brn-6f1c1d3e-2b9a-4f0e-9a51-3c1d2e4f5a6b")).toBe(true);
    expect(isRunId("trn-abc123")).toBe(false);
    expect(isRunId("brn-../../x")).toBe(false);
  });
});

describe("through Render Workflows", () => {
  type Captured = { readonly url: string; readonly method: string; readonly authorization: string | null; readonly body: unknown };
  const render = { status: "succeeded", results: [{ ok: true, campaign_id: "x" }] as unknown, startStatus: 202, captured: [] as Captured[] };

  async function fakeRender(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = request.method === "POST" ? await request.text() : "";
    render.captured.push({ url: request.url, method: request.method, authorization: request.headers.get("authorization"), body: text ? JSON.parse(text) : null });
    const url = new URL(request.url);
    if (url.hostname !== "api.render.com") return new Response("wrong host", { status: 599 });
    if (request.method === "POST" && url.pathname === "/v1/task-runs") {
      if (render.startStatus !== 202) return Response.json({ message: "unauthorized", id: "err-1" }, { status: render.startStatus });
      return Response.json({ id: "trn-d1abc", taskId: "tsk-1", status: "pending", attempts: [] }, { status: 202 });
    }
    if (request.method === "GET" && url.pathname === "/v1/task-runs/trn-d1abc") {
      return Response.json({ id: "trn-d1abc", taskId: "tsk-1", status: render.status, results: render.results, input: [], attempts: [] });
    }
    return Response.json({ message: "not found", id: "err-2" }, { status: 404 });
  }

  beforeEach(() => {
    vi.stubEnv("MEND_DEV", "0");
    vi.stubEnv("MEND_WORKFLOW_SLUG", "mend-engine");
    vi.stubEnv("RENDER_API_KEY", FAKE_RENDER_KEY);
    render.status = "succeeded";
    render.results = [{ ok: true, campaign_id: "x" }];
    render.startStatus = 202;
    render.captured = [];
    vi.stubGlobal("fetch", fakeRender);
  });

  it("starts a run with the workflow slug, the arguments and the idempotency key", async () => {
    const runId = await runTask("draft_campaign", [{ a: 1 }, { role: "owner", session: "s" }], { idempotencyKey: "draft-abc" });
    expect(runId).toBe("trn-d1abc");
    expect(render.captured).toEqual([
      {
        url: "https://api.render.com/v1/task-runs",
        method: "POST",
        authorization: `Bearer ${FAKE_RENDER_KEY}`,
        body: { task: "mend-engine/draft_campaign", input: [{ a: 1 }, { role: "owner", session: "s" }], idempotencyKey: "draft-abc" },
      },
    ]);
  });

  it.each([
    ["completed", "succeeded"],
    ["succeeded", "succeeded"],
    ["failed", "failed"],
    ["canceled", "failed"],
    ["pending", "running"],
    ["running", "running"],
    ["paused", "running"],
    ["a_status_nobody_listed", "running"],
  ])("reads status %s as %s", async (status, expected) => {
    render.status = status;
    const run = await getRun("trn-d1abc");
    expect(run.status).toBe(expected);
    if (expected === "succeeded") expect(run.result).toEqual({ ok: true, campaign_id: "x" });
  });

  it("fails a finished run whose result is not an engine answer", async () => {
    for (const results of [[], [{ hello: 1 }], null]) {
      render.results = results;
      expect(await getRun("trn-d1abc")).toEqual({ status: "failed" });
    }
  });

  it("cannot be pointed at another host by RENDER_LOCAL_DEV_URL or RENDER_USE_LOCAL_DEV", async () => {
    vi.stubEnv("RENDER_LOCAL_DEV_URL", "http://evil.example:8120");
    vi.stubEnv("RENDER_USE_LOCAL_DEV", "true");
    await runTask("view_campaign", []);
    expect(render.captured.map((call) => new URL(call.url).hostname)).toEqual(["api.render.com"]);
  });

  it("turns a refused start into EngineUnavailable that never quotes the key", async () => {
    render.startStatus = 401;
    const error = await runTask("view_campaign", []).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineUnavailable);
    expect(String((error as Error).message)).toContain("401");
    expect(String((error as Error).message)).not.toContain(FAKE_RENDER_KEY);
  });

  it.each([
    ["MEND_WORKFLOW_SLUG", ""],
    ["MEND_WORKFLOW_SLUG", "Mend Engine"],
    ["RENDER_API_KEY", ""],
  ])("refuses to start with %s=%j and sends nothing", async (name, value) => {
    vi.stubEnv(name, value);
    await expect(runTask("view_campaign", [])).rejects.toThrow(ConfigError);
    expect(render.captured).toHaveLength(0);
  });

  it("does not read run ids of the wrong shape", async () => {
    await expect(getRun("trn-../../services")).rejects.toThrow(RunNotFound);
    expect(render.captured).toHaveLength(0);
    expect(isRunId("trn-d1abc")).toBe(true);
    expect(isRunId("brn-6f1c1d3e-2b9a-4f0e-9a51-3c1d2e4f5a6b")).toBe(false);
  });
});

describe("statusForEngineError", () => {
  it.each([
    ["not_found", 404],
    ["invalid_input", 400],
    ["invalid_actor", 400],
    ["forbidden", 403],
    ["limit_reached", 429],
    ["over_demo_daily_cap", 429],
    ["over_daily_cap", 429],
    ["paypal_unavailable", 503],
    ["internal", 500],
    ["budget_over_cap", 422],
    ["too_few_candidates", 422],
    ["hash_mismatch", 409],
    ["recipient_not_member", 409],
    ["voided", 409],
    ["not_open", 409],
    ["approved_before", 409],
    ["member_left", 422],
  ])("answers %s with %i", (code, status) => {
    expect(statusForEngineError(code)).toBe(status);
  });
});
