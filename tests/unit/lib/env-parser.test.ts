import { describe, expect, it } from "vitest";
import { parseEnv } from "../../../src/lib/env-parser";

const baseEnv = (): Record<string, string | undefined> => ({
  DATABASE_URL: "postgres://kittie:kittie@localhost:5433/kittie",
  TEST_DATABASE_URL: "postgres://kittie:kittie@localhost:5433/kittie_test",
  BETTER_AUTH_SECRET: "x".repeat(40),
  BETTER_AUTH_URL: "http://localhost:3100",
  APP_URL: "http://localhost:3100",
  EMAIL_DRIVER: "smtp",
  EMAIL_FROM: "Kittie <kittie@localhost>",
  SMTP_URL: "smtp://localhost:1025",
  OCR_PROVIDER: "fake",
  NODE_ENV: "development",
});

describe("parseEnv", () => {
  it("parses a complete environment and applies defaults", () => {
    const env = parseEnv(baseEnv());
    expect(env.DATABASE_URL).toBe(
      "postgres://kittie:kittie@localhost:5433/kittie",
    );
    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.OCR_MONTHLY_JOB_CAP).toBe(10000);
    expect(env.RECEIPT_MAX_BYTES).toBe(10485760);
    expect(env.RECEIPT_STORAGE_DIR).toBe("receipts");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.OCR_INLINE).toBe(false);
    expect(env.NOTIFICATIONS_INLINE).toBe(false);
  });

  it("coerces numeric and boolean values", () => {
    const env = parseEnv({
      ...baseEnv(),
      OCR_MONTHLY_JOB_CAP: "500",
      RECEIPT_MAX_BYTES: "2097152",
      OCR_INLINE: "true",
      NOTIFICATIONS_INLINE: "true",
    });
    expect(env.OCR_MONTHLY_JOB_CAP).toBe(500);
    expect(env.RECEIPT_MAX_BYTES).toBe(2097152);
    expect(env.OCR_INLINE).toBe(true);
    expect(env.NOTIFICATIONS_INLINE).toBe(true);
  });

  it("defaults COOKIE_SECURE from the APP_URL protocol", () => {
    const https = parseEnv({
      ...baseEnv(),
      APP_URL: "https://kittie.zynafin.cc",
    });
    const http = parseEnv({ ...baseEnv(), APP_URL: "http://localhost:3100" });
    expect(https.COOKIE_SECURE).toBe(true);
    expect(http.COOKIE_SECURE).toBe(false);
  });

  it("respects an explicit COOKIE_SECURE override", () => {
    const off = parseEnv({
      ...baseEnv(),
      APP_URL: "https://kittie.zynafin.cc",
      COOKIE_SECURE: "false",
    });
    const on = parseEnv({
      ...baseEnv(),
      APP_URL: "http://localhost:3100",
      COOKIE_SECURE: "true",
    });
    expect(off.COOKIE_SECURE).toBe(false);
    expect(on.COOKIE_SECURE).toBe(true);
  });

  it("names a missing required variable", () => {
    const raw = { ...baseEnv(), DATABASE_URL: undefined };
    expect(() => parseEnv(raw)).toThrow(
      "Missing required environment variable: DATABASE_URL",
    );
  });

  it("names every missing required variable", () => {
    const raw = { ...baseEnv(), DATABASE_URL: undefined, APP_URL: undefined };
    expect(() => parseEnv(raw)).toThrow(/DATABASE_URL/);
    expect(() => parseEnv(raw)).toThrow(/APP_URL/);
  });

  it("requires SMTP_URL only when EMAIL_DRIVER is smtp", () => {
    expect(() => parseEnv({ ...baseEnv(), SMTP_URL: undefined })).toThrow(
      /SMTP_URL/,
    );
    const resend = {
      ...baseEnv(),
      EMAIL_DRIVER: "resend",
      SMTP_URL: undefined,
      RESEND_API_KEY: "re_test",
    };
    expect(() => parseEnv(resend)).not.toThrow();
  });

  it("requires RESEND_API_KEY only when EMAIL_DRIVER is resend", () => {
    const resend = {
      ...baseEnv(),
      EMAIL_DRIVER: "resend",
      RESEND_API_KEY: undefined,
      SMTP_URL: undefined,
    };
    expect(() => parseEnv(resend)).toThrow(/RESEND_API_KEY/);
  });

  it("requires GEMINI_API_KEY only when OCR_PROVIDER is gemini", () => {
    expect(() =>
      parseEnv({
        ...baseEnv(),
        OCR_PROVIDER: "gemini",
        GEMINI_API_KEY: undefined,
      }),
    ).toThrow(/GEMINI_API_KEY/);
    expect(() =>
      parseEnv({
        ...baseEnv(),
        OCR_PROVIDER: "fake",
        GEMINI_API_KEY: undefined,
      }),
    ).not.toThrow();
  });

  it("requires TEST_DATABASE_URL only when NODE_ENV is test", () => {
    expect(() =>
      parseEnv({
        ...baseEnv(),
        NODE_ENV: "test",
        TEST_DATABASE_URL: undefined,
      }),
    ).toThrow(/TEST_DATABASE_URL/);
    expect(() =>
      parseEnv({
        ...baseEnv(),
        NODE_ENV: "development",
        TEST_DATABASE_URL: undefined,
      }),
    ).not.toThrow();
  });

  it("requires CF_TUNNEL_TOKEN only in the cloudflared profile", () => {
    expect(() =>
      parseEnv({
        ...baseEnv(),
        COMPOSE_PROFILES: "cloudflared",
        CF_TUNNEL_TOKEN: undefined,
      }),
    ).toThrow(/CF_TUNNEL_TOKEN/);
    expect(() =>
      parseEnv({
        ...baseEnv(),
        COMPOSE_PROFILES: "app",
        CF_TUNNEL_TOKEN: undefined,
      }),
    ).not.toThrow();
  });

  it("names APP_URL and BETTER_AUTH_URL when they are not valid URLs", () => {
    expect(() => parseEnv({ ...baseEnv(), APP_URL: "not a url" })).toThrow(
      /APP_URL/,
    );
    expect(() => parseEnv({ ...baseEnv(), BETTER_AUTH_URL: "::::" })).toThrow(
      /BETTER_AUTH_URL/,
    );
  });

  it("never includes secret values in error messages", () => {
    const raw = {
      ...baseEnv(),
      EMAIL_DRIVER: "bogus",
      RESEND_API_KEY: "re_secret_abc123",
    };
    let message = "";
    try {
      parseEnv(raw);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("EMAIL_DRIVER");
    expect(message).not.toContain("re_secret_abc123");
  });
});
