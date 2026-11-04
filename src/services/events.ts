import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import {
  eventMembers,
  events,
  expenseParticipants,
  expenses,
} from "@/db/schema";
import { computeBalances, type SettlementExpense } from "@/domain/settlement";
import { computeShares, type SplitMode } from "@/domain/split";
import { requireEventMember, requireSession } from "@/lib/authorization";
import { writeAudit } from "@/services/audit";

export const EVENT_VALIDATION_CODES = {
  NAME_REQUIRED: "NAME_REQUIRED",
  NAME_TOO_LONG: "NAME_TOO_LONG",
  INVALID_CURRENCY: "INVALID_CURRENCY",
  INVALID_DATE: "INVALID_DATE",
  ENDS_BEFORE_STARTS: "ENDS_BEFORE_STARTS",
} as const;

export type EventValidationCode =
  (typeof EVENT_VALIDATION_CODES)[keyof typeof EVENT_VALIDATION_CODES];

export class EventValidationError extends Error {
  readonly code: EventValidationCode;

  constructor(code: EventValidationCode, message: string) {
    super(message);
    this.name = "EventValidationError";
    this.code = code;
  }
}

export interface EventSummary {
  id: string;
  name: string;
  currency: string;
  status: "open" | "closed";
  startsOn: string | null;
  endsOn: string | null;
  role: "organizer" | "member";
}

export interface EventMemberSummary {
  id: string;
  displayName: string | null;
  emailNormalized: string;
  role: "organizer" | "member";
}

export interface ExpenseSummary {
  id: string;
  description: string | null;
  totalMinor: number;
  spentOn: string;
  currency: string;
  paidByMemberId: string | null;
}

export interface EventDetail {
  event: EventSummary;
  member: EventMemberSummary;
  members: EventMemberSummary[];
  totalMinor: number;
  /** Signed from the viewer's perspective: positive = they owe, negative = they are owed. */
  yourBalanceMinor: number;
  expenses: ExpenseSummary[];
}

interface ValidatedEventInput {
  name: string;
  currency: string;
  startsOn: string | null;
  endsOn: string | null;
}

const ISO4217_CURRENCIES: ReadonlySet<string> = new Set(
  Intl.supportedValuesOf("currency"),
);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function createEvent(
  input: unknown,
): Promise<{ event: EventSummary; memberId: string }> {
  const session = await requireSession();
  const validated = validateCreateEventInput(input);
  const emailNormalized = normalizeEmail(session.user.email);

  const result = await db.transaction(async (tx) => {
    const [event] = await tx
      .insert(events)
      .values({
        name: validated.name,
        currency: validated.currency,
        startsOn: validated.startsOn,
        endsOn: validated.endsOn,
        organizerUserId: session.user.id,
        status: "open",
      })
      .returning();

    const [member] = await tx
      .insert(eventMembers)
      .values({
        eventId: event.id,
        userId: session.user.id,
        emailNormalized,
        displayName: session.user.name ?? null,
        role: "organizer",
        status: "active",
        joinedAt: new Date(),
      })
      .returning();

    await writeAudit(
      {
        eventId: event.id,
        actorUserId: session.user.id,
        entityType: "event",
        entityId: event.id,
        action: "event.create",
        before: null,
        after: {
          name: event.name,
          currency: event.currency,
          startsOn: event.startsOn,
          endsOn: event.endsOn,
          organizerUserId: event.organizerUserId,
        },
      },
      tx,
    );

    return { event, member };
  });

  return {
    event: toEventSummary(
      result.event,
      result.member.role === "organizer" ? "organizer" : "member",
    ),
    memberId: result.member.id,
  };
}

export async function listEventsForUser(): Promise<EventSummary[]> {
  const session = await requireSession();
  const rows = await db
    .select({ event: events, member: eventMembers })
    .from(eventMembers)
    .innerJoin(events, eq(events.id, eventMembers.eventId))
    .where(
      and(
        eq(eventMembers.userId, session.user.id),
        eq(eventMembers.status, "active"),
        inArray(events.status, ["open", "closed"]),
      ),
    )
    .orderBy(desc(events.createdAt));

  return rows.map(({ event, member }) =>
    toEventSummary(event, member.role === "organizer" ? "organizer" : "member"),
  );
}

export async function getEventForMember(eventId: string): Promise<EventDetail> {
  const { event, member } = await requireEventMember(eventId);

  const members = await db.query.eventMembers.findMany({
    where: and(
      eq(eventMembers.eventId, eventId),
      eq(eventMembers.status, "active"),
    ),
    orderBy: [asc(eventMembers.createdAt)],
  });

  const expenseRows = await db.query.expenses.findMany({
    where: and(eq(expenses.eventId, eventId), eq(expenses.status, "open")),
    orderBy: [desc(expenses.createdAt)],
  });

  const settlementExpenses: SettlementExpense[] = [];
  for (const expense of expenseRows) {
    const participants = await db.query.expenseParticipants.findMany({
      where: eq(expenseParticipants.expenseId, expense.id),
    });
    const { shares } = computeShares({
      totalMinor: expense.totalMinor,
      mode: expense.splitMode as SplitMode,
      participants: participants.map((participant) => ({
        memberId: participant.memberId,
        personalMinor: participant.personalMinor,
        splitBp: participant.splitBp ?? undefined,
      })),
    });
    if (expense.paidByMemberId !== null) {
      settlementExpenses.push({
        paidByMemberId: expense.paidByMemberId,
        totalMinor: expense.totalMinor,
        shares: shares.map((share) => ({
          memberId: share.memberId,
          shareMinor: share.shareMinor,
        })),
        voided: false,
      });
    }
  }

  const { totalSpentMinor, balances } = computeBalances(settlementExpenses);

  return {
    event: toEventSummary(
      event,
      member.role === "organizer" ? "organizer" : "member",
    ),
    member: toMemberSummary(member),
    members: members.map(toMemberSummary),
    totalMinor: totalSpentMinor,
    yourBalanceMinor: balances.get(member.id) ?? 0,
    expenses: expenseRows.map(toExpenseSummary),
  };
}

function validateCreateEventInput(input: unknown): ValidatedEventInput {
  const body =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length === 0) {
    throw new EventValidationError(
      EVENT_VALIDATION_CODES.NAME_REQUIRED,
      "event name is required",
    );
  }
  if (name.length > 80) {
    throw new EventValidationError(
      EVENT_VALIDATION_CODES.NAME_TOO_LONG,
      "event name must be 80 characters or fewer",
    );
  }

  const currency = validateCurrency(body.currency);
  const startsOn = validateOptionalDate(body.startsOn);
  const endsOn = validateOptionalDate(body.endsOn);

  if (startsOn !== null && endsOn !== null && endsOn < startsOn) {
    throw new EventValidationError(
      EVENT_VALIDATION_CODES.ENDS_BEFORE_STARTS,
      "end date cannot be before start date",
    );
  }

  return { name, currency, startsOn, endsOn };
}

function validateCurrency(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "EUR";
  }
  if (typeof value !== "string") {
    throw new EventValidationError(
      EVENT_VALIDATION_CODES.INVALID_CURRENCY,
      "currency must be an ISO-4217 code",
    );
  }
  const normalized = value.trim().toUpperCase();
  if (!ISO4217_CURRENCIES.has(normalized)) {
    throw new EventValidationError(
      EVENT_VALIDATION_CODES.INVALID_CURRENCY,
      "currency must be an ISO-4217 code",
    );
  }
  return normalized;
}

function validateOptionalDate(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || !isValidDateString(value)) {
    throw new EventValidationError(
      EVENT_VALIDATION_CODES.INVALID_DATE,
      "dates must be valid YYYY-MM-DD values",
    );
  }
  return value;
}

function isValidDateString(value: string): boolean {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toEventSummary(
  event: typeof events.$inferSelect,
  role: "organizer" | "member",
): EventSummary {
  return {
    id: event.id,
    name: event.name,
    currency: event.currency,
    status: event.status === "closed" ? "closed" : "open",
    startsOn: event.startsOn,
    endsOn: event.endsOn,
    role,
  };
}

function toMemberSummary(
  member: typeof eventMembers.$inferSelect,
): EventMemberSummary {
  const displayName = member.displayName?.trim() || null;
  return {
    id: member.id,
    displayName,
    emailNormalized: member.emailNormalized,
    role: member.role === "organizer" ? "organizer" : "member",
  };
}

function toExpenseSummary(
  expense: typeof expenses.$inferSelect,
): ExpenseSummary {
  return {
    id: expense.id,
    description: expense.description,
    totalMinor: expense.totalMinor,
    spentOn: expense.spentOn,
    currency: expense.currency,
    paidByMemberId: expense.paidByMemberId,
  };
}
