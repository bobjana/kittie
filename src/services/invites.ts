import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { eventInvites, eventMembers, events } from "@/db/schema";
import { canInviteMember, PERMISSION_CODES } from "@/domain/permissions";
import {
  isSafeInviteToken,
  isValidEmail,
  normalizeEmail,
} from "@/lib/auth-helpers";
import {
  AuthorizationError,
  assertPermission,
  requireEventMember,
  requireOrganizer,
  requireSession,
} from "@/lib/authorization";
import { emailDriver } from "@/lib/email/service";
import { inviteEmail } from "@/lib/email/templates/invite";
import { env } from "@/lib/env";
import { incrementThrottle } from "@/lib/rate-limit";
import { writeAudit } from "@/services/audit";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITE_DAILY_LIMIT = 20;
export const INVITE_DAILY_WINDOW_SECONDS = 24 * 60 * 60;

export const INVITE_CODES = {
  INVALID_EMAIL: "INVALID_EMAIL",
  ALREADY_MEMBER: "ALREADY_MEMBER",
  INVITE_LIMIT_EXCEEDED: "INVITE_LIMIT_EXCEEDED",
  INVITE_NOT_FOUND: "INVITE_NOT_FOUND",
  INVITE_REVOKED: "INVITE_REVOKED",
  INVITE_EXPIRED: "INVITE_EXPIRED",
  EMAIL_MISMATCH: "EMAIL_MISMATCH",
  MEMBER_NOT_PENDING: "MEMBER_NOT_PENDING",
} as const;

export type InviteCode = (typeof INVITE_CODES)[keyof typeof INVITE_CODES];

export class InviteError extends Error {
  readonly status: number;
  readonly code: InviteCode;

  constructor(status: number, code: InviteCode, message?: string) {
    super(message ?? code);
    this.name = "InviteError";
    this.status = status;
    this.code = code;
  }
}

export interface InviteSummary {
  id: string;
  emailNormalized: string;
  expiresAt: Date;
}

export interface MemberInviteSummary {
  memberId: string;
  emailNormalized: string;
  displayName: string | null;
  invitedAt: Date | null;
  expiresAt: Date | null;
  status: "pending" | "expired";
}

export interface ActiveMemberSummary {
  id: string;
  displayName: string | null;
  emailNormalized: string;
  role: "organizer" | "member";
}

export interface MembersPageData {
  event: { id: string; name: string };
  isOrganizer: boolean;
  activeMembers: ActiveMemberSummary[];
  pendingInvites: MemberInviteSummary[];
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function inviteLink(token: string): string {
  return `${env.APP_URL}/invite/${token}`;
}

/** Maps invite/auth domain errors to a Response, or null when unhandled. */
export function inviteErrorToResponse(error: unknown): Response | null {
  if (error instanceof AuthorizationError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  if (error instanceof InviteError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }
  return null;
}

/** Creates or refreshes a pending member and its invite; organizer only. */
/** A closed event is read-only for every organizer invite write. */
function assertInvitesAllowed(
  event: typeof events.$inferSelect,
  organizerMemberId: string,
): void {
  assertPermission(
    canInviteMember(
      { memberId: organizerMemberId, kind: "organizer" },
      {
        state: event.status === "closed" ? "closed" : "open",
        capturerMemberId: organizerMemberId,
      },
    ),
  );
}

export async function inviteMember(
  eventId: string,
  emailInput: unknown,
): Promise<{
  member: { id: string; emailNormalized: string; status: string };
  invite: InviteSummary;
}> {
  const { event, member: organizer } = await requireOrganizer(eventId);
  assertInvitesAllowed(event, organizer.id);

  const email =
    typeof emailInput === "string" ? normalizeEmail(emailInput) : "";
  if (!isValidEmail(email)) {
    throw new InviteError(
      400,
      INVITE_CODES.INVALID_EMAIL,
      "enter a valid email address",
    );
  }

  const organizerKey = organizer.userId ?? organizer.id;
  const dayKey = new Date().toISOString().slice(0, 10);
  const throttled = await incrementThrottle(
    `invite:${organizerKey}:${dayKey}`,
    INVITE_DAILY_LIMIT,
    INVITE_DAILY_WINDOW_SECONDS,
  );
  if (throttled) {
    throw new InviteError(
      429,
      INVITE_CODES.INVITE_LIMIT_EXCEEDED,
      "you have reached today's invite limit",
    );
  }

  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const now = new Date();

  const { member, invite } = await db.transaction(async (tx) => {
    const existing = await tx.query.eventMembers.findFirst({
      where: and(
        eq(eventMembers.eventId, eventId),
        eq(eventMembers.emailNormalized, email),
        ne(eventMembers.status, "removed"),
      ),
    });

    let member: typeof eventMembers.$inferSelect;
    if (existing) {
      if (existing.status === "active") {
        throw new InviteError(
          409,
          INVITE_CODES.ALREADY_MEMBER,
          "this email is already a member",
        );
      }
      await tx
        .update(eventMembers)
        .set({ invitedBy: organizer.userId, invitedAt: now, updatedAt: now })
        .where(eq(eventMembers.id, existing.id));
      await tx
        .update(eventInvites)
        .set({ revokedAt: now })
        .where(
          and(
            eq(eventInvites.memberId, existing.id),
            isNull(eventInvites.revokedAt),
            isNull(eventInvites.acceptedAt),
          ),
        );
      member = existing;
    } else {
      const [created] = await tx
        .insert(eventMembers)
        .values({
          eventId,
          emailNormalized: email,
          displayName: null,
          role: "member",
          status: "pending",
          invitedBy: organizer.userId,
          invitedAt: now,
        })
        .returning();
      member = created;
    }

    const [invite] = await tx
      .insert(eventInvites)
      .values({
        eventId,
        memberId: member.id,
        tokenHash,
        emailNormalized: email,
        expiresAt,
        createdBy: organizer.userId,
      })
      .returning();

    await writeAudit(
      {
        eventId,
        actorUserId: organizer.userId,
        entityType: "invite",
        entityId: invite.id,
        action: "invite.create",
        before: null,
        after: {
          emailNormalized: email,
          memberId: member.id,
          expiresAt: expiresAt.toISOString(),
        },
      },
      tx,
    );

    return { member, invite };
  });

  const rendered = inviteEmail({
    eventName: event.name,
    organizerName: organizer.displayName,
    link: inviteLink(token),
  });
  await emailDriver().send({
    to: email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });

  return {
    member: {
      id: member.id,
      emailNormalized: member.emailNormalized,
      status: member.status,
    },
    invite: {
      id: invite.id,
      emailNormalized: invite.emailNormalized,
      expiresAt: invite.expiresAt,
    },
  };
}

async function queryPendingInvites(
  eventId: string,
): Promise<MemberInviteSummary[]> {
  const members = await db.query.eventMembers.findMany({
    where: and(
      eq(eventMembers.eventId, eventId),
      eq(eventMembers.status, "pending"),
    ),
    orderBy: [asc(eventMembers.createdAt)],
  });

  const now = new Date();
  const result: MemberInviteSummary[] = [];
  for (const member of members) {
    const invite = await db.query.eventInvites.findFirst({
      where: and(
        eq(eventInvites.memberId, member.id),
        isNull(eventInvites.revokedAt),
        isNull(eventInvites.acceptedAt),
      ),
      orderBy: [desc(eventInvites.createdAt)],
    });
    result.push({
      memberId: member.id,
      emailNormalized: member.emailNormalized,
      displayName: member.displayName,
      invitedAt: member.invitedAt,
      expiresAt: invite?.expiresAt ?? null,
      status:
        invite && invite.expiresAt.getTime() > now.getTime()
          ? "pending"
          : "expired",
    });
  }
  return result;
}

/** Lists pending invites for the organizer. */
export async function listInvites(
  eventId: string,
): Promise<MemberInviteSummary[]> {
  await requireOrganizer(eventId);
  return queryPendingInvites(eventId);
}

/** Active members plus pending invites for the members page. */
export async function getMembersPageData(
  eventId: string,
): Promise<MembersPageData> {
  const { event, actor } = await requireEventMember(eventId);

  const activeMembers = await db.query.eventMembers.findMany({
    where: and(
      eq(eventMembers.eventId, eventId),
      eq(eventMembers.status, "active"),
    ),
    orderBy: [asc(eventMembers.createdAt)],
  });

  const pendingInvites = await queryPendingInvites(eventId);

  return {
    event: { id: event.id, name: event.name },
    isOrganizer: actor.kind === "organizer",
    activeMembers: activeMembers.map((member) => ({
      id: member.id,
      displayName: member.displayName?.trim() || null,
      emailNormalized: member.emailNormalized,
      role: member.role === "organizer" ? "organizer" : "member",
    })),
    pendingInvites,
  };
}

/** Invalidates prior tokens and sends a fresh invite. */
export async function resendInvite(
  eventId: string,
  memberId: string,
): Promise<InviteSummary> {
  const { event, member: organizer } = await requireOrganizer(eventId);
  assertInvitesAllowed(event, organizer.id);

  const member = await db.query.eventMembers.findFirst({
    where: and(
      eq(eventMembers.id, memberId),
      eq(eventMembers.eventId, eventId),
    ),
  });
  if (!member || member.status === "removed") {
    throw new InviteError(
      404,
      INVITE_CODES.INVITE_NOT_FOUND,
      "pending invite not found",
    );
  }
  if (member.status !== "pending") {
    throw new InviteError(
      409,
      INVITE_CODES.MEMBER_NOT_PENDING,
      "this member has already accepted",
    );
  }

  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const now = new Date();

  const [invite] = await db.transaction(async (tx) => {
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
    await tx
      .update(eventMembers)
      .set({ invitedAt: now, updatedAt: now })
      .where(eq(eventMembers.id, memberId));

    const created = await tx
      .insert(eventInvites)
      .values({
        eventId,
        memberId,
        tokenHash,
        emailNormalized: member.emailNormalized,
        expiresAt,
        createdBy: organizer.userId,
      })
      .returning();

    await writeAudit(
      {
        eventId,
        actorUserId: organizer.userId,
        entityType: "invite",
        entityId: created[0].id,
        action: "invite.resend",
        before: { memberId },
        after: { expiresAt: expiresAt.toISOString() },
      },
      tx,
    );

    return created;
  });

  const rendered = inviteEmail({
    eventName: event.name,
    organizerName: organizer.displayName,
    link: inviteLink(token),
  });
  await emailDriver().send({
    to: member.emailNormalized,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });

  return {
    id: invite.id,
    emailNormalized: invite.emailNormalized,
    expiresAt: invite.expiresAt,
  };
}

/** Revokes the invite and tombstones the pending member. */
export async function revokeInvite(
  eventId: string,
  memberId: string,
): Promise<void> {
  const { event, member: organizer } = await requireOrganizer(eventId);
  assertInvitesAllowed(event, organizer.id);

  const member = await db.query.eventMembers.findFirst({
    where: and(
      eq(eventMembers.id, memberId),
      eq(eventMembers.eventId, eventId),
    ),
  });
  if (!member || member.status === "removed") {
    throw new InviteError(
      404,
      INVITE_CODES.INVITE_NOT_FOUND,
      "pending invite not found",
    );
  }
  if (member.status !== "pending") {
    throw new InviteError(
      409,
      INVITE_CODES.MEMBER_NOT_PENDING,
      "this member has already accepted",
    );
  }

  const now = new Date();
  await db.transaction(async (tx) => {
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
        action: "invite.revoke",
        before: { status: "pending" },
        after: { status: "removed" },
      },
      tx,
    );
  });
}

/** Accepts an invite for the session's email; the raw token is never stored. */
export async function acceptInvite(
  tokenInput: unknown,
): Promise<{ eventId: string }> {
  const token = typeof tokenInput === "string" ? tokenInput : "";
  if (!isSafeInviteToken(token)) {
    throw new InviteError(
      404,
      INVITE_CODES.INVITE_NOT_FOUND,
      "invite link is invalid",
    );
  }

  const session = await requireSession();
  const tokenHash = hashToken(token);

  const invite = await db.query.eventInvites.findFirst({
    where: eq(eventInvites.tokenHash, tokenHash),
  });
  if (!invite) {
    throw new InviteError(
      404,
      INVITE_CODES.INVITE_NOT_FOUND,
      "invite link is invalid",
    );
  }
  if (invite.revokedAt) {
    throw new InviteError(
      410,
      INVITE_CODES.INVITE_REVOKED,
      "this invite has been revoked",
    );
  }
  if (invite.expiresAt.getTime() <= Date.now()) {
    throw new InviteError(
      410,
      INVITE_CODES.INVITE_EXPIRED,
      "this invite has expired",
    );
  }
  if (normalizeEmail(session.user.email) !== invite.emailNormalized) {
    throw new InviteError(
      403,
      INVITE_CODES.EMAIL_MISMATCH,
      "this invite was sent to a different email address",
    );
  }

  const member = await db.query.eventMembers.findFirst({
    where: eq(eventMembers.id, invite.memberId),
  });
  if (!member || member.status === "removed") {
    throw new InviteError(
      410,
      INVITE_CODES.INVITE_REVOKED,
      "this invite has been revoked",
    );
  }

  if (invite.acceptedAt) {
    return { eventId: invite.eventId };
  }

  // A closed event is read-only: accepting an invite would change the
  // member set the frozen settlement snapshot was computed from.
  const event = await db.query.events.findFirst({
    where: eq(events.id, invite.eventId),
  });
  if (!event || event.status === "closed") {
    throw new AuthorizationError(
      409,
      PERMISSION_CODES.EVENT_CLOSED,
      "the event is closed and read-only",
    );
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(eventMembers)
      .set({
        userId: session.user.id,
        status: "active",
        joinedAt: member.joinedAt ?? now,
        updatedAt: now,
      })
      .where(eq(eventMembers.id, invite.memberId));
    await tx
      .update(eventInvites)
      .set({ acceptedAt: now })
      .where(eq(eventInvites.id, invite.id));

    await writeAudit(
      {
        eventId: invite.eventId,
        actorUserId: session.user.id,
        entityType: "member",
        entityId: invite.memberId,
        action: "member.accept_invite",
        before: { status: member.status },
        after: { status: "active" },
      },
      tx,
    );
  });

  return { eventId: invite.eventId };
}
