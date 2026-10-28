// Covers env validation, the sandbox-only rule and secret hiding in config.ts.
// Does NOT cover: what PayPal accepts as credentials, or whether DATABASE_URL reaches a
// running database (webhooks.test.ts and the live proof do that).
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError, parseConfig, readCredentials, readOnlyCredentials, SANDBOX_API_HOST } from "./config";

const SECRET = "test-secret-value-1234";
const DB_PASSWORD = "db-password-5678";
const READ_SECRET = "read-only-secret-value-9012";

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

describe("readOnlyCredentials", () => {
  const main = readCredentials(goodEnv);
  const readEnv = { ...goodEnv, PAYPAL_READ_CLIENT_ID: "read-only-client-id", PAYPAL_READ_CLIENT_SECRET: READ_SECRET };

  function refusal(env: Record<string, string | undefined>): ConfigError {
    try {
      readOnlyCredentials(env, main);
    } catch (error) {
      if (error instanceof ConfigError) return error;
      throw error;
    }
    throw new Error("expected a ConfigError");
  }

  it("uses the read-only app when both of its keys are set", () => {
    const { credentials, separate } = readOnlyCredentials(readEnv, main);
    expect(separate).toBe(true);
    expect(credentials.clientId).toBe("read-only-client-id");
    expect(credentials.clientSecret).toBe(READ_SECRET);
  });

  it.each([{}, { PAYPAL_READ_CLIENT_ID: "", PAYPAL_READ_CLIENT_SECRET: "" }])("falls back to the main app when neither key is set (%j)", (extra) => {
    const { credentials, separate } = readOnlyCredentials({ ...goodEnv, ...extra }, main);
    expect(separate).toBe(false);
    expect(credentials).toBe(main);
  });

  it.each([
    ["PAYPAL_READ_CLIENT_SECRET", { PAYPAL_READ_CLIENT_ID: "read-only-client-id" }],
    ["PAYPAL_READ_CLIENT_ID", { PAYPAL_READ_CLIENT_SECRET: READ_SECRET }],
    ["PAYPAL_READ_CLIENT_ID", { PAYPAL_READ_CLIENT_ID: "has space", PAYPAL_READ_CLIENT_SECRET: READ_SECRET }],
  ])("refuses a half-set pair, naming %s and never a value", (name, extra) => {
    const error = refusal({ ...goodEnv, ...extra });
    expect(error.message).toBe(`missing or invalid setting: ${name}`);
    expect(error.message).not.toContain(READ_SECRET);
  });

  it("refuses a read-only client id that is the main app's", () => {
    const error = refusal({ ...readEnv, PAYPAL_READ_CLIENT_ID: goodEnv.PAYPAL_CLIENT_ID });
    expect(error.message).toBe("PAYPAL_READ_CLIENT_ID must belong to a different PayPal app");
    expect(error.message).not.toContain(goodEnv.PAYPAL_CLIENT_ID);
  });

  it("keeps the read-only secret out of keys, JSON and inspect output", () => {
    const { credentials } = readOnlyCredentials(readEnv, main);
    expect(Object.keys(credentials)).toEqual(["clientId"]);
    expect(Object.isFrozen(credentials)).toBe(true);
    for (const text of [JSON.stringify(credentials), inspect(credentials, { depth: 10 }), JSON.stringify({ ...credentials })]) expect(text).not.toContain(READ_SECRET);
  });

  it("is what parseConfig gives the agent's PayPal reads", () => {
    const separate = parseConfig(readEnv);
    expect(separate.paypalReadSeparate).toBe(true);
    expect(separate.paypalRead.clientId).toBe("read-only-client-id");
    expect(separate.paypal.clientId).toBe(goodEnv.PAYPAL_CLIENT_ID);
    expect(JSON.stringify(separate)).not.toContain(READ_SECRET);
    expect(inspect(separate, { depth: 10 })).not.toContain(READ_SECRET);
    const shared = parseConfig(goodEnv);
    expect(shared.paypalReadSeparate).toBe(false);
    expect(shared.paypalRead).toBe(shared.paypal);
    expect(() => parseConfig({ ...goodEnv, PAYPAL_READ_CLIENT_ID: "read-only-client-id" })).toThrow("missing or invalid setting: PAYPAL_READ_CLIENT_SECRET");
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
