import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/db/client";
import {
  eventMembers,
  eventSettlements,
  events,
  expenseParticipants,
  expenses,
  notificationJobs,
} from "@/db/schema";
import {
  canCloseEvent,
  canReopenEvent,
  PERMISSION_CODES,
} from "@/domain/permissions";
import {
  computeBalances,
  type SettlementExpense,
  settle,
  type Transfer,
} from "@/domain/settlement";
import { computeShares, type SplitMode } from "@/domain/split";
import {
  AuthorizationError,
  assertPermission,
  requireSession,
  toActor,
} from "@/lib/authorization";
import { writeAudit } from "@/services/audit";
import {
  type ReportMember,
  serializeSettlementSnapshot,
} from "@/services/reports";

export const SETTLEMENT_CODES = {
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  EVENT_CLOSED: PERMISSION_CODES.EVENT_CLOSED,
  EVENT_NOT_CLOSED: PERMISSION_CODES.EVENT_NOT_CLOSED,
  NOT_ORGANIZER: PERMISSION_CODES.NOT_ORGANIZER,
} as const;

export type SettlementErrorCode =
  (typeof SETTLEMENT_CODES)[keyof typeof SETTLEMENT_CODES];

/** A settlement-flow denial that is not a permission verdict (400). */
export class SettlementError extends Error {
  readonly status: number;
  readonly code: SettlementErrorCode;

  constructor(status: number, code: SettlementErrorCode, message?: string) {
    super(message ?? code);
    this.name = "SettlementError";
    this.status = status;
    this.code = code;
  }
}

export interface CloseEventResult {
  settlementId: string;
  version: number;
  status: "closed";
  totalSpentMinor: number;
  totalOwedMinor: number;
  closedAt: string;
}

export interface ReopenEventResult {
  status: "open";
  reopenedAt: string;
}

interface EventStateSubject {
  state: "open" | "closed";
  capturerMemberId: string;
}

/**
 * Row 19: closes an event and freezes the tally into an immutable
 * settlement snapshot.
 *
 * One transaction locks the event row and every non-voided expense and
 * participant row, so no money write can interleave: a concurrent expense
 * edit blocks on the row locks until the close commits, and a close racing
 * an edit sees the committed value, never a torn tally. The snapshot is
 * serialized through the row-18 frozen contract (serializeSettlementSnapshot)
 * and stored in event_settlements; the report reader rejects any other
 * shape with SETTLEMENT_MISSING. Email delivery is never in the critical
 * path: jobs are inserted in the same transaction and retried by the
 * worker, so a delivery failure can never reopen the event.
 */
export async function closeEvent(eventId: string): Promise<CloseEventResult> {
  const session = await requireSession();

  return db.transaction(async (tx) => {
    // Lock the event row first: every other close/update blocks here.
    const [event] = await tx
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .for("update");
    if (!event) {
      throw new AuthorizationError(404, "NOT_FOUND", "event not found");
    }

    const [member] = await tx
      .select()
      .from(eventMembers)
      .where(
        and(
          eq(eventMembers.eventId, eventId),
          eq(eventMembers.userId, session.user.id),
          eq(eventMembers.status, "active"),
        ),
      );
    if (!member) {
      throw new AuthorizationError(404, "NOT_FOUND", "event not found");
    }

    // Organizer-only and open-only; 403 NOT_ORGANIZER, 409 EVENT_CLOSED.
    const subject: EventStateSubject = {
      state: event.status === "closed" ? "closed" : "open",
      capturerMemberId: member.id,
    };
    assertPermission(canCloseEvent(toActor(member), subject));

    // Lock every non-voided expense row: no expense write can interleave.
    const expenseRows = await tx
      .select()
      .from(expenses)
      .where(and(eq(expenses.eventId, eventId), eq(expenses.status, "open")))
      .orderBy(asc(expenses.createdAt))
      .for("update");

    // Lock every participant row of those expenses.
    const expenseIds = expenseRows.map((row) => row.id);
    const participantRows = expenseIds.length
      ? await tx
          .select()
          .from(expenseParticipants)
          .where(inArray(expenseParticipants.expenseId, expenseIds))
          .for("update")
      : [];

    const participantsByExpense = new Map<string, typeof participantRows>();
    for (const row of participantRows) {
      const list = participantsByExpense.get(row.expenseId) ?? [];
      list.push(row);
      participantsByExpense.set(row.expenseId, list);
    }

    const settlementExpenses: SettlementExpense[] = [];
    for (const expense of expenseRows) {
      if (expense.paidByMemberId === null) continue;
      const participants = participantsByExpense.get(expense.id) ?? [];
      const { shares } = computeShares({
        totalMinor: expense.totalMinor,
        mode: expense.splitMode as SplitMode,
        participants: participants.map((row) => ({
          memberId: row.memberId,
          personalMinor: row.personalMinor,
          splitBp: row.splitBp ?? undefined,
        })),
      });
      settlementExpenses.push({
        paidByMemberId: expense.paidByMemberId,
        totalMinor: expense.totalMinor,
        shares,
        voided: false,
      });
    }

    const { totalSpentMinor, totalOwedMinor, balances } =
      computeBalances(settlementExpenses);

    // Member rows define the canonical transfer order and the snapshot
    // member list; removed members are excluded from the tally.
    const memberRows = await tx
      .select()
      .from(eventMembers)
      .where(
        and(
          eq(eventMembers.eventId, eventId),
          ne(eventMembers.status, "removed"),
        ),
      )
      .orderBy(asc(eventMembers.createdAt));

    const canonicalOrder = memberRows.map((row) => row.id);
    const transfers: Transfer[] = settle(balances, canonicalOrder);

    const paidBy = new Map<string, number>();
    for (const expense of settlementExpenses) {
      paidBy.set(
        expense.paidByMemberId,
        (paidBy.get(expense.paidByMemberId) ?? 0) + expense.totalMinor,
      );
    }
    const shareBy = new Map<string, number>();
    for (const expense of settlementExpenses) {
      for (const share of expense.shares) {
        shareBy.set(
          share.memberId,
          (shareBy.get(share.memberId) ?? 0) + share.shareMinor,
        );
      }
    }

    const reportMembers: ReportMember[] = memberRows.map((row) => {
      const paidMinor = paidBy.get(row.id) ?? 0;
      const shareMinor = shareBy.get(row.id) ?? 0;
      return {
        memberId: row.id,
        displayName: row.displayName?.trim() || null,
        emailNormalized: row.emailNormalized,
        role: row.role === "organizer" ? "organizer" : "member",
        paidMinor,
        shareMinor,
        netMinor: paidMinor - shareMinor,
      };
    });

    // Frozen contract: serializeSettlementSnapshot() in balances_json.
    const snapshot = serializeSettlementSnapshot(
      reportMembers,
      transfers,
      totalSpentMinor,
      totalOwedMinor,
    );

    const [latest] = await tx
      .select({ version: eventSettlements.version })
      .from(eventSettlements)
      .where(eq(eventSettlements.eventId, eventId))
      .orderBy(desc(eventSettlements.version))
      .limit(1);
    const version = (latest?.version ?? 0) + 1;

    const closedAt = new Date();

    const [settlement] = await tx
      .insert(eventSettlements)
      .values({
        eventId,
        version,
        totalSpentMinor,
        balancesJson: snapshot,
        transfersJson: transfers,
        closedBy: session.user.id,
        closedAt,
      })
      .returning();

    await tx
      .update(events)
      .set({
        status: "closed",
        closedAt,
        closedBy: session.user.id,
        updatedAt: closedAt,
      })
      .where(eq(events.id, eventId));

    await writeAudit(
      {
        eventId,
        actorUserId: session.user.id,
        entityType: "event",
        entityId: eventId,
        action: "event.close",
        before: { status: "open" },
        after: {
          status: "closed",
          settlementId: settlement.id,
          settlementVersion: version,
          totalSpentMinor,
        },
      },
      tx,
    );

    // close_tally jobs for every active or pending member (removed is
    // already excluded from memberRows). Delivery retries in the worker.
    const recipients = memberRows.filter(
      (row) => row.status === "active" || row.status === "pending",
    );
    if (recipients.length > 0) {
      await tx.insert(notificationJobs).values(
        recipients.map((row) => ({
          type: "close_tally" as const,
          eventId,
          settlementId: settlement.id,
          recipientMemberId: row.id,
          recipientEmail: row.emailNormalized,
          status: "queued" as const,
        })),
      );
    }

    return {
      settlementId: settlement.id,
      version,
      status: "closed" as const,
      totalSpentMinor,
      totalOwedMinor,
      closedAt: closedAt.toISOString(),
    };
  });
}

/**
 * Row 19: reopens a closed event. Marks the active settlement superseded
 * (never deleted), cancels queued notification jobs, restores writes, and
 * records reopened_at. No email is sent until the next close. The caller
 * must pass confirm: true.
 */
export async function reopenEvent(
  eventId: string,
  confirm: unknown,
): Promise<ReopenEventResult> {
  const session = await requireSession();
  if (confirm !== true) {
    throw new SettlementError(
      400,
      SETTLEMENT_CODES.CONFIRMATION_REQUIRED,
      "reopen requires explicit confirmation",
    );
  }

  return db.transaction(async (tx) => {
    const [event] = await tx
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .for("update");
    if (!event) {
      throw new AuthorizationError(404, "NOT_FOUND", "event not found");
    }

    const [member] = await tx
      .select()
      .from(eventMembers)
      .where(
        and(
          eq(eventMembers.eventId, eventId),
          eq(eventMembers.userId, session.user.id),
          eq(eventMembers.status, "active"),
        ),
      );
    if (!member) {
      throw new AuthorizationError(404, "NOT_FOUND", "event not found");
    }

    const subject: EventStateSubject = {
      state: event.status === "closed" ? "closed" : "open",
      capturerMemberId: member.id,
    };
    // Organizer-only and closed-only; 409 EVENT_NOT_CLOSED when open.
    assertPermission(canReopenEvent(toActor(member), subject));

    const reopenedAt = new Date();

    // Supersede the active settlement; history is never deleted.
    await tx
      .update(eventSettlements)
      .set({ supersededAt: reopenedAt })
      .where(
        and(
          eq(eventSettlements.eventId, eventId),
          isNull(eventSettlements.supersededAt),
        ),
      );

    // Cancel every queued close_tally job for this event.
    await tx
      .update(notificationJobs)
      .set({ status: "cancelled", updatedAt: reopenedAt })
      .where(
        and(
          eq(notificationJobs.eventId, eventId),
          eq(notificationJobs.status, "queued"),
        ),
      );

    await tx
      .update(events)
      .set({ status: "open", reopenedAt, updatedAt: reopenedAt })
      .where(eq(events.id, eventId));

    await writeAudit(
      {
        eventId,
        actorUserId: session.user.id,
        entityType: "event",
        entityId: eventId,
        action: "event.reopen",
        before: { status: "closed" },
        after: { status: "open", reopenedAt: reopenedAt.toISOString() },
      },
      tx,
    );

    return {
      status: "open" as const,
      reopenedAt: reopenedAt.toISOString(),
    };
  });
}

/** Maps settlement errors to a Response, or null when unhandled. */
export function settlementErrorToResponse(error: unknown): Response | null {
  if (error instanceof AuthorizationError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  if (error instanceof SettlementError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }
  return null;
}
