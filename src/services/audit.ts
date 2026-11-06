import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLog, eventMembers } from "@/db/schema";
import { AuthorizationError, requireEventMember } from "@/lib/authorization";

export interface AuditEntry {
  eventId: string;
  actorUserId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

type TransactionExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Keys that must never reach the audit trail. Receipt references, invite
 * tokens and credential material belong to their own tables; an audit row is
 * readable by every event member and must not become a second copy of them.
 */
const SENSITIVE_KEY_PATTERN =
  /token|secret|password|passwd|receipt|authorization|cookie|credential/i;

/**
 * Rejects a payload carrying a sensitive key instead of silently dropping it:
 * a leaking call site must fail loudly (and inside the caller's transaction)
 * rather than persist a redacted-but-wrong audit row.
 */
export function assertNoSensitiveAuditData(
  value: unknown,
  path = "audit",
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoSensitiveAuditData(item, `${path}[${index}]`);
    });
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new Error(`refusing to write sensitive audit field ${path}.${key}`);
    }
    assertNoSensitiveAuditData(nested, `${path}.${key}`);
  }
}

/** Writes one audit row; pass a transaction executor to join one in-flight. */
export async function writeAudit(
  entry: AuditEntry,
  executor: TransactionExecutor | typeof db = db,
): Promise<void> {
  // Audit rows are append-only: this module never exposes an update or a
  // delete, and every money-affecting service joins the write to its own
  // transaction so a rolled-back change leaves no audit row behind.
  assertNoSensitiveAuditData(entry.before, "audit.before");
  assertNoSensitiveAuditData(entry.after, "audit.after");

  await executor.insert(auditLog).values({
    eventId: entry.eventId,
    actorUserId: entry.actorUserId,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    beforeJson: entry.before ?? null,
    afterJson: entry.after ?? null,
  });
}

// ---------------------------------------------------------------------------
// Row 21: readable event history.
// ---------------------------------------------------------------------------

export interface HistoryChange {
  label: string;
  before: string | null;
  after: string | null;
}

export interface HistoryEntry {
  id: string;
  action: string;
  title: string;
  actorName: string;
  createdAt: string;
  changes: HistoryChange[];
}

export interface EventHistory {
  event: {
    id: string;
    name: string;
    currency: string;
    status: "open" | "closed";
  };
  viewerMemberId: string;
  entries: HistoryEntry[];
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACTION_TITLES: Record<string, string> = {
  "event.create": "Created the event",
  "event.close": "Closed the event",
  "event.reopen": "Reopened the event",
  "expense.create": "Added an expense",
  "expense.update": "Edited an expense",
  "expense.void": "Voided an expense",
  "expense.personal_update": "Changed a personal amount",
  "invite.create": "Invited a friend",
  "invite.resend": "Resent an invite",
  "invite.revoke": "Revoked an invite",
  "member.accept_invite": "Joined the event",
  "member.remove": "Removed a member",
};

interface HistoryContext {
  currency: string;
  memberName: (memberId: unknown) => string;
}

/**
 * The history for one event, newest action last, readable by every accepted
 * member. A missing event, a non-member and a removed member all receive 404
 * through requireEventMember; rows are filtered by event_id so another
 * event's history can never leak into this list.
 */
export async function getEventHistory(eventId: string): Promise<EventHistory> {
  if (!UUID_PATTERN.test(eventId)) {
    throw new AuthorizationError(404, "NOT_FOUND", "event not found");
  }

  const { event, member } = await requireEventMember(eventId);

  const [rows, members] = await Promise.all([
    db.query.auditLog.findMany({
      where: eq(auditLog.eventId, event.id),
      // Timestamps carry microseconds; the id tie-break keeps the order
      // deterministic when two rows share one transaction timestamp.
      orderBy: [asc(auditLog.createdAt), asc(auditLog.id)],
    }),
    db.query.eventMembers.findMany({
      where: eq(eventMembers.eventId, event.id),
      orderBy: [asc(eventMembers.createdAt)],
    }),
  ]);

  const nameByMemberId = new Map<string, string>();
  const nameByUserId = new Map<string, string>();
  for (const row of members) {
    const name = row.displayName?.trim() || row.emailNormalized;
    nameByMemberId.set(row.id, name);
    // Prefer the current active membership over a removed or pending one.
    if (
      row.userId &&
      (row.status === "active" || !nameByUserId.has(row.userId))
    ) {
      nameByUserId.set(row.userId, name);
    }
  }

  const context: HistoryContext = {
    currency: event.currency,
    memberName: (memberId) =>
      (typeof memberId === "string" && nameByMemberId.get(memberId)) ||
      "a member",
  };

  return {
    event: {
      id: event.id,
      name: event.name,
      currency: event.currency,
      status: event.status === "closed" ? "closed" : "open",
    },
    viewerMemberId: member.id,
    entries: rows.map((row) => ({
      id: row.id,
      action: row.action,
      title: ACTION_TITLES[row.action] ?? row.action.replace(/[._]/g, " "),
      actorName:
        row.actorUserId === null
          ? "Someone"
          : (nameByUserId.get(row.actorUserId) ?? "A former member"),
      createdAt: row.createdAt.toISOString(),
      changes: describeChanges(
        row.action,
        row.entityId,
        asRecord(row.beforeJson),
        asRecord(row.afterJson),
        context,
      ),
    })),
  };
}

function describeChanges(
  action: string,
  entityId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  context: HistoryContext,
): HistoryChange[] {
  const changes: HistoryChange[] = [];

  switch (action) {
    case "expense.create":
    case "expense.update":
      addExpenseChanges(changes, before, after, context);
      break;
    case "expense.personal_update":
      addChange(
        changes,
        `Personal · ${context.memberName(after?.memberId ?? before?.memberId)}`,
        readMinor(before?.personalMinor),
        readMinor(after?.personalMinor),
        context.currency,
      );
      break;
    case "expense.void":
      addChange(
        changes,
        "Status",
        readStatus(before?.status),
        readStatus(after?.status),
      );
      addChange(
        changes,
        "Amount",
        null,
        readMinor(after?.totalMinor),
        context.currency,
      );
      addChange(changes, "Reason", null, readString(after?.voidReason));
      break;
    case "event.create":
      addChange(changes, "Event", null, readString(after?.name));
      addChange(changes, "Currency", null, readString(after?.currency));
      addChange(
        changes,
        "Dates",
        null,
        describeDates(after?.startsOn, after?.endsOn),
      );
      break;
    case "event.close":
      addChange(
        changes,
        "Status",
        readStatus(before?.status),
        readStatus(after?.status),
      );
      addChange(
        changes,
        "Group total",
        readMinor(before?.totalSpentMinor),
        readMinor(after?.totalSpentMinor),
        context.currency,
      );
      break;
    case "event.reopen":
      addChange(
        changes,
        "Status",
        readStatus(before?.status),
        readStatus(after?.status),
      );
      break;
    case "invite.create":
      addChange(
        changes,
        "Invited",
        null,
        readString(after?.emailNormalized) ??
          context.memberName(after?.memberId),
      );
      addChange(changes, "Expires", null, readTimestamp(after?.expiresAt));
      break;
    case "invite.resend":
      addChange(
        changes,
        "Invited",
        null,
        typeof before?.memberId === "string"
          ? context.memberName(before.memberId)
          : null,
      );
      addChange(changes, "Expires", null, readTimestamp(after?.expiresAt));
      break;
    case "invite.revoke":
      addChange(
        changes,
        "Status",
        readStatus(before?.status),
        readStatus(after?.status),
      );
      addChange(changes, "Member", null, context.memberName(entityId));
      break;
    case "member.accept_invite":
      addChange(changes, "Member", null, context.memberName(entityId));
      addChange(
        changes,
        "Status",
        readStatus(before?.status),
        readStatus(after?.status),
      );
      break;
    case "member.remove":
      addChange(changes, "Member", null, context.memberName(entityId));
      addChange(changes, "Role", readStatus(before?.role), null);
      addChange(
        changes,
        "Status",
        readStatus(before?.status),
        readStatus(after?.status),
      );
      break;
    default:
      break;
  }

  return changes;
}

function addExpenseChanges(
  changes: HistoryChange[],
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  context: HistoryContext,
): void {
  addChange(
    changes,
    "Total",
    readMinor(before?.totalMinor),
    readMinor(after?.totalMinor),
    context.currency,
  );
  addChange(
    changes,
    "Date",
    readString(before?.spentOn),
    readString(after?.spentOn),
  );
  addChange(
    changes,
    "Description",
    readString(before?.description),
    readString(after?.description),
  );
  addChange(
    changes,
    "Paid by",
    readMember(context, before?.paidByMemberId),
    readMember(context, after?.paidByMemberId),
  );
  addChange(
    changes,
    "Split",
    readSplitMode(before?.splitMode),
    readSplitMode(after?.splitMode),
  );

  const beforeParticipants = readParticipants(before?.participants);
  const afterParticipants = readParticipants(after?.participants);
  const beforeById = new Map(
    beforeParticipants.map((participant) => [
      participant.memberId,
      participant,
    ]),
  );
  const afterById = new Map(
    afterParticipants.map((participant) => [participant.memberId, participant]),
  );

  for (const participant of afterParticipants) {
    if (!beforeById.has(participant.memberId)) {
      addChange(
        changes,
        "Participant added",
        null,
        context.memberName(participant.memberId),
      );
    }
  }
  for (const participant of beforeParticipants) {
    if (!afterById.has(participant.memberId)) {
      addChange(
        changes,
        "Participant removed",
        context.memberName(participant.memberId),
        null,
      );
    }
  }
  for (const participant of afterParticipants) {
    const previous = beforeById.get(participant.memberId);
    if (!previous) continue;
    const name = context.memberName(participant.memberId);
    if (previous.personalMinor !== participant.personalMinor) {
      addChange(
        changes,
        `Personal · ${name}`,
        previous.personalMinor,
        participant.personalMinor,
        context.currency,
      );
    }
    if (previous.splitBp !== participant.splitBp) {
      addChange(
        changes,
        `Split · ${name}`,
        readPercent(previous.splitBp),
        readPercent(participant.splitBp),
      );
    }
  }
}

interface ParticipantChange {
  memberId: string;
  personalMinor: number | null;
  splitBp: number | null;
}

function readParticipants(value: unknown): ParticipantChange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    if (typeof record?.memberId !== "string") return [];
    return [
      {
        memberId: record.memberId,
        personalMinor: readMinor(record.personalMinor),
        splitBp: readMinor(record.splitBp),
      },
    ];
  });
}

function addChange(
  changes: HistoryChange[],
  label: string,
  before: string | number | null,
  after: string | number | null,
  currency?: string,
): void {
  const beforeValue = displayValue(before, currency);
  const afterValue = displayValue(after, currency);
  if (beforeValue === null && afterValue === null) return;
  if (beforeValue !== null && beforeValue === afterValue) return;
  changes.push({ label, before: beforeValue, after: afterValue });
}

function displayValue(
  value: string | number | null | undefined,
  currency?: string,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return currency ? formatMoney(value, currency) : String(value);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readMinor(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function readMember(context: HistoryContext, value: unknown): string | null {
  return typeof value === "string" ? context.memberName(value) : null;
}

function readStatus(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function readSplitMode(value: unknown): string | null {
  if (value === "equal") return "Equal";
  if (value === "percentage") return "Percentage";
  return readString(value);
}

function readPercent(value: number | null): string | null {
  return value === null
    ? null
    : `${(value / 100).toFixed(value % 100 === 0 ? 0 : 1)}%`;
}

function readTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function describeDates(startsOn: unknown, endsOn: unknown): string | null {
  const start = readString(startsOn);
  const end = readString(endsOn);
  if (start && end) return `${start} to ${end}`;
  return start ?? end;
}

function formatMoney(minorUnits: number, currency: string): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minorUnits / 100);
}
