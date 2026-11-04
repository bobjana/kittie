import postgres from "postgres";
import { loadEnv } from "vite";

// The throttle is IP-keyed at 50/hour and every run registers from ::1, so an
// untruncated counter silently swallows registration mail and fails every
// mail-dependent test. Reset the counters; the email-level throttle test still
// exercises the limiter within the run.
export default async function globalSetup(): Promise<void> {
  const env = loadEnv("test", process.cwd(), "");
  const url = env.DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required for the e2e database preparation",
    );
  }

  const sql = postgres(url, { max: 1 });
  try {
    await sql`truncate table request_throttle`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
