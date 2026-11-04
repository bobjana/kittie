import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/db/client";
import { eventMembers, events } from "@/db/schema";
import {
  type Actor,
  PERMISSION_CODES,
  PERMISSION_HTTP_STATUS,
  type PermissionResult,
} from "@/domain/permissions";
import { auth } from "@/lib/auth";

export type Session = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>;
export type SessionUser = Session["user"];

export interface EventMemberContext {
  event: typeof events.$inferSelect;
  member: typeof eventMembers.$inferSelect;
  actor: Actor;
}

/** A guard denial carrying an HTTP status and machine-readable code. */
export class AuthorizationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = "AuthorizationError";
    this.status = status;
    this.code = code;
  }
}

export async function getSession(): Promise<Session | null> {
  return auth.api.getSession({ headers: await headers() });
}

/** Requires an authenticated session; 401 UNAUTHENTICATED otherwise. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) {
    throw new AuthorizationError(401, "UNAUTHENTICATED", "sign in is required");
  }
  return session;
}

/**
 * Requires an active membership for the event. Non-membership is
 * indistinguishable from a missing event: always 404, never 403.
 */
export async function requireEventMember(
  eventId: string,
): Promise<EventMemberContext> {
  const session = await requireSession();

  const event = await db.query.events.findFirst({
    where: eq(events.id, eventId),
  });
  if (!event) {
    throw new AuthorizationError(404, "NOT_FOUND", "event not found");
  }

  const member = await db.query.eventMembers.findFirst({
    where: and(
      eq(eventMembers.eventId, eventId),
      eq(eventMembers.userId, session.user.id),
      eq(eventMembers.status, "active"),
    ),
  });
  if (!member) {
    throw new AuthorizationError(404, "NOT_FOUND", "event not found");
  }

  return { event, member, actor: toActor(member) };
}

/** Requires an active organizer membership; 403 NOT_ORGANIZER otherwise. */
export async function requireOrganizer(
  eventId: string,
): Promise<EventMemberContext> {
  const context = await requireEventMember(eventId);
  if (context.actor.kind !== "organizer") {
    throw new AuthorizationError(
      PERMISSION_HTTP_STATUS[PERMISSION_CODES.NOT_ORGANIZER],
      PERMISSION_CODES.NOT_ORGANIZER,
      "only the organizer may perform this action",
    );
  }
  return context;
}

export function toActor(member: typeof eventMembers.$inferSelect): Actor {
  return member.role === "organizer"
    ? { memberId: member.id, kind: "organizer" }
    : { memberId: member.id, kind: "active-member" };
}

/**
 * Turns a domain permission verdict into an AuthorizationError; the rule
 * lives only in src/domain/permissions.
 */
export function assertPermission(result: PermissionResult): void {
  if (!result.ok) {
    throw new AuthorizationError(
      PERMISSION_HTTP_STATUS[result.code],
      result.code,
      result.message,
    );
  }
}
