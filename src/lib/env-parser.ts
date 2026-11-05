import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

export const envSchema = z
  .object({
    DATABASE_URL: z.string(),
    TEST_DATABASE_URL: z.string().optional(),
    BETTER_AUTH_SECRET: z.string(),
    BETTER_AUTH_URL: z.url(),
    APP_URL: z.url(),
    COOKIE_SECURE: booleanFromString.optional(),
    EMAIL_DRIVER: z.enum(["resend", "smtp", "fake"]).default("smtp"),
    EMAIL_FROM: z.string(),
    RESEND_API_KEY: z.string().optional(),
    SMTP_URL: z.string().optional(),
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
    OCR_PROVIDER: z.enum(["gemini", "fake", "fail"]).default("gemini"),
    OCR_INLINE: booleanFromString.default(false),
    OCR_MONTHLY_JOB_CAP: z.coerce.number().int().positive().default(10000),
    RECEIPT_STORAGE_DIR: z.string().default("receipts"),
    RECEIPT_MAX_BYTES: z.coerce.number().int().positive().default(10485760),
    NOTIFICATIONS_INLINE: booleanFromString.default(false),
    CF_TUNNEL_TOKEN: z.string().optional(),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .transform((parsed) => ({
    ...parsed,
    // COOKIE_SECURE defaults to the APP_URL protocol (https -> true).
    COOKIE_SECURE:
      parsed.COOKIE_SECURE ?? parsed.APP_URL.startsWith("https://"),
  }));

export type Env = z.infer<typeof envSchema>;

const REQUIRED_ALWAYS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "APP_URL",
  "EMAIL_FROM",
] as const;

function isMissing(
  raw: Record<string, string | undefined>,
  name: string,
): boolean {
  const value = raw[name];
  return value === undefined || value === "";
}

/**
 * Throws naming the missing required variable (never its value). Conditional:
 * RESEND_API_KEY when EMAIL_DRIVER=resend, SMTP_URL when smtp, GEMINI_API_KEY
 * when OCR_PROVIDER=gemini, TEST_DATABASE_URL when NODE_ENV=test, and
 * CF_TUNNEL_TOKEN when the cloudflared compose profile is active.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const missing: string[] = [];

  const requirePresent = (name: string): void => {
    if (isMissing(raw, name)) missing.push(name);
  };

  for (const name of REQUIRED_ALWAYS) requirePresent(name);

  const emailDriver = raw.EMAIL_DRIVER ?? "smtp";
  if (emailDriver === "resend") requirePresent("RESEND_API_KEY");
  else if (emailDriver === "smtp") requirePresent("SMTP_URL");

  const ocrProvider = raw.OCR_PROVIDER ?? "gemini";
  if (ocrProvider === "gemini") requirePresent("GEMINI_API_KEY");

  if (raw.NODE_ENV === "test") requirePresent("TEST_DATABASE_URL");

  const composeProfiles = (raw.COMPOSE_PROFILES ?? "").split(",");
  if (composeProfiles.includes("cloudflared"))
    requirePresent("CF_TUNNEL_TOKEN");

  if (missing.length > 0) {
    const label = missing.length === 1 ? "variable" : "variables";
    throw new Error(
      `Missing required environment ${label}: ${missing.join(", ")}`,
    );
  }

  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.join(".") || "environment";
    throw new Error(`Invalid environment variable ${path}: ${issue.message}`);
  }

  return result.data;
}
