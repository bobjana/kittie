import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import {
  eventInvites,
  eventMembers,
  expenseParticipants,
  expenses,
} from "@/db/schema";
import { canRemoveEventMember, type MemberTarget } from "@/domain/permissions";
import {
  AuthorizationError,
  assertPermission,
  requireOrganizer,
} from "@/lib/authorization";
import { writeAudit } from "@/services/audit";

export const MEMBER_CODES = {
  MEMBER_HAS_EXPENSES: "MEMBER_HAS_EXPENSES",
  CANNOT_REMOVE_SELF: "CANNOT_REMOVE_SELF",
} as const;

export type MemberCode = (typeof MEMBER_CODES)[keyof typeof MEMBER_CODES];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MemberError extends Error {
  readonly status: number;
  readonly code: MemberCode;

  constructor(status: number, code: MemberCode, message?: string) {
    super(message ?? code);
    this.name = "MemberError";
    this.status = status;
    this.code = code;
  }
}

/** Maps membership removal errors to a Response, or null when unhandled. */
export function memberErrorToResponse(error: unknown): Response | null {
  if (error instanceof AuthorizationError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  if (error instanceof MemberError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }
  return null;
}

/**
 * Organizer-only removal. A pending member may be revoked and an accepted
 * member may be removed only when no non-voided expense references them as
 * payer or participant. The member row is tombstoned (status='removed'), never
 * deleted; pending invite tokens are revoked alongside it.
 */
export async function removeMember(
  eventId: string,
  memberId: string,
): Promise<{ id: string; status: "removed" }> {
  const { event, member: organizer } = await requireOrganizer(eventId);

  if (!UUID_PATTERN.test(memberId)) {
    throw new AuthorizationError(404, "NOT_FOUND", "member not found");
  }

  const target = await db.query.eventMembers.findFirst({
    where: and(
      eq(eventMembers.id, memberId),
      eq(eventMembers.eventId, eventId),
    ),
  });
  if (!target) {
    throw new AuthorizationError(404, "NOT_FOUND", "member not found");
  }
  if (target.id === organizer.id) {
    throw new MemberError(
      409,
      MEMBER_CODES.CANNOT_REMOVE_SELF,
      "the organizer cannot remove themselves",
    );
  }

  assertPermission(
    canRemoveEventMember(
      { memberId: organizer.id, kind: "organizer" },
      {
        state: event.status === "closed" ? "closed" : "open",
        capturerMemberId: organizer.id,
      },
      {
        role: target.role === "organizer" ? "organizer" : "member",
        status: target.status as MemberTarget["status"],
      },
    ),
  );

  if (await hasNonVoidedExpense(eventId, memberId)) {
    throw new MemberError(
      409,
      MEMBER_CODES.MEMBER_HAS_EXPENSES,
      "this member is referenced by an expense and cannot be removed",
    );
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    if (target.status === "pending") {
      await tx
        .update(eventInvites)
        .set({ revokedAt: now })
        .where(
          and(
            eq(eventInvites.memberId, memberId),
            isNull(eventInvites.revokedAt),
            isNull(eventInvites.acceptedAt),
          ),
        );
    }
    await tx
      .update(eventMembers)
      .set({ status: "removed", updatedAt: now })
      .where(eq(eventMembers.id, memberId));

    await writeAudit(
      {
        eventId,
        actorUserId: organizer.userId,
        entityType: "member",
        entityId: memberId,
        action: "member.remove",
        before: { status: target.status, role: target.role },
        after: { status: "removed" },
      },
      tx,
    );
  });

  return { id: memberId, status: "removed" };
}

/** True when an open (non-voided) expense names the member as payer or participant. */
async function hasNonVoidedExpense(
  eventId: string,
  memberId: string,
): Promise<boolean> {
  const asPayer = await db
    .select({ id: expenses.id })
    .from(expenses)
    .where(
      and(
        eq(expenses.eventId, eventId),
        eq(expenses.status, "open"),
        eq(expenses.paidByMemberId, memberId),
      ),
    )
    .limit(1);
  if (asPayer.length > 0) {
    return true;
  }

  const asParticipant = await db
    .select({ id: expenseParticipants.id })
    .from(expenseParticipants)
    .innerJoin(expenses, eq(expenses.id, expenseParticipants.expenseId))
    .where(
      and(
        eq(expenses.eventId, eventId),
        eq(expenses.status, "open"),
        eq(expenseParticipants.memberId, memberId),
      ),
    )
    .limit(1);
  return asParticipant.length > 0;
}
