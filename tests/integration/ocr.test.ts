import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { client } from "@/db/client";
import * as schema from "@/db/schema";
import { buildJpegBuffer } from "../fixtures/generate-receipt-fixtures";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error("TEST_DATABASE_URL is not set");
}

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: getSessionMock } },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

const USER_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const USER_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const USER_C = "cccccccc-0000-4000-8000-00000000000c";

function sessionFor(userId: string, email: string) {
  return {
    session: { id: "s", userId, expiresAt: new Date() },
    user: { id: userId, email },
  };
}

let sql: ReturnType<typeof postgres>;
let storageDir: string;
let ocrService: typeof import("../../src/services/ocr");
let receiptsService: typeof import("../../src/services/receipts");
let ocrRoute: typeof import("../../src/app/api/ocr-jobs/[id]/route");
let receiptsRoute: typeof import("../../src/app/api/receipts/route");
let expensesRoute: typeof import("../../src/app/api/events/[id]/expenses/route");
let env: typeof import("../../src/lib/env").env;

async function createOrganizedEvent(): Promise<{
  eventId: string;
  organizerMemberId: string;
  memberBId: string;
}> {
  const rows = await sql<Array<{ id: string }>>`
    insert into events (name, organizer_user_id, currency)
    values ('Trip', ${USER_A}, 'EUR') returning id
  `;
  const eventId = rows[0].id;
  const members = await sql<Array<{ id: string; user_id: string }>>`
    insert into event_members (event_id, user_id, email_normalized, role, status, joined_at)
    values
      (${eventId}, ${USER_A}, 'a@example.com', 'organizer', 'active', now()),
      (${eventId}, ${USER_B}, 'b@example.com', 'member', 'active', now())
    returning id, user_id
  `;
  const organizer = members.find((m) => m.user_id === USER_A);
  const memberB = members.find((m) => m.user_id === USER_B);
  if (!organizer || !memberB) {
    throw new Error("failed to seed members");
  }
  return {
    eventId,
    organizerMemberId: organizer.id,
    memberBId: memberB.id,
  };
}

async function uploadReceipt(
  eventId: string,
  bytes: Uint8Array,
): Promise<{ receiptId: string; jobId: string }> {
  const result = await receiptsService.createReceipt(eventId, bytes);
  if (!result.ocr.jobId) {
    throw new Error("expected a queued OCR job");
  }
  return { receiptId: result.receiptId, jobId: result.ocr.jobId };
}

async function jobRow(jobId: string) {
  const rows = await sql<
    Array<{
      status: string;
      attempts: number;
      result_json: unknown;
      error_code: string | null;
      next_attempt_at: Date | null;
      started_at: Date | null;
      finished_at: Date | null;
      provider: string | null;
      model: string | null;
    }>
  >`select status, attempts, result_json, error_code, next_attempt_at,
           started_at, finished_at, provider, model
     from ocr_jobs where id = ${jobId}`;
  return rows[0];
}

async function seedThrottle(key: string, count: number): Promise<void> {
  const expires = new Date(Date.now() + 3600_000).toISOString();
  await sql`
    insert into request_throttle (key, window_start, count, expires_at)
    values (${key}, now(), ${count}, ${expires}::timestamptz)
    on conflict (key) do update set count = ${count}, expires_at = ${expires}::timestamptz
  `;
}

function failingProvider(reason: string) {
  return {
    name: "fail" as const,
    extract: async () => ({ ok: false as const, reason }),
  };
}

function extractionProvider(extraction: {
  amount: string;
  currency: string;
  date: string;
  merchant: string;
}) {
  return {
    name: "fake" as const,
    extract: async () => ({ ok: true as const, extraction }),
  };
}

beforeAll(async () => {
  const REQUIRED_ENV: Record<string, string> = {
    DATABASE_URL: "postgres://unused:unused@localhost:5432/unused",
    BETTER_AUTH_SECRET: "integration-test-secret",
    BETTER_AUTH_URL: "http://localhost:3100",
    APP_URL: "http://localhost:3100",
    EMAIL_FROM: "kittie@test.local",
    SMTP_URL: "smtp://localhost:1025",
    OCR_PROVIDER: "fake",
    OCR_INLINE: "false",
  };
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  storageDir = mkdtempSync(path.join(os.tmpdir(), "kittie-ocr-test-"));
  process.env.RECEIPT_STORAGE_DIR = storageDir;
  process.env.RECEIPT_MAX_BYTES = String(10 * 1024 * 1024);

  sql = postgres(url, { max: 1 });
  await sql`drop schema if exists public cascade`;
  await sql`drop schema if exists drizzle cascade`;
  await sql`create schema public`;
  const db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: "drizzle" });

  env = (await import("../../src/lib/env")).env;
  ocrService = await import("../../src/services/ocr");
  receiptsService = await import("../../src/services/receipts");
  ocrRoute = await import("../../src/app/api/ocr-jobs/[id]/route");
  receiptsRoute = await import("../../src/app/api/receipts/route");
  expensesRoute = await import("../../src/app/api/events/[id]/expenses/route");
});

afterAll(async () => {
  env.OCR_INLINE = false;
  rmSync(storageDir, { recursive: true, force: true });
  await sql?.end();
  await client.end();
});

beforeEach(async () => {
  await sql`truncate table events cascade`;
  await sql`truncate table request_throttle`;
  env.OCR_INLINE = false;
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
});

describe("OCR job processing", () => {
  it("processes a fake job to succeeded with the fixture fields", async () => {
    const { eventId } = await createOrganizedEvent();
    const { jobId } = await uploadReceipt(eventId, await buildJpegBuffer());

    const before = await jobRow(jobId);
    expect(before.status).toBe("queued");
    expect(before.attempts).toBe(0);

    const outcome = await ocrService.processOcrJob(
      jobId,
      new (await import("../../src/lib/ocr/fake")).FakeOcrProvider(),
    );

    expect(outcome.status).toBe("succeeded");
    expect(outcome.result?.amountMinor).toBe(1250);
    expect(outcome.result?.currency).toBe("EUR");
    expect(outcome.result?.eventCurrency).toBe("EUR");
    expect(outcome.result?.currencyMismatch).toBe(false);
    expect(outcome.result?.date).toBe("2026-11-04");
    expect(outcome.result?.merchant).toMatch(/^Fixture Merchant [0-9a-f]{8}$/);

    const after = await jobRow(jobId);
    expect(after.status).toBe("succeeded");
    expect(after.attempts).toBe(1);
    expect(after.provider).toBe("fake");
    expect(after.model).toBeTruthy();
    expect(after.started_at).not.toBeNull();
    expect(after.finished_at).not.toBeNull();
    expect(after.error_code).toBeNull();
  });

  it("retries a failing provider three times then fails with a named code", async () => {
    const { eventId } = await createOrganizedEvent();
    const { jobId } = await uploadReceipt(eventId, await buildJpegBuffer());

    const provider = failingProvider("provider exploded");

    const first = await ocrService.processOcrJob(jobId, provider);
    expect(first.status).toBe("retrying");
    expect(first.attempts).toBe(1);
    const afterFirst = await jobRow(jobId);
    expect(afterFirst.status).toBe("queued");
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.next_attempt_at).not.toBeNull();

    const second = await ocrService.processOcrJob(jobId, provider);
    expect(second.status).toBe("retrying");
    expect(second.attempts).toBe(2);

    const third = await ocrService.processOcrJob(jobId, provider);
    expect(third.status).toBe("failed");
    expect(third.attempts).toBe(3);
    expect(third.errorCode).toBe("OCR_PROVIDER_FAILED");

    const afterThird = await jobRow(jobId);
    expect(afterThird.status).toBe("failed");
    expect(afterThird.attempts).toBe(3);
    expect(afterThird.error_code).toBe("OCR_PROVIDER_FAILED");
    expect(afterThird.finished_at).not.toBeNull();

    const fourth = await ocrService.processOcrJob(jobId, provider);
    expect(fourth.status).toBe("failed");
    expect(fourth.attempts).toBe(3);

    const eventsCount = await sql<Array<{ count: number }>>`
      select count(*)::int as count from events where id = ${eventId}
    `;
    expect(eventsCount[0].count).toBe(1);
  });

  it("rejects a zero amount after three attempts", async () => {
    const { eventId } = await createOrganizedEvent();
    const { jobId } = await uploadReceipt(eventId, await buildJpegBuffer());

    const provider = extractionProvider({
      amount: "0.00",
      currency: "EUR",
      date: "2026-11-04",
      merchant: "Zero Cafe",
    });

    await ocrService.processOcrJob(jobId, provider);
    await ocrService.processOcrJob(jobId, provider);
    const outcome = await ocrService.processOcrJob(jobId, provider);

    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("OCR_INVALID_EXTRACTION");
    const row = await jobRow(jobId);
    expect(row.attempts).toBe(3);
    expect(row.result_json).toBeNull();
  });

  it("leaves the date empty when the provider returns an unparseable date", async () => {
    const { eventId } = await createOrganizedEvent();
    const { jobId } = await uploadReceipt(eventId, await buildJpegBuffer());

    const outcome = await ocrService.processOcrJob(
      jobId,
      extractionProvider({
        amount: "48.20",
        currency: "EUR",
        date: "4 November 2026",
        merchant: "Mercado",
      }),
    );

    expect(outcome.status).toBe("succeeded");
    expect(outcome.result?.date).toBe("");
    expect(outcome.result?.amountMinor).toBe(4820);
  });

  it("parses an amount printed in a foreign currency", async () => {
    const { eventId } = await createOrganizedEvent();
    const { jobId } = await uploadReceipt(eventId, await buildJpegBuffer());

    const outcome = await ocrService.processOcrJob(
      jobId,
      extractionProvider({
        amount: "1.234,56",
        currency: "usd",
        date: "2026-11-04",
        merchant: "Diner",
      }),
    );

    expect(outcome.status).toBe("succeeded");
    expect(outcome.result?.amountMinor).toBe(123456);
    expect(outcome.result?.currency).toBe("USD");
    expect(outcome.result?.currencyMismatch).toBe(true);
  });
});

describe("OCR quotas", () => {
  it("blocks the per-user daily cap and keeps manual expense entry working", async () => {
    const { eventId, organizerMemberId, memberBId } =
      await createOrganizedEvent();
    const { jobId } = await uploadReceipt(eventId, await buildJpegBuffer());

    const keys = ocrService.ocrQuotaKeys(USER_A, eventId);
    await seedThrottle(keys.userDayKey, 50);

    const outcome = await ocrService.processOcrJob(jobId);
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("OCR_QUOTA_EXCEEDED");

    const row = await jobRow(jobId);
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("OCR_QUOTA_EXCEEDED");

    const response = await expensesRoute.POST(
      new Request(`http://localhost/api/events/${eventId}/expenses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          totalMinor: 3000,
          spentOn: "2026-11-04",
          paidByMemberId: organizerMemberId,
          splitMode: "equal",
          participants: [
            { memberId: organizerMemberId },
            { memberId: memberBId },
          ],
        }),
      }),
      { params: Promise.resolve({ id: eventId }) },
    );
    expect(response.status).toBe(201);
    const expenses = await sql<Array<{ count: number }>>`
      select count(*)::int as count from expenses where event_id = ${eventId}
    `;
    expect(expenses[0].count).toBe(1);
  });

  it("blocks the per-event daily cap", async () => {
    const { eventId } = await createOrganizedEvent();
    const { jobId } = await uploadReceipt(eventId, await buildJpegBuffer());

    const keys = ocrService.ocrQuotaKeys(USER_A, eventId);
    await seedThrottle(keys.eventDayKey, 200);

    const outcome = await ocrService.processOcrJob(jobId);
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("OCR_QUOTA_EXCEEDED");
  });

  it("blocks the monthly job cap", async () => {
    const { eventId } = await createOrganizedEvent();
    const { jobId } = await uploadReceipt(eventId, await buildJpegBuffer());

    const keys = ocrService.ocrQuotaKeys(USER_A, eventId);
    await seedThrottle(keys.monthlyKey, env.OCR_MONTHLY_JOB_CAP);

    const outcome = await ocrService.processOcrJob(jobId);
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("OCR_QUOTA_EXCEEDED");
  });

  it("counts usage after a successful first attempt", async () => {
    const { eventId } = await createOrganizedEvent();
    const { jobId } = await uploadReceipt(eventId, await buildJpegBuffer());

    await ocrService.processOcrJob(jobId);

    const keys = ocrService.ocrQuotaKeys(USER_A, eventId);
    const rows = await sql<Array<{ key: string; count: number }>>`
      select key, count from request_throttle where key = any(${[keys.monthlyKey, keys.userDayKey, keys.eventDayKey]})
    `;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.count).toBe(1);
    }
  });
});

describe("stale reclaim", () => {
  async function insertJob(
    receiptId: string,
    attempts: number,
    startedAgoMs: number,
  ): Promise<string> {
    const started = new Date(Date.now() - startedAgoMs).toISOString();
    const rows = await sql<Array<{ id: string }>>`
      insert into ocr_jobs (receipt_id, status, attempts, started_at)
      values (${receiptId}, 'running', ${attempts}, ${started}::timestamptz)
      returning id
    `;
    return rows[0].id;
  }

  it("returns a stale running job to queued with attempts + 1", async () => {
    const { eventId } = await createOrganizedEvent();
    const { jobId } = await uploadReceipt(eventId, await buildJpegBuffer());
    await sql`delete from ocr_jobs where id = ${jobId}`;
    const receipts = await sql<Array<{ id: string }>>`
      select id from receipts where event_id = ${eventId} limit 1
    `;

    const staleId = await insertJob(receipts[0].id, 1, 16 * 60 * 1000);
    const reclaimed = await ocrService.reclaimStaleOcrJobs();
    expect(reclaimed).toContain(staleId);

    const row = await jobRow(staleId);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(2);
    expect(row.error_code).toBe("STALE_JOB");
  });

  it("fails a stale job that has no attempts left", async () => {
    const { eventId } = await createOrganizedEvent();
    const { jobId } = await uploadReceipt(eventId, await buildJpegBuffer());
    await sql`delete from ocr_jobs where id = ${jobId}`;
    const rows = await sql<Array<{ id: string }>>`
      select id from receipts where event_id = ${eventId} limit 1
    `;
    const staleId = await insertJob(rows[0].id, 3, 16 * 60 * 1000);

    await ocrService.reclaimStaleOcrJobs();

    const row = await jobRow(staleId);
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("STALE_JOB");
    expect(row.finished_at).not.toBeNull();
  });

  it("leaves a fresh running job alone", async () => {
    const { eventId } = await createOrganizedEvent();
    const { jobId } = await uploadReceipt(eventId, await buildJpegBuffer());
    await sql`delete from ocr_jobs where id = ${jobId}`;
    const rows = await sql<Array<{ id: string }>>`
      select id from receipts where event_id = ${eventId} limit 1
    `;
    const liveId = await insertJob(rows[0].id, 1, 60 * 1000);

    const reclaimed = await ocrService.reclaimStaleOcrJobs();
    expect(reclaimed).not.toContain(liveId);
    const row = await jobRow(liveId);
    expect(row.status).toBe("running");
  });
});

describe("GET /api/ocr-jobs/[id]", () => {
  function getJob(jobId: string): Promise<Response> {
    return ocrRoute.GET(new Request(`http://localhost/api/ocr-jobs/${jobId}`), {
      params: Promise.resolve({ id: jobId }),
    });
  }

  it("returns status and result to the uploader", async () => {
    const { eventId } = await createOrganizedEvent();
    const { jobId } = await uploadReceipt(eventId, await buildJpegBuffer());
    await ocrService.processOcrJob(jobId);

    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const response = await getJob(jobId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      result: { amountMinor: number; merchant: string } | null;
    };
    expect(body.status).toBe("succeeded");
    expect(body.result?.amountMinor).toBe(1250);
  });

  it("returns status to another active event member", async () => {
    const { eventId } = await createOrganizedEvent();
    const { jobId } = await uploadReceipt(eventId, await buildJpegBuffer());

    getSessionMock.mockResolvedValue(sessionFor(USER_B, "b@example.com"));
    const response = await getJob(jobId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("queued");
  });

  it("404s a non-member without leaking existence", async () => {
    const { eventId } = await createOrganizedEvent();
    const { jobId } = await uploadReceipt(eventId, await buildJpegBuffer());

    getSessionMock.mockResolvedValue(sessionFor(USER_C, "c@example.com"));
    const response = await getJob(jobId);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("401s without a session", async () => {
    const { eventId } = await createOrganizedEvent();
    const { jobId } = await uploadReceipt(eventId, await buildJpegBuffer());

    getSessionMock.mockResolvedValue(null);
    const response = await getJob(jobId);
    expect(response.status).toBe(401);
  });

  it("404s an unknown or malformed job id", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const unknown = await getJob("123e4567-e89b-4000-8000-000000000009");
    expect(unknown.status).toBe(404);
    const malformed = await getJob("../../etc/passwd");
    expect(malformed.status).toBe(404);
  });
});

describe("OCR_INLINE", () => {
  function postReceipt(eventId: string, bytes: Uint8Array): Promise<Response> {
    const form = new FormData();
    form.set("eventId", eventId);
    form.set("file", new Blob([bytes as unknown as BlobPart]), "receipt.jpg");
    return receiptsRoute.POST(
      new Request("http://localhost/api/receipts", {
        method: "POST",
        body: form,
      }),
    );
  }

  it("processes the job inside the upload request when OCR_INLINE is true", async () => {
    env.OCR_INLINE = true;
    const { eventId } = await createOrganizedEvent();

    const response = await postReceipt(eventId, await buildJpegBuffer());
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ocr: { status: string; jobId: string };
    };
    expect(body.ocr.status).toBe("succeeded");

    const row = await jobRow(body.ocr.jobId);
    expect(row.status).toBe("succeeded");
    expect(row.attempts).toBe(1);
    expect(row.result_json).not.toBeNull();
  });

  it("leaves the job queued when OCR_INLINE is false", async () => {
    env.OCR_INLINE = false;
    const { eventId } = await createOrganizedEvent();

    const response = await postReceipt(eventId, await buildJpegBuffer());
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ocr: { status: string; jobId: string };
    };
    expect(body.ocr.status).toBe("queued");
    const row = await jobRow(body.ocr.jobId);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(0);
  });
});

describe("worker lifecycle", () => {
  it("exits gracefully on SIGTERM", async () => {
    const worktree = path.resolve(import.meta.dirname, "../..");
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "test",
      TEST_DATABASE_URL: url,
      DATABASE_URL: process.env.DATABASE_URL ?? url,
      RECEIPT_STORAGE_DIR: storageDir,
      OCR_PROVIDER: "fake",
      OCR_INLINE: "false",
      BETTER_AUTH_SECRET: "integration-test-secret",
      BETTER_AUTH_URL: "http://localhost:3100",
      APP_URL: "http://localhost:3100",
      EMAIL_FROM: "kittie@test.local",
      SMTP_URL: "smtp://localhost:1025",
    };

    const child: ChildProcess = spawn("bun", ["run", "src/worker.ts"], {
      cwd: worktree,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const started = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 20_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes('"event":"started"')) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    expect(started).toBe(true);

    child.kill("SIGTERM");

    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 15_000);
      child.on("exit", (code: number | null) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(exitCode).toBe(0);
  }, 40_000);
});
