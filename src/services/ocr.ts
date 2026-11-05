import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm";

import { client, db } from "@/db/client";
import { events, ocrJobs, receipts } from "@/db/schema";
import { env } from "@/lib/env";
import { FailOcrProvider } from "@/lib/ocr/fail";
import { FakeOcrProvider } from "@/lib/ocr/fake";
import { GeminiOcrProvider } from "@/lib/ocr/gemini";
import {
  type OcrExtraction,
  type OcrProvider,
  type OcrProviderResult,
  parseAmountToMinor,
  parseIsoDate,
} from "@/lib/ocr/provider";
import { incrementThrottle } from "@/lib/rate-limit";
import { readReceiptFile } from "@/lib/storage";

export const OCR_ERROR_CODES = {
  OCR_PROVIDER_FAILED: "OCR_PROVIDER_FAILED",
  OCR_INVALID_EXTRACTION: "OCR_INVALID_EXTRACTION",
  OCR_QUOTA_EXCEEDED: "OCR_QUOTA_EXCEEDED",
  OCR_RECEIPT_MISSING: "OCR_RECEIPT_MISSING",
  OCR_JOB_NOT_FOUND: "OCR_JOB_NOT_FOUND",
  STALE_JOB: "STALE_JOB",
} as const;

export const OCR_MAX_ATTEMPTS = 3;
export const OCR_STALE_THRESHOLD_MS = 15 * 60 * 1000;

const BASE_BACKOFF_MS = 2000;
const DAILY_USER_LIMIT = 50;
const DAILY_EVENT_LIMIT = 200;
const DAY_WINDOW_SECONDS = 2 * 24 * 3600;
const MONTH_WINDOW_SECONDS = 40 * 24 * 3600;

export class OcrError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = "OcrError";
    this.status = status;
    this.code = code;
  }
}

export interface OcrResultJson {
  amountMinor: number;
  currency: string;
  eventCurrency: string;
  currencyMismatch: boolean;
  date: string;
  merchant: string;
}

export interface OcrOutcome {
  jobId: string;
  status: "succeeded" | "failed" | "retrying";
  attempts: number;
  result: OcrResultJson | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface OcrJobView {
  id: string;
  receiptId: string;
  status: string;
  attempts: number;
  result: OcrResultJson | null;
  errorCode: string | null;
  errorMessage: string | null;
}

type OcrJobRecord = typeof ocrJobs.$inferSelect;

export function resolveOcrProvider(): OcrProvider {
  switch (env.OCR_PROVIDER) {
    case "fake":
      return new FakeOcrProvider();
    case "fail":
      return new FailOcrProvider();
    default:
      return new GeminiOcrProvider();
  }
}

export async function getOcrJob(jobId: string): Promise<OcrJobView | null> {
  const row = await db.query.ocrJobs.findFirst({
    where: eq(ocrJobs.id, jobId),
  });
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    receiptId: row.receiptId,
    status: row.status,
    attempts: row.attempts,
    result: (row.resultJson as OcrResultJson | null) ?? null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  };
}

export function ocrQuotaKeys(
  userId: string,
  eventId: string,
): { monthlyKey: string; userDayKey: string; eventDayKey: string } {
  const day = new Date().toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  return {
    monthlyKey: `ocr:monthly:${userId}:${month}`,
    userDayKey: `ocr:user:${userId}:${day}`,
    eventDayKey: `ocr:event:${eventId}:${day}`,
  };
}

async function readActiveThrottleCount(key: string): Promise<number> {
  const rows = await client<{ count: number }[]>`
    select count
    from request_throttle
    where key = ${key} and expires_at > now()
    limit 1
  `;
  return rows[0]?.count ?? 0;
}

export interface QuotaVerdict {
  exceeded: boolean;
  reason: string | null;
}

export async function recordOcrQuotaUsage(
  userId: string,
  eventId: string,
): Promise<QuotaVerdict> {
  const { monthlyKey, userDayKey, eventDayKey } = ocrQuotaKeys(userId, eventId);
  const monthly = await readActiveThrottleCount(monthlyKey);
  if (monthly >= env.OCR_MONTHLY_JOB_CAP) {
    return { exceeded: true, reason: "monthly OCR job cap reached" };
  }
  const userToday = await readActiveThrottleCount(userDayKey);
  if (userToday >= DAILY_USER_LIMIT) {
    return { exceeded: true, reason: "per-user daily OCR limit reached" };
  }
  const eventToday = await readActiveThrottleCount(eventDayKey);
  if (eventToday >= DAILY_EVENT_LIMIT) {
    return { exceeded: true, reason: "per-event daily OCR limit reached" };
  }
  await incrementThrottle(
    monthlyKey,
    env.OCR_MONTHLY_JOB_CAP,
    MONTH_WINDOW_SECONDS,
  );
  await incrementThrottle(userDayKey, DAILY_USER_LIMIT, DAY_WINDOW_SECONDS);
  await incrementThrottle(eventDayKey, DAILY_EVENT_LIMIT, DAY_WINDOW_SECONDS);
  return { exceeded: false, reason: null };
}

export function validateOcrExtraction(
  extraction: OcrExtraction,
  eventCurrency: string,
): { ok: true; result: OcrResultJson } | { ok: false; reason: string } {
  const amountMinor = parseAmountToMinor(extraction.amount);
  if (amountMinor === null) {
    return {
      ok: false,
      reason: `amount "${extraction.amount}" is not a parseable decimal`,
    };
  }
  if (amountMinor <= 0) {
    return {
      ok: false,
      reason: `amount "${extraction.amount}" must be greater than zero`,
    };
  }
  const currency = extraction.currency.trim().toUpperCase().slice(0, 3);
  if (!/^[A-Z]{3}$/.test(currency)) {
    return {
      ok: false,
      reason: `currency "${extraction.currency}" is not a 3-letter ISO code`,
    };
  }
  const date = parseIsoDate(extraction.date) ?? "";
  const normalizedEventCurrency = eventCurrency.toUpperCase();
  return {
    ok: true,
    result: {
      amountMinor,
      currency,
      eventCurrency: normalizedEventCurrency,
      currencyMismatch: currency !== normalizedEventCurrency,
      date,
      merchant: extraction.merchant.trim(),
    },
  };
}

function backoffMs(attempts: number): number {
  return BASE_BACKOFF_MS * 2 ** (attempts - 1);
}

function logAttempt(
  provider: OcrProvider,
  jobId: string,
  attempts: number,
  startedMs: number,
  outcome: string,
  errorCode: string | null,
): void {
  console.log(
    JSON.stringify({
      component: "ocr",
      provider: provider.name,
      model: env.GEMINI_MODEL,
      jobId,
      attempts,
      durationMs: Date.now() - startedMs,
      outcome,
      ...(errorCode === null ? {} : { errorCode }),
    }),
  );
}

function toOutcome(jobId: string, row: OcrJobRecord): OcrOutcome {
  return {
    jobId,
    status:
      row.status === "succeeded"
        ? "succeeded"
        : row.status === "failed"
          ? "failed"
          : "retrying",
    attempts: row.attempts,
    result: (row.resultJson as OcrResultJson | null) ?? null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  };
}

async function markRunning(
  jobId: string,
  provider: OcrProvider,
): Promise<{ attempts: number } | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(ocrJobs)
      .where(eq(ocrJobs.id, jobId))
      .for("update");
    const row = rows[0];
    if (!row) {
      return null;
    }
    if (row.status === "succeeded" || row.status === "failed") {
      return null;
    }
    const attempts = row.attempts + 1;
    await tx
      .update(ocrJobs)
      .set({
        status: "running",
        attempts,
        provider: provider.name,
        model: env.GEMINI_MODEL,
        startedAt: row.startedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(ocrJobs.id, jobId));
    return { attempts };
  });
}

async function finalizeRetryOrFailure(
  jobId: string,
  attempts: number,
  code: string,
  message: string,
): Promise<OcrOutcome> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(ocrJobs)
      .where(eq(ocrJobs.id, jobId))
      .for("update");
    const row = rows[0];
    if (!row) {
      throw new OcrError(404, OCR_ERROR_CODES.OCR_JOB_NOT_FOUND);
    }
    if (row.status === "succeeded" || row.status === "failed") {
      return toOutcome(jobId, row);
    }
    if (attempts < OCR_MAX_ATTEMPTS) {
      await tx
        .update(ocrJobs)
        .set({
          status: "queued",
          attempts,
          nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
          errorCode: code,
          errorMessage: message,
          updatedAt: new Date(),
        })
        .where(eq(ocrJobs.id, jobId));
      return {
        jobId,
        status: "retrying" as const,
        attempts,
        result: null,
        errorCode: code,
        errorMessage: message,
      };
    }
    await tx
      .update(ocrJobs)
      .set({
        status: "failed",
        attempts,
        errorCode: code,
        errorMessage: message,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(ocrJobs.id, jobId));
    return {
      jobId,
      status: "failed" as const,
      attempts,
      result: null,
      errorCode: code,
      errorMessage: message,
    };
  });
}

async function finalizeTerminalFailure(
  jobId: string,
  code: string,
  message: string,
): Promise<OcrOutcome> {
  return finalizeRetryOrFailure(jobId, OCR_MAX_ATTEMPTS, code, message);
}

export async function processOcrJob(
  jobId: string,
  providerOverride?: OcrProvider,
): Promise<OcrOutcome> {
  const provider = providerOverride ?? resolveOcrProvider();
  const attemptStartedAt = Date.now();
  const finish = (outcome: OcrOutcome): OcrOutcome => {
    logAttempt(
      provider,
      jobId,
      outcome.attempts,
      attemptStartedAt,
      outcome.status,
      outcome.errorCode,
    );
    return outcome;
  };

  const current = await db.query.ocrJobs.findFirst({
    where: eq(ocrJobs.id, jobId),
  });
  if (!current) {
    throw new OcrError(404, OCR_ERROR_CODES.OCR_JOB_NOT_FOUND);
  }
  if (current.status === "succeeded" || current.status === "failed") {
    return toOutcome(jobId, current);
  }

  const claimed = await markRunning(jobId, provider);
  if (claimed === null) {
    const raced = await db.query.ocrJobs.findFirst({
      where: eq(ocrJobs.id, jobId),
    });
    if (!raced) {
      throw new OcrError(404, OCR_ERROR_CODES.OCR_JOB_NOT_FOUND);
    }
    return toOutcome(jobId, raced);
  }
  const attempts = claimed.attempts;

  const receiptRows = await db
    .select({
      eventId: receipts.eventId,
      uploadedBy: receipts.uploadedBy,
      objectKey: receipts.objectKey,
      mime: receipts.mime,
    })
    .from(receipts)
    .where(eq(receipts.id, current.receiptId))
    .limit(1);
  const receipt = receiptRows[0];
  if (!receipt) {
    return finish(
      await finalizeTerminalFailure(
        jobId,
        OCR_ERROR_CODES.OCR_RECEIPT_MISSING,
        "receipt no longer exists",
      ),
    );
  }

  if (attempts === 1 && receipt.uploadedBy !== null) {
    const quota = await recordOcrQuotaUsage(
      receipt.uploadedBy,
      receipt.eventId,
    );
    if (quota.exceeded) {
      return finish(
        await finalizeTerminalFailure(
          jobId,
          OCR_ERROR_CODES.OCR_QUOTA_EXCEEDED,
          `${quota.reason}; enter the expense manually`,
        ),
      );
    }
  }

  let image: Buffer;
  try {
    image = await readReceiptFile(receipt.objectKey);
  } catch {
    return finish(
      await finalizeTerminalFailure(
        jobId,
        OCR_ERROR_CODES.OCR_RECEIPT_MISSING,
        "receipt file is missing",
      ),
    );
  }

  const eventRows = await db
    .select({ currency: events.currency })
    .from(events)
    .where(eq(events.id, receipt.eventId))
    .limit(1);
  const eventCurrency = eventRows[0]?.currency ?? "EUR";

  let extraction: OcrProviderResult;
  try {
    extraction = await provider.extract({
      image,
      mime: receipt.mime ?? "image/jpeg",
    });
  } catch (error) {
    extraction = {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!extraction.ok) {
    const outcome = await finalizeRetryOrFailure(
      jobId,
      attempts,
      OCR_ERROR_CODES.OCR_PROVIDER_FAILED,
      extraction.reason,
    );
    return finish(outcome);
  }

  const validated = validateOcrExtraction(extraction.extraction, eventCurrency);
  if (!validated.ok) {
    const outcome = await finalizeRetryOrFailure(
      jobId,
      attempts,
      OCR_ERROR_CODES.OCR_INVALID_EXTRACTION,
      validated.reason,
    );
    return finish(outcome);
  }

  const outcome = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(ocrJobs)
      .where(eq(ocrJobs.id, jobId))
      .for("update");
    const row = rows[0];
    if (!row) {
      throw new OcrError(404, OCR_ERROR_CODES.OCR_JOB_NOT_FOUND);
    }
    if (row.status === "succeeded" || row.status === "failed") {
      return toOutcome(jobId, row);
    }
    await tx
      .update(ocrJobs)
      .set({
        status: "succeeded",
        attempts,
        resultJson: validated.result,
        errorCode: null,
        errorMessage: null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(ocrJobs.id, jobId));
    return {
      jobId,
      status: "succeeded" as const,
      attempts,
      result: validated.result,
      errorCode: null,
      errorMessage: null,
    };
  });
  return finish(outcome);
}

export async function claimNextOcrJob(): Promise<{ jobId: string } | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: ocrJobs.id })
      .from(ocrJobs)
      .where(
        and(
          eq(ocrJobs.status, "queued"),
          or(
            isNull(ocrJobs.nextAttemptAt),
            lte(ocrJobs.nextAttemptAt, new Date()),
          ),
        ),
      )
      .orderBy(asc(ocrJobs.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    const row = rows[0];
    if (!row) {
      return null;
    }
    await tx
      .update(ocrJobs)
      .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(eq(ocrJobs.id, row.id));
    return { jobId: row.id };
  });
}

export async function reclaimStaleOcrJobs(now = new Date()): Promise<string[]> {
  const threshold = new Date(now.getTime() - OCR_STALE_THRESHOLD_MS);
  const stale = await db
    .select({ id: ocrJobs.id })
    .from(ocrJobs)
    .where(
      and(eq(ocrJobs.status, "running"), lt(ocrJobs.startedAt, threshold)),
    );
  const reclaimed: string[] = [];
  for (const job of stale) {
    const updated = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(ocrJobs)
        .where(eq(ocrJobs.id, job.id))
        .for("update");
      const row = rows[0];
      if (
        !row ||
        row.status !== "running" ||
        row.startedAt === null ||
        row.startedAt.getTime() >= threshold.getTime()
      ) {
        return false;
      }
      if (row.attempts >= OCR_MAX_ATTEMPTS) {
        await tx
          .update(ocrJobs)
          .set({
            status: "failed",
            errorCode: OCR_ERROR_CODES.STALE_JOB,
            errorMessage:
              "job stalled past the stale threshold with no attempts left",
            finishedAt: now,
            updatedAt: now,
          })
          .where(eq(ocrJobs.id, row.id));
      } else {
        await tx
          .update(ocrJobs)
          .set({
            status: "queued",
            attempts: row.attempts + 1,
            errorCode: OCR_ERROR_CODES.STALE_JOB,
            errorMessage: "job stalled and was reclaimed",
            updatedAt: now,
          })
          .where(eq(ocrJobs.id, row.id));
      }
      return true;
    });
    if (updated) {
      reclaimed.push(job.id);
    }
  }
  return reclaimed;
}
