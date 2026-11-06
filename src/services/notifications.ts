import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm";
import { db } from "@/db/client";
import {
  eventMembers,
  eventSettlements,
  events,
  notificationJobs,
} from "@/db/schema";
import { AuthorizationError, requireOrganizer } from "@/lib/authorization";
import {
  type EmailDriver,
  emailDriver as resolveEmailDriver,
} from "@/lib/email/service";
import {
  buildTallyLink,
  closeTallyEmail,
  closeTallySubject,
} from "@/lib/email/templates/close-tally";
import { env } from "@/lib/env";
import {
  readSettlementSnapshot,
  readTransfers,
  type SettlementSnapshotJson,
  type Transfer,
} from "@/services/reports";

export const NOTIFICATION_ERROR_CODES = {
  STALE_JOB: "STALE_JOB",
  SETTLEMENT_SUPERSEDED: "SETTLEMENT_SUPERSEDED",
  RECIPIENT_REMOVED: "RECIPIENT_REMOVED",
  EMAIL_SEND_FAILED: "EMAIL_SEND_FAILED",
} as const;

export const NOTIFICATION_MAX_ATTEMPTS = 3;
export const NOTIFICATION_STALE_THRESHOLD_MS = 10 * 60 * 1000;
const BASE_BACKOFF_MS = 30_000;

export const NOTIFICATION_JOB_NOT_FOUND = "NOTIFICATION_JOB_NOT_FOUND";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class NotificationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = "NotificationError";
    this.status = status;
    this.code = code;
  }
}

export function notificationErrorToResponse(error: unknown): Response | null {
  if (error instanceof AuthorizationError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  if (error instanceof NotificationError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }
  return null;
}

export type NotificationJobStatus =
  | "queued"
  | "running"
  | "sent"
  | "failed"
  | "cancelled";

export interface NotificationOutcome {
  jobId: string;
  status: "sent" | "failed" | "cancelled" | "retrying" | "skipped";
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface NotificationJobView {
  id: string;
  settlementId: string;
  eventId: string;
  recipientMemberId: string;
  recipientEmail: string;
  displayName: string | null;
  status: NotificationJobStatus;
  attempts: number;
  nextAttemptAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  sentAt: string | null;
}

type NotificationJobRow = typeof notificationJobs.$inferSelect;

function backoffMs(attempts: number): number {
  return BASE_BACKOFF_MS * 2 ** (attempts - 1);
}

export function recipientLink(
  status: string,
  eventId: string,
  recipientEmail: string,
): string {
  return buildTallyLink(env.APP_URL, status, eventId, recipientEmail);
}

function logAttempt(
  jobId: string,
  attempts: number,
  startedMs: number,
  outcome: NotificationOutcome,
): void {
  console.log(
    JSON.stringify({
      component: "notifications",
      jobId,
      attempts,
      startedMs,
      status: outcome.status,
      errorCode: outcome.errorCode,
    }),
  );
}

async function markRunning(
  jobId: string,
): Promise<{ attempts: number } | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(notificationJobs)
      .where(eq(notificationJobs.id, jobId))
      .for("update");
    const row = rows[0];
    if (!row) {
      return null;
    }
    if (row.status !== "queued" && row.status !== "running") {
      return null;
    }
    const attempts = row.attempts + 1;
    await tx
      .update(notificationJobs)
      .set({ status: "running", attempts, updatedAt: new Date() })
      .where(eq(notificationJobs.id, jobId));
    return { attempts };
  });
}

async function finalizeRetryOrFailure(
  jobId: string,
  attempts: number,
  code: string,
  message: string,
): Promise<NotificationOutcome> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(notificationJobs)
      .where(eq(notificationJobs.id, jobId))
      .for("update");
    const row = rows[0];
    if (!row) {
      throw new NotificationError(404, NOTIFICATION_JOB_NOT_FOUND);
    }
    if (row.status !== "running") {
      return toOutcome(jobId, row);
    }
    if (attempts < NOTIFICATION_MAX_ATTEMPTS) {
      await tx
        .update(notificationJobs)
        .set({
          status: "queued",
          attempts,
          nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
          errorCode: code,
          errorMessage: message,
          updatedAt: new Date(),
        })
        .where(eq(notificationJobs.id, jobId));
      return {
        jobId,
        status: "retrying",
        attempts,
        errorCode: code,
        errorMessage: message,
      };
    }
    await tx
      .update(notificationJobs)
      .set({
        status: "failed",
        attempts,
        errorCode: code,
        errorMessage: message,
        updatedAt: new Date(),
      })
      .where(eq(notificationJobs.id, jobId));
    return {
      jobId,
      status: "failed",
      attempts,
      errorCode: code,
      errorMessage: message,
    };
  });
}

async function finalizeTerminalFailure(
  jobId: string,
  code: string,
  message: string,
): Promise<NotificationOutcome> {
  return finalizeRetryOrFailure(
    jobId,
    NOTIFICATION_MAX_ATTEMPTS,
    code,
    message,
  );
}

async function finalizeSkipped(
  jobId: string,
  code: string,
  message: string,
): Promise<NotificationOutcome> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(notificationJobs)
      .where(eq(notificationJobs.id, jobId))
      .for("update");
    const row = rows[0];
    if (!row) {
      throw new NotificationError(404, NOTIFICATION_JOB_NOT_FOUND);
    }
    if (row.status !== "running") {
      return toOutcome(jobId, row);
    }
    await tx
      .update(notificationJobs)
      .set({
        status: "cancelled",
        errorCode: code,
        errorMessage: message,
        updatedAt: new Date(),
      })
      .where(eq(notificationJobs.id, jobId));
    return {
      jobId,
      status: "cancelled",
      attempts: row.attempts,
      errorCode: code,
      errorMessage: message,
    };
  });
}

export function toOutcome(
  jobId: string,
  row: NotificationJobRow,
): NotificationOutcome {
  const status: NotificationOutcome["status"] =
    row.status === "sent"
      ? "sent"
      : row.status === "failed"
        ? "failed"
        : row.status === "cancelled"
          ? "cancelled"
          : "skipped";
  return {
    jobId,
    status,
    attempts: row.attempts,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  };
}

export async function claimNextNotificationJob(): Promise<{
  jobId: string;
} | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: notificationJobs.id })
      .from(notificationJobs)
      .where(
        and(
          eq(notificationJobs.status, "queued"),
          or(
            isNull(notificationJobs.nextAttemptAt),
            lte(notificationJobs.nextAttemptAt, new Date()),
          ),
        ),
      )
      .orderBy(asc(notificationJobs.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    const row = rows[0];
    if (!row) {
      return null;
    }
    await tx
      .update(notificationJobs)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(notificationJobs.id, row.id));
    return { jobId: row.id };
  });
}

export async function reclaimStaleNotificationJobs(
  now = new Date(),
): Promise<string[]> {
  const threshold = new Date(now.getTime() - NOTIFICATION_STALE_THRESHOLD_MS);
  const stale = await db
    .select({ id: notificationJobs.id })
    .from(notificationJobs)
    .where(
      and(
        eq(notificationJobs.status, "running"),
        lt(notificationJobs.updatedAt, threshold),
      ),
    );
  const reclaimed: string[] = [];
  for (const job of stale) {
    const updated = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(notificationJobs)
        .where(eq(notificationJobs.id, job.id))
        .for("update");
      const row = rows[0];
      if (
        !row ||
        row.status !== "running" ||
        row.updatedAt.getTime() >= threshold.getTime()
      ) {
        return false;
      }
      if (row.attempts < NOTIFICATION_MAX_ATTEMPTS) {
        await tx
          .update(notificationJobs)
          .set({
            status: "queued",
            attempts: row.attempts + 1,
            errorCode: NOTIFICATION_ERROR_CODES.STALE_JOB,
            errorMessage: "job stalled and was reclaimed",
            updatedAt: now,
          })
          .where(eq(notificationJobs.id, row.id));
      } else {
        await tx
          .update(notificationJobs)
          .set({
            status: "failed",
            errorCode: NOTIFICATION_ERROR_CODES.STALE_JOB,
            errorMessage:
              "job stalled past the stale threshold with no attempts left",
            updatedAt: now,
          })
          .where(eq(notificationJobs.id, row.id));
      }
      return true;
    });
    if (updated) {
      reclaimed.push(job.id);
    }
  }
  return reclaimed;
}

export async function processNotificationJob(
  jobId: string,
  driverOverride?: EmailDriver,
): Promise<NotificationOutcome> {
  const attemptStartedAt = Date.now();
  const finish = (outcome: NotificationOutcome): NotificationOutcome => {
    logAttempt(jobId, outcome.attempts, attemptStartedAt, outcome);
    return outcome;
  };

  const current = await db.query.notificationJobs.findFirst({
    where: eq(notificationJobs.id, jobId),
  });
  if (!current) {
    throw new NotificationError(404, NOTIFICATION_JOB_NOT_FOUND);
  }
  if (current.status !== "queued" && current.status !== "running") {
    return toOutcome(jobId, current);
  }

  const claimed = await markRunning(jobId);
  if (claimed === null) {
    const raced = await db.query.notificationJobs.findFirst({
      where: eq(notificationJobs.id, jobId),
    });
    if (!raced) {
      throw new NotificationError(404, NOTIFICATION_JOB_NOT_FOUND);
    }
    return toOutcome(jobId, raced);
  }
  const attempts = claimed.attempts;

  const [job] = await db
    .select()
    .from(notificationJobs)
    .where(eq(notificationJobs.id, jobId))
    .limit(1);
  if (job.status === "cancelled") {
    return finish(
      await finalizeSkipped(jobId, "CANCELLED", "job was cancelled"),
    );
  }

  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.id, job.eventId))
    .limit(1);
  if (!event) {
    return finish(
      await finalizeTerminalFailure(
        jobId,
        "EVENT_MISSING",
        "event no longer exists",
      ),
    );
  }

  const [settlement] = await db
    .select()
    .from(eventSettlements)
    .where(eq(eventSettlements.id, job.settlementId))
    .limit(1);
  if (!settlement) {
    return finish(
      await finalizeTerminalFailure(
        jobId,
        "SETTLEMENT_MISSING",
        "settlement no longer exists",
      ),
    );
  }
  if (settlement.supersededAt !== null) {
    return finish(
      await finalizeSkipped(
        jobId,
        NOTIFICATION_ERROR_CODES.SETTLEMENT_SUPERSEDED,
        "settlement was superseded by a newer close",
      ),
    );
  }

  const memberRows = await db
    .select()
    .from(eventMembers)
    .where(eq(eventMembers.eventId, event.id));

  const recipient = memberRows.find((row) => row.id === job.recipientMemberId);
  if (!recipient || recipient.status === "removed") {
    return finish(
      await finalizeSkipped(
        jobId,
        NOTIFICATION_ERROR_CODES.RECIPIENT_REMOVED,
        "recipient is no longer an event member",
      ),
    );
  }

  let snapshot: SettlementSnapshotJson;
  let transfers: Transfer[];
  try {
    snapshot = readSettlementSnapshot(settlement.balancesJson);
    transfers = readTransfers(settlement.transfersJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish(
      await finalizeTerminalFailure(
        jobId,
        "SETTLEMENT_MISSING",
        `settlement snapshot is unreadable: ${message}`,
      ),
    );
  }

  const labelByMemberId = new Map(
    memberRows.map((row) => [
      row.id,
      row.displayName?.trim() || row.emailNormalized,
    ]),
  );

  const rendered = closeTallyEmail({
    eventName: event.name,
    version: settlement.version,
    currency: event.currency,
    closedAt: settlement.closedAt?.toISOString() ?? new Date().toISOString(),
    totalSpentMinor: snapshot.totalSpentMinor,
    members: snapshot.members.map((entry) => ({
      memberId: entry.memberId,
      label: labelByMemberId.get(entry.memberId) ?? "Removed member",
      paidMinor: entry.paidMinor,
      shareMinor: entry.shareMinor,
      netMinor: entry.netMinor,
    })),
    transfers,
    recipientMemberId: job.recipientMemberId,
    link: recipientLink(recipient.status, event.id, job.recipientEmail),
  });

  const driver = driverOverride ?? resolveEmailDriver();
  try {
    await driver.send({
      to: job.recipientEmail,
      subject: closeTallySubject(event.name, settlement.version),
      html: rendered.html,
      text: rendered.text,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish(
      await finalizeRetryOrFailure(
        jobId,
        attempts,
        NOTIFICATION_ERROR_CODES.EMAIL_SEND_FAILED,
        message,
      ),
    );
  }

  const outcome = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(notificationJobs)
      .where(eq(notificationJobs.id, jobId))
      .for("update");
    const row = rows[0];
    if (!row) {
      throw new NotificationError(404, NOTIFICATION_JOB_NOT_FOUND);
    }
    if (row.status !== "running") {
      return toOutcome(jobId, row);
    }
    await tx
      .update(notificationJobs)
      .set({
        status: "sent",
        attempts,
        sentAt: new Date(),
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(notificationJobs.id, jobId));
    return {
      jobId,
      status: "sent" as const,
      attempts,
      errorCode: null,
      errorMessage: null,
    };
  });
  return finish(outcome);
}

export async function listSettlementNotifications(
  eventId: string,
  settlementId: string,
): Promise<{ settlementId: string; notifications: NotificationJobView[] }> {
  if (!UUID_PATTERN.test(eventId)) {
    throw new AuthorizationError(404, "NOT_FOUND", "event not found");
  }
  if (!UUID_PATTERN.test(settlementId)) {
    throw new NotificationError(404, "SETTLEMENT_NOT_FOUND");
  }
  await requireOrganizer(eventId);

  const [settlement] = await db
    .select({ id: eventSettlements.id })
    .from(eventSettlements)
    .where(
      and(
        eq(eventSettlements.id, settlementId),
        eq(eventSettlements.eventId, eventId),
      ),
    )
    .limit(1);
  if (!settlement) {
    throw new NotificationError(404, "SETTLEMENT_NOT_FOUND");
  }

  const rows = await db
    .select({ job: notificationJobs, member: eventMembers })
    .from(notificationJobs)
    .leftJoin(
      eventMembers,
      eq(eventMembers.id, notificationJobs.recipientMemberId),
    )
    .where(eq(notificationJobs.settlementId, settlementId))
    .orderBy(asc(notificationJobs.createdAt));

  return {
    settlementId,
    notifications: rows.map(({ job, member }) => ({
      id: job.id,
      settlementId: job.settlementId,
      eventId: job.eventId,
      recipientMemberId: job.recipientMemberId,
      recipientEmail: job.recipientEmail,
      displayName: member?.displayName ?? null,
      status: job.status as NotificationJobStatus,
      attempts: job.attempts,
      nextAttemptAt: job.nextAttemptAt?.toISOString() ?? null,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      sentAt: job.sentAt?.toISOString() ?? null,
    })),
  };
}

export async function resendNotification(
  eventId: string,
  settlementId: string,
  jobId: string,
): Promise<NotificationJobView> {
  if (!UUID_PATTERN.test(eventId)) {
    throw new AuthorizationError(404, "NOT_FOUND", "event not found");
  }
  if (!UUID_PATTERN.test(settlementId)) {
    throw new NotificationError(404, "SETTLEMENT_NOT_FOUND");
  }
  if (!UUID_PATTERN.test(jobId)) {
    throw new NotificationError(404, NOTIFICATION_JOB_NOT_FOUND);
  }
  await requireOrganizer(eventId);

  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(notificationJobs)
      .where(eq(notificationJobs.id, jobId))
      .for("update");
    const job = rows[0];
    if (!job || job.eventId !== eventId || job.settlementId !== settlementId) {
      throw new NotificationError(404, NOTIFICATION_JOB_NOT_FOUND);
    }
    if (job.status !== "failed") {
      throw new NotificationError(
        409,
        "NOT_RESENDABLE",
        "only failed tally emails can be resent",
      );
    }
    await tx
      .update(notificationJobs)
      .set({
        status: "queued",
        attempts: 0,
        nextAttemptAt: null,
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(notificationJobs.id, jobId));
    return job;
  });

  const [member] = await db
    .select({ displayName: eventMembers.displayName })
    .from(eventMembers)
    .where(eq(eventMembers.id, updated.recipientMemberId))
    .limit(1);

  return {
    id: updated.id,
    settlementId: updated.settlementId,
    eventId: updated.eventId,
    recipientMemberId: updated.recipientMemberId,
    recipientEmail: updated.recipientEmail,
    displayName: member?.displayName ?? null,
    status: "queued",
    attempts: 0,
    nextAttemptAt: null,
    errorCode: null,
    errorMessage: null,
    sentAt: null,
  };
}
