// Covers env validation, the sandbox-only rule and secret hiding in config.ts.
// Does NOT cover: what PayPal accepts as credentials, or whether DATABASE_URL reaches a
// running database (webhooks.test.ts and the live proof do that).
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError, parseConfig, readCredentials, SANDBOX_API_HOST } from "./config";

const SECRET = "test-secret-value-1234";
const DB_PASSWORD = "db-password-5678";

const goodEnv = {
  PAYPAL_ENV: "sandbox",
  PAYPAL_CLIENT_ID: "test-client-id",
  PAYPAL_CLIENT_SECRET: SECRET,
  PAYPAL_WEBHOOK_ID: "8PT597110X687430LKGECATA",
  DATABASE_URL: `postgresql://mend:${DB_PASSWORD}@127.0.0.1:5432/mend`,
};

function refusalOf(env: Record<string, string | undefined>): ConfigError {
  try {
    parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("parseConfig", () => {
  it("accepts a complete sandbox environment", () => {
    const config = parseConfig(goodEnv);
    expect(config.paypalApiHost).toBe(SANDBOX_API_HOST);
    expect(config.paypal.clientId).toBe("test-client-id");
    expect(config.paypal.clientSecret).toBe(SECRET);
    expect(config.webhookId).toBe(goodEnv.PAYPAL_WEBHOOK_ID);
    expect(config.databaseUrl).toBe(goodEnv.DATABASE_URL);
  });

  it.each(["live", "Sandbox", " sandbox", "sandbox ", "production", "", undefined])(
    "refuses PAYPAL_ENV=%j",
    (value) => {
      const error = refusalOf({ ...goodEnv, PAYPAL_ENV: value });
      expect(error.message).toBe("PAYPAL_ENV must be exactly 'sandbox'");
    },
  );

  it("never takes the API host from the environment", () => {
    const config = parseConfig({ ...goodEnv, PAYPAL_API_HOST: "api-m.paypal.com" });
    expect(config.paypalApiHost).toBe("api-m.sandbox.paypal.com");
  });

  it.each(["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "DATABASE_URL"])(
    "refuses when %s is missing, naming it",
    (name) => {
      const error = refusalOf({ ...goodEnv, [name]: undefined });
      expect(error.message).toBe(`missing or invalid setting: ${name}`);
    },
  );

  it.each([
    ["PAYPAL_WEBHOOK_ID", "WH-123"],
    ["PAYPAL_WEBHOOK_ID", "A".repeat(51)],
    ["PAYPAL_CLIENT_SECRET", "has space"],
    ["DATABASE_URL", "http://127.0.0.1:5432/mend"],
    ["DATABASE_URL", "not a url"],
    ["DATABASE_URL", "postgresql:///mend"],
  ])("refuses %s=%j", (name, value) => {
    expect(refusalOf({ ...goodEnv, [name]: value }).message).toBe(`missing or invalid setting: ${name}`);
  });

  it("never puts a value into the error message", () => {
    const bad = { ...goodEnv, PAYPAL_WEBHOOK_ID: `x-${SECRET}`, DATABASE_URL: `ftp://${DB_PASSWORD}` };
    const error = refusalOf(bad);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(DB_PASSWORD);
    expect(String(error.stack)).not.toContain(SECRET);
    expect(refusalOf({ ...goodEnv, PAYPAL_ENV: "live" }).message).not.toContain(SECRET);
  });

  it("keeps the secret and the database URL out of JSON and inspect output", () => {
    const config = parseConfig(goodEnv);
    for (const text of [JSON.stringify(config), inspect(config, { depth: 10 }), JSON.stringify({ ...config })]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(DB_PASSWORD);
    }
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.paypal)).toBe(true);
  });
});

describe("readCredentials", () => {
  it("needs only the sandbox flag and the two PayPal keys", () => {
    const credentials = readCredentials({
      PAYPAL_ENV: "sandbox",
      PAYPAL_CLIENT_ID: "id",
      PAYPAL_CLIENT_SECRET: SECRET,
    });
    expect(credentials.clientSecret).toBe(SECRET);
    expect(JSON.stringify(credentials)).not.toContain(SECRET);
  });

  it("refuses live", () => {
    expect(() => readCredentials({ ...goodEnv, PAYPAL_ENV: "live" })).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  function stubGoodEnv(): void {
    for (const [name, value] of Object.entries(goodEnv)) vi.stubEnv(name, value);
  }

  it("validates on first use and reuses the result", async () => {
    stubGoodEnv();
    const { loadConfig } = await import("./config");
    const first = loadConfig();
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "CHANGEDAFTERSTART");
    expect(loadConfig()).toBe(first);
    expect(loadConfig().webhookId).toBe(goodEnv.PAYPAL_WEBHOOK_ID);
  });

  it("does not cache a refusal", async () => {
    stubGoodEnv();
    vi.stubEnv("PAYPAL_ENV", "live");
    const { loadConfig, ConfigError: FreshConfigError } = await import("./config");
    expect(() => loadConfig()).toThrow(FreshConfigError);
    vi.stubEnv("PAYPAL_ENV", "sandbox");
    expect(loadConfig().paypalApiHost).toBe(SANDBOX_API_HOST);
  });
});
