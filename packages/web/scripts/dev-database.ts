/**
 * Starts or reuses the engine's local Postgres (pgserver) for the web tests and the
 * proof, and keeps a handle on it until release(). The engine stops pgserver when the
 * last process holding it exits, so without a handle of our own an engine test run
 * finishing elsewhere could stop the database under us.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine");
export const SCHEMA_PATH = path.join(ENGINE_DIR, "mend_engine", "db", "schema.sql");

export type DevDatabase = {
  readonly url: string;
  release(): Promise<void>;
};

function enginePython(): string {
  const python =
    process.platform === "win32"
      ? path.join(ENGINE_DIR, ".venv", "Scripts", "python.exe")
      : path.join(ENGINE_DIR, ".venv", "bin", "python");
  if (!existsSync(python)) {
    throw new Error(`engine virtualenv not found at ${python}; set it up as packages/engine/README.md says`);
  }
  return python;
}

/** Runs `python -m mend_engine.db.dev_url --hold` and returns the URL it prints. */
export async function holdDevDatabase(timeoutMs = 90_000): Promise<DevDatabase> {
  const child = spawn(enginePython(), ["-m", "mend_engine.db.dev_url", "--hold"], {
    cwd: ENGINE_DIR,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("dev database did not start in time"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const end = stdout.indexOf("\n");
      if (end !== -1) {
        clearTimeout(timer);
        resolve(stdout.slice(0, end).trim());
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const lastLine = stderr.trim().split(/\r?\n/).at(-1) ?? "";
      reject(new Error(`dev_url exited with code ${code}: ${lastLine}`));
    });
  });
  if (!url.startsWith("postgresql://")) {
    child.kill();
    throw new Error("dev_url did not print a postgresql:// URL");
  }
  return {
    url,
    async release() {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        await exited;
      }
    },
  };
}
