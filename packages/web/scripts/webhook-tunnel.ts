/**
 * The pieces a live proof needs to receive real PayPal webhooks on this machine: a
 * production build of the app, the app started on a free local port, and a quick
 * cloudflared tunnel that gives it a public https address. Taken from the M1b proof so
 * later proofs reuse one tested way of doing it. Nothing here talks to PayPal.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { lookup as systemLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { Resolver } from "node:dns/promises";
import { readFileSync } from "node:fs";
import https from "node:https";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import type { Env } from "../src/server/config";

export const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENV_PATH = path.resolve(WEB_DIR, "..", "..", ".env");
const NEXT_BIN = path.join(WEB_DIR, "node_modules", "next", "dist", "bin", "next");
const CLOUDFLARED =
  process.platform === "win32" ? "C:/Program Files (x86)/cloudflared/cloudflared.exe" : "cloudflared";
export const DIST_DIR = ".next-verify";
export const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export class HarnessFailed extends Error {}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The repo's .env with the process environment winning for the names given, as in the engine. */
export function readEnv(names: readonly string[]): Env {
  const fromFile = parseEnv(readFileSync(ENV_PATH, "utf8").replace(/^\uFEFF/, ""));
  const merged: Record<string, string | undefined> = { ...fromFile };
  for (const name of names) {
    if (process.env[name] !== undefined) merged[name] = process.env[name];
  }
  return merged;
}

export function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return Promise.resolve();
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (process.platform === "win32") {
    // Kills the whole tree; a plain kill can leave the server's own children running.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
  return Promise.race([exited, sleep(10_000)]);
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

// Public DNS first: Windows caches a "not found" answer for minutes, and a brand-new
// tunnel name can be looked up a moment before it exists.
const publicResolver = new Resolver({ timeout: 5_000, tries: 2 });
publicResolver.setServers(["1.1.1.1", "8.8.8.8"]);

function tunnelLookup(
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  publicResolver.resolve4(hostname).then(
    (addresses) => {
      if (options.all) callback(null, addresses.map((address) => ({ address, family: 4 })));
      else callback(null, addresses[0], 4);
    },
    () => systemLookup(hostname, options, callback as never),
  );
}

export type PublicReply = { readonly status: number; readonly body: string };

/** One https request to a public address, resolving the tunnel's name through public DNS. */
export function publicRequest(url: URL): Promise<PublicReply> {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: "GET", lookup: tunnelLookup as never, timeout: 30_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("timeout", () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
    request.end();
  });
}

export async function waitFor<T>(what: string, timeoutMs: number, everyMs: number, attempt: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const result = await attempt();
      if (result !== null) return result;
    } catch (error) {
      if (error instanceof HarnessFailed) throw error;
    }
    if (Date.now() > deadline) throw new HarnessFailed(`${what} did not happen within ${Math.round(timeoutMs / 1000)} s`);
    await sleep(everyMs);
  }
}

/** next build into DIST_DIR, so a dev server using .next is left alone. */
export function buildApp(): void {
  const result = spawnSync(process.execPath, [NEXT_BIN, "build"], {
    cwd: WEB_DIR,
    env: { ...process.env, NEXT_DIST_DIR: DIST_DIR, NEXT_TELEMETRY_DISABLED: "1" },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const tail = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).slice(-15).join("\n");
    throw new HarnessFailed(`next build failed:\n${tail}`);
  }
}

/**
 * next start on 127.0.0.1:port with exactly env's PAYPAL_* and DATABASE_URL (inherited ones
 * are dropped), resolving once /api/health answers ok. Every chunk the server prints goes to
 * onOutput.
 */
export async function startServer(port: number, env: Record<string, string>, onOutput: (chunk: string) => void): Promise<ChildProcess> {
  const inherited = { ...process.env };
  for (const name of Object.keys(inherited)) {
    if (name.startsWith("PAYPAL_") || name === "DATABASE_URL") delete inherited[name];
  }
  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: WEB_DIR,
    env: { ...inherited, ...env, NEXT_DIST_DIR: DIST_DIR, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", onOutput);
  }
  const local = new URL(`http://127.0.0.1:${port}/api/health`);
  try {
    await waitFor("local server start", 60_000, 500, async () => {
      if (child.exitCode !== null) throw new HarnessFailed("server exited during start");
      const response = await fetch(local);
      return response.status === 200 && (await response.text()) === "ok" ? true : null;
    });
  } catch (error) {
    await stopProcess(child);
    throw error;
  }
  return child;
}

/**
 * A quick cloudflared tunnel to the local port. onStarted gets the process as soon as it
 * exists, so the caller can stop it even if the address never appears. Resolves with the
 * public origin once cloudflared reports a registered connection and /api/health answers
 * through it.
 */
export async function startTunnel(port: number, onStarted: (child: ChildProcess) => void): Promise<URL> {
  const child = spawn(CLOUDFLARED, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  onStarted(child);
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      output += chunk;
    });
  }
  const address = await waitFor("tunnel address", 90_000, 500, async () => {
    if (child.exitCode !== null) throw new HarnessFailed("cloudflared exited");
    const found = TUNNEL_URL.exec(output)?.[0];
    return found !== undefined && output.includes("Registered tunnel connection") ? found : null;
  });
  // C24: the webhook address comes from the tunnel cloudflared reports, never from a request.
  const origin = new URL(address);
  if (origin.protocol !== "https:" || !TUNNEL_URL.test(origin.origin) || origin.origin !== address) {
    throw new HarnessFailed("cloudflared reported an unexpected address");
  }
  await waitFor("tunnel health check", 120_000, 2_000, async () => {
    const reply = await publicRequest(new URL("/api/health", origin));
    return reply.status === 200 && reply.body === "ok" ? true : null;
  });
  return origin;
}
