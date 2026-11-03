/**
 * Permission predicates for the group-expense domain (plan row 6).
 *
 * Pure and side-effect free: no DB, no React, no network. Each predicate
 * answers one question ("may this actor do this to this expense?") and every
 * denial carries a machine-readable code plus an HTTP status equivalent in
 * PERMISSION_HTTP_STATUS, so route handlers can map a denial 1:1 to a status.
 *
 * Subject states: "open" and "closed" come from the event; "voided" comes
 * from the expense and dominates: a voided expense is read-only for everyone
 * and any expense-scoped write is refused. Event-scoped actions (invite,
 * remove member, close, reopen) are checked by their callers against the
 * event state, so those callers pass "open"/"closed".
 */
import type { EventState, ExpenseState } from "./lifecycle";

export type SubjectState = EventState | ExpenseState;

export const PERMISSION_CODES = {
  NOT_A_MEMBER: "NOT_A_MEMBER",
  PENDING_MEMBER: "PENDING_MEMBER",
  MEMBER_REMOVED: "MEMBER_REMOVED",
  NOT_ORGANIZER: "NOT_ORGANIZER",
  NOT_CAPTURER: "NOT_CAPTURER",
  NOT_OWN_PERSONAL: "NOT_OWN_PERSONAL",
  NOT_A_PARTICIPANT: "NOT_A_PARTICIPANT",
  PERSONAL_OUT_OF_BOUNDS: "PERSONAL_OUT_OF_BOUNDS",
  PARTICIPANT_HAS_PERSONAL: "PARTICIPANT_HAS_PERSONAL",
  EVENT_CLOSED: "EVENT_CLOSED",
  EXPENSE_VOIDED: "EXPENSE_VOIDED",
  EVENT_NOT_CLOSED: "EVENT_NOT_CLOSED",
  ORGANIZER_NOT_REMOVABLE: "ORGANIZER_NOT_REMOVABLE",
  ALREADY_REMOVED: "ALREADY_REMOVED",
} as const;

export type PermissionErrorCode =
  (typeof PERMISSION_CODES)[keyof typeof PERMISSION_CODES];

export const PERMISSION_HTTP_STATUS: Record<PermissionErrorCode, number> = {
  [PERMISSION_CODES.NOT_A_MEMBER]: 404,
  [PERMISSION_CODES.PENDING_MEMBER]: 403,
  [PERMISSION_CODES.MEMBER_REMOVED]: 403,
  [PERMISSION_CODES.NOT_ORGANIZER]: 403,
  [PERMISSION_CODES.NOT_CAPTURER]: 403,
  [PERMISSION_CODES.NOT_OWN_PERSONAL]: 403,
  [PERMISSION_CODES.NOT_A_PARTICIPANT]: 409,
  [PERMISSION_CODES.PERSONAL_OUT_OF_BOUNDS]: 422,
  [PERMISSION_CODES.PARTICIPANT_HAS_PERSONAL]: 409,
  [PERMISSION_CODES.EVENT_CLOSED]: 409,
  [PERMISSION_CODES.EXPENSE_VOIDED]: 409,
  [PERMISSION_CODES.EVENT_NOT_CLOSED]: 409,
  [PERMISSION_CODES.ORGANIZER_NOT_REMOVABLE]: 403,
  [PERMISSION_CODES.ALREADY_REMOVED]: 409,
};

export type ActorKind =
  | "organizer"
  | "active-member"
  | "pending-member"
  | "removed-member"
  | "non-member";

export interface Actor {
  memberId: string;
  kind: ActorKind;
}

export interface ExpenseSubject {
  state: SubjectState;
  capturerMemberId: string;
}

export const EXPENSE_FIELDS = [
  "totalMinor",
  "spentOn",
  "description",
  "paidByMemberId",
  "splitMode",
  "participants",
] as const;

export type ExpenseField = (typeof EXPENSE_FIELDS)[number];

export interface PersonalBoundParticipant {
  memberId: string;
  personalMinor: number;
}

export interface PersonalEditContext {
  totalMinor: number;
  participants: PersonalBoundParticipant[];
}

export interface MemberTarget {
  role: "organizer" | "member";
  status: "active" | "pending" | "removed";
}

export type PermissionResult =
  | { ok: true }
  | { ok: false; code: PermissionErrorCode; message: string };

export function canRead(
  actor: Actor,
  _subject: ExpenseSubject,
): PermissionResult {
  return memberGate(actor) ?? allow();
}

export function canEditField(
  actor: Actor,
  subject: ExpenseSubject,
  field: ExpenseField,
): PermissionResult {
  return (
    memberGate(actor) ??
    stateOpenGate(subject) ??
    capturerGate(actor, subject, field) ??
    allow()
  );
}

export function canEditPersonal(
  actor: Actor,
  subject: ExpenseSubject,
  targetMemberId: string,
  proposedPersonalMinor: number,
  context: PersonalEditContext,
): PermissionResult {
  return (
    memberGate(actor) ??
    stateOpenGate(subject) ??
    ownPersonalGate(actor, targetMemberId) ??
    participantGate(targetMemberId, context) ??
    personalBoundGate(targetMemberId, proposedPersonalMinor, context) ??
    allow()
  );
}

export function canRemoveParticipant(
  actor: Actor,
  subject: ExpenseSubject,
  targetMemberId: string,
  targetPersonalMinor: number | undefined,
): PermissionResult {
  return (
    memberGate(actor) ??
    stateOpenGate(subject) ??
    capturerGate(actor, subject, "participants") ??
    participantPresenceGate(targetMemberId, targetPersonalMinor) ??
    allow()
  );
}

export function canInviteMember(
  actor: Actor,
  subject: ExpenseSubject,
): PermissionResult {
  return (
    memberGate(actor) ??
    stateOpenGate(subject) ??
    organizerGate(actor) ??
    allow()
  );
}

export function canRemoveEventMember(
  actor: Actor,
  subject: ExpenseSubject,
  target: MemberTarget | undefined,
): PermissionResult {
  return (
    memberGate(actor) ??
    stateOpenGate(subject) ??
    organizerGate(actor) ??
    removableGate(target) ??
    allow()
  );
}

export function canCloseEvent(
  actor: Actor,
  subject: ExpenseSubject,
): PermissionResult {
  return (
    memberGate(actor) ??
    stateOpenGate(subject) ??
    organizerGate(actor) ??
    allow()
  );
}

export function canReopenEvent(
  actor: Actor,
  subject: ExpenseSubject,
): PermissionResult {
  return (
    memberGate(actor) ??
    stateClosedGate(subject) ??
    organizerGate(actor) ??
    allow()
  );
}

export function canVoidExpense(
  actor: Actor,
  subject: ExpenseSubject,
): PermissionResult {
  return (
    memberGate(actor) ??
    stateOpenGate(subject) ??
    organizerGate(actor) ??
    allow()
  );
}

export function isPersonalWithinBound(
  totalMinor: number,
  participants: PersonalBoundParticipant[],
  memberId: string,
  proposedPersonalMinor: number,
): boolean {
  const othersSum = participants.reduce(
    (sum, participant) =>
      participant.memberId === memberId ? sum : sum + participant.personalMinor,
    0,
  );
  return (
    proposedPersonalMinor >= 0 &&
    proposedPersonalMinor <= totalMinor - othersSum
  );
}

function memberGate(actor: Actor): PermissionResult | null {
  if (actor.kind === "non-member") {
    return denial(PERMISSION_CODES.NOT_A_MEMBER, "not a member of this event");
  }
  if (actor.kind === "pending-member") {
    return denial(
      PERMISSION_CODES.PENDING_MEMBER,
      "membership has not been accepted yet",
    );
  }
  if (actor.kind === "removed-member") {
    return denial(
      PERMISSION_CODES.MEMBER_REMOVED,
      "membership has been removed",
    );
  }
  return null;
}

function stateOpenGate(subject: ExpenseSubject): PermissionResult | null {
  if (subject.state === "closed") {
    return denial(
      PERMISSION_CODES.EVENT_CLOSED,
      "the event is closed and read-only",
    );
  }
  if (subject.state === "voided") {
    return denial(
      PERMISSION_CODES.EXPENSE_VOIDED,
      "the expense is voided and read-only",
    );
  }
  return null;
}

function stateClosedGate(subject: ExpenseSubject): PermissionResult | null {
  if (subject.state === "open") {
    return denial(PERMISSION_CODES.EVENT_NOT_CLOSED, "the event is not closed");
  }
  if (subject.state === "voided") {
    return denial(
      PERMISSION_CODES.EXPENSE_VOIDED,
      "the expense is voided and read-only",
    );
  }
  return null;
}

function organizerGate(actor: Actor): PermissionResult | null {
  if (actor.kind === "organizer") {
    return null;
  }
  return denial(
    PERMISSION_CODES.NOT_ORGANIZER,
    "only the organizer may perform this action",
  );
}

function capturerGate(
  actor: Actor,
  subject: ExpenseSubject,
  field: ExpenseField,
): PermissionResult | null {
  if (actor.memberId === subject.capturerMemberId) {
    return null;
  }
  return denial(
    PERMISSION_CODES.NOT_CAPTURER,
    `only the capturer may edit ${field} while the event is open`,
  );
}

function ownPersonalGate(
  actor: Actor,
  targetMemberId: string,
): PermissionResult | null {
  if (actor.memberId === targetMemberId) {
    return null;
  }
  return denial(
    PERMISSION_CODES.NOT_OWN_PERSONAL,
    "members may only edit their own personal amount",
  );
}

function participantGate(
  targetMemberId: string,
  context: PersonalEditContext,
): PermissionResult | null {
  if (
    context.participants.some(
      (participant) => participant.memberId === targetMemberId,
    )
  ) {
    return null;
  }
  return denial(
    PERMISSION_CODES.NOT_A_PARTICIPANT,
    "not a participant of this expense",
  );
}

function personalBoundGate(
  targetMemberId: string,
  proposedPersonalMinor: number,
  context: PersonalEditContext,
): PermissionResult | null {
  if (
    isPersonalWithinBound(
      context.totalMinor,
      context.participants,
      targetMemberId,
      proposedPersonalMinor,
    )
  ) {
    return null;
  }
  return denial(
    PERMISSION_CODES.PERSONAL_OUT_OF_BOUNDS,
    "personal amount must satisfy 0 <= P <= total - other personal amounts",
  );
}

function participantPresenceGate(
  targetMemberId: string,
  targetPersonalMinor: number | undefined,
): PermissionResult | null {
  if (targetPersonalMinor === undefined) {
    return denial(
      PERMISSION_CODES.NOT_A_PARTICIPANT,
      `${targetMemberId} is not a participant of this expense`,
    );
  }
  if (targetPersonalMinor > 0) {
    return denial(
      PERMISSION_CODES.PARTICIPANT_HAS_PERSONAL,
      `${targetMemberId} has a personal amount and cannot be removed`,
    );
  }
  return null;
}

function removableGate(
  target: MemberTarget | undefined,
): PermissionResult | null {
  if (target === undefined) {
    return denial(PERMISSION_CODES.NOT_A_MEMBER, "not a member of this event");
  }
  if (target.role === "organizer") {
    return denial(
      PERMISSION_CODES.ORGANIZER_NOT_REMOVABLE,
      "the organizer cannot be removed",
    );
  }
  if (target.status === "removed") {
    return denial(
      PERMISSION_CODES.ALREADY_REMOVED,
      "membership has already been removed",
    );
  }
  return null;
}

function allow(): PermissionResult {
  return { ok: true };
}

function denial(code: PermissionErrorCode, message: string): PermissionResult {
  return { ok: false, code, message };
}
