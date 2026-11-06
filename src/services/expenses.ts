import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/db/client";
import {
  auditLog,
  eventMembers,
  events,
  expenseParticipants,
  expenses,
  ocrJobs,
  receipts,
} from "@/db/schema";
import {
  canEditField,
  canEditPersonal,
  canRemoveParticipant,
  canVoidExpense,
  EXPENSE_FIELDS,
  type ExpenseSubject,
  isPersonalWithinBound,
  PERMISSION_CODES,
} from "@/domain/permissions";
import {
  computeShares,
  type MemberShare,
  type SplitMode,
  type SplitResult,
} from "@/domain/split";
import { VALIDATION_CODES, validateExpenseInput } from "@/domain/validation";
import {
  AuthorizationError,
  assertPermission,
  requireEventMember,
} from "@/lib/authorization";
import { writeAudit } from "@/services/audit";
import type { OcrResultJson } from "@/services/ocr";

export const EXPENSE_CODES = {
  INVALID_DATE: "INVALID_DATE",
  DESCRIPTION_TOO_LONG: "DESCRIPTION_TOO_LONG",
  DUPLICATE_PARTICIPANT: "DUPLICATE_PARTICIPANT",
  PARTICIPANT_NOT_MEMBER: "PARTICIPANT_NOT_MEMBER",
  SPLIT_BP_NOT_ALLOWED: "SPLIT_BP_NOT_ALLOWED",
  OWN_PERSONAL_ONLY: "OWN_PERSONAL_ONLY",
  RECEIPT_INVALID: "RECEIPT_INVALID",
  EVENT_CLOSED: "EVENT_CLOSED",
  STALE_EXPENSE: "STALE_EXPENSE",
  INVALID_VERSION: "INVALID_VERSION",
  VOID_REASON_INVALID: "VOID_REASON_INVALID",
} as const;

export type ExpenseCode = (typeof EXPENSE_CODES)[keyof typeof EXPENSE_CODES];

export class ExpenseError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = "ExpenseError";
    this.status = status;
    this.code = code;
  }
}

/** Maps expense errors to a Response, or null when unhandled. */
export function expenseErrorToResponse(error: unknown): Response | null {
  if (error instanceof AuthorizationError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  if (error instanceof ExpenseError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }
  return null;
}

export interface CreateExpenseResult {
  expense: {
    id: string;
    totalMinor: number;
    currency: string;
    spentOn: string;
    splitMode: SplitMode;
    paidByMemberId: string | null;
    description: string | null;
    version: number;
  };
  shares: SplitResult["shares"];
}

export interface NewExpenseMember {
  id: string;
  displayName: string | null;
  emailNormalized: string;
}

export interface NewExpenseData {
  event: {
    id: string;
    name: string;
    currency: string;
    status: "open" | "closed";
  };
  currentMemberId: string;
  members: NewExpenseMember[];
}

interface NormalizedParticipant {
  memberId: string;
  personalMinor: number;
  splitBp?: number;
}

interface NormalizedExpenseInput {
  totalMinor: number;
  spentOn: string;
  description: string | null;
  paidByMemberId: string;
  splitMode: SplitMode;
  participants: NormalizedParticipant[];
  receiptId: string | null;
}

type TransactionExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Creates an expense for an open event. Any active member may do this; shares
 * are computed server-side from the stored totalMinor and split inputs, never
 * accepted from the client, and are never persisted (the schema has no share
 * column). The insert runs in one transaction that locks the event and the
 * referenced member rows so a concurrent member removal cannot interleave.
 */
export async function createExpense(
  eventId: string,
  input: unknown,
): Promise<CreateExpenseResult> {
  const { event, member: creator } = await requireEventMember(eventId);
  const creatorUserId = creator.userId;
  const creatorMemberId = creator.id;

  if (event.status !== "open") {
    throw new ExpenseError(
      409,
      EXPENSE_CODES.EVENT_CLOSED,
      "the event is closed and read-only",
    );
  }

  const memberIds = new Set(
    (
      await db.query.eventMembers.findMany({
        where: and(
          eq(eventMembers.eventId, eventId),
          ne(eventMembers.status, "removed"),
        ),
        orderBy: [asc(eventMembers.createdAt)],
      })
    ).map((member) => member.id),
  );

  const normalized = normalizeExpenseInput(input, creatorMemberId, memberIds);

  const { shares } = computeShares({
    totalMinor: normalized.totalMinor,
    mode: normalized.splitMode,
    participants: normalized.participants,
  });

  const { expense } = await db.transaction(async (tx) => {
    // Lock the event row. This serializes expense creation against any other
    // writer that also locks the event row, and re-reads its status so a
    // close/reopen cannot slip in between the guard above and the insert.
    const [lockedEvent] = await tx
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .for("update");
    if (!lockedEvent || lockedEvent.status !== "open") {
      throw new ExpenseError(
        409,
        EXPENSE_CODES.EVENT_CLOSED,
        "the event is closed and read-only",
      );
    }

    // Lock the referenced member rows FOR UPDATE and re-verify they are still
    // non-removed. A concurrent removal's UPDATE on the same row waits on this
    // lock, so the payer/participant set and their status are consistent at
    // commit time. NOTE: this closes the race when the removal's guard reads
    // the member row before or after this lock, but a removal whose
    // hasNonVoidedExpense() guard runs after we lock and before we commit can
    // still tombstone the member afterwards; fully closing that residual
    // requires row 11's removal to re-check inside its own transaction.
    const lockedMembers = await tx
      .select()
      .from(eventMembers)
      .where(
        and(
          eq(eventMembers.eventId, eventId),
          ne(eventMembers.status, "removed"),
        ),
      )
      .orderBy(asc(eventMembers.createdAt))
      .for("update");
    const lockedMemberIds = new Set(lockedMembers.map((member) => member.id));

    if (!lockedMemberIds.has(normalized.paidByMemberId)) {
      throw new ExpenseError(
        400,
        VALIDATION_CODES.PAYER_NOT_MEMBER,
        "the payer must be an event member",
      );
    }
    for (const participant of normalized.participants) {
      if (!lockedMemberIds.has(participant.memberId)) {
        throw new ExpenseError(
          400,
          EXPENSE_CODES.PARTICIPANT_NOT_MEMBER,
          "participant is not an event member",
        );
      }
    }

    const [expense] = await tx
      .insert(expenses)
      .values({
        eventId,
        createdBy: creatorUserId,
        paidByMemberId: normalized.paidByMemberId,
        totalMinor: normalized.totalMinor,
        currency: lockedEvent.currency,
        spentOn: normalized.spentOn,
        description: normalized.description,
        splitMode: normalized.splitMode,
        status: "open",
      })
      .returning();

    for (const participant of normalized.participants) {
      await tx.insert(expenseParticipants).values({
        expenseId: expense.id,
        memberId: participant.memberId,
        personalMinor: participant.personalMinor,
        splitBp: participant.splitBp ?? null,
      });
    }

    if (normalized.receiptId) {
      await attachReceipt(tx, {
        receiptId: normalized.receiptId,
        eventId,
        creatorUserId,
        expenseId: expense.id,
      });
    }

    await writeAudit(
      {
        eventId,
        actorUserId: creatorUserId,
        entityType: "expense",
        entityId: expense.id,
        action: "expense.create",
        before: null,
        after: {
          totalMinor: normalized.totalMinor,
          currency: expense.currency,
          spentOn: expense.spentOn,
          description: expense.description,
          splitMode: expense.splitMode,
          paidByMemberId: expense.paidByMemberId,
          participants: normalized.participants.map((participant) => ({
            memberId: participant.memberId,
            personalMinor: participant.personalMinor,
            splitBp: participant.splitBp ?? null,
          })),
        },
      },
      tx,
    );

    return { expense };
  });

  return {
    expense: {
      id: expense.id,
      totalMinor: expense.totalMinor,
      currency: expense.currency,
      spentOn: expense.spentOn,
      splitMode: expense.splitMode as SplitMode,
      paidByMemberId: expense.paidByMemberId,
      description: expense.description,
      version: expense.version,
    },
    shares,
  };
}

/** Data for the "new expense" page: event, the viewer's member row, and members. */
export async function getNewExpenseData(
  eventId: string,
): Promise<NewExpenseData> {
  const { event, member } = await requireEventMember(eventId);

  const members = await db.query.eventMembers.findMany({
    where: and(
      eq(eventMembers.eventId, eventId),
      ne(eventMembers.status, "removed"),
    ),
    orderBy: [asc(eventMembers.createdAt)],
  });

  return {
    event: {
      id: event.id,
      name: event.name,
      currency: event.currency,
      status: event.status === "closed" ? "closed" : "open",
    },
    currentMemberId: member.id,
    members: members.map((member) => ({
      id: member.id,
      displayName: member.displayName?.trim() || null,
      emailNormalized: member.emailNormalized,
    })),
  };
}

function normalizeExpenseInput(
  input: unknown,
  creatorMemberId: string,
  memberIds: Set<string>,
): NormalizedExpenseInput {
  const body =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};

  const splitMode = readSplitMode(body.splitMode);

  const spentOn = readSpentOn(body.spentOn);
  const description = readDescription(body.description);
  const paidByMemberId = readPaidByMemberId(
    body.paidByMemberId,
    creatorMemberId,
  );
  const participants = readParticipants(body.participants, memberIds);
  const receiptId =
    typeof body.receiptId === "string" && body.receiptId.length > 0
      ? body.receiptId
      : null;

  const seen = new Set<string>();
  for (const participant of participants) {
    if (seen.has(participant.memberId)) {
      throw new ExpenseError(
        400,
        EXPENSE_CODES.DUPLICATE_PARTICIPANT,
        "each participant may appear only once",
      );
    }
    seen.add(participant.memberId);

    if (!memberIds.has(participant.memberId)) {
      throw new ExpenseError(
        400,
        EXPENSE_CODES.PARTICIPANT_NOT_MEMBER,
        "participant is not an event member",
      );
    }
    if (
      participant.memberId !== creatorMemberId &&
      participant.personalMinor > 0
    ) {
      throw new ExpenseError(
        400,
        EXPENSE_CODES.OWN_PERSONAL_ONLY,
        "you may only set your own personal amount",
      );
    }
  }

  if (splitMode === "equal") {
    for (const participant of participants) {
      if (participant.splitBp !== undefined) {
        throw new ExpenseError(
          400,
          EXPENSE_CODES.SPLIT_BP_NOT_ALLOWED,
          "basis points are not allowed in equal mode",
        );
      }
    }
  }

  const validation = validateExpenseInput({
    totalMinor: body.totalMinor as number,
    mode: splitMode,
    payerMemberId: paidByMemberId,
    memberIds: [...memberIds],
    participants: participants.map((participant) => ({
      memberId: participant.memberId,
      personalMinor: participant.personalMinor,
      splitBp: participant.splitBp,
    })),
  });
  if (!validation.ok) {
    throw new ExpenseError(400, validation.code, validation.message);
  }

  return {
    totalMinor: body.totalMinor as number,
    spentOn,
    description,
    paidByMemberId,
    splitMode,
    participants,
    receiptId,
  };
}

function readSplitMode(value: unknown): SplitMode {
  if (value === undefined || value === null) {
    return "equal";
  }
  if (value === "equal" || value === "percentage") {
    return value;
  }
  throw new ExpenseError(
    400,
    VALIDATION_CODES.INVALID_MODE,
    "split mode must be equal or percentage",
  );
}

function readSpentOn(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return todayIso();
  }
  if (typeof value !== "string" || !isValidDateString(value)) {
    throw new ExpenseError(
      400,
      EXPENSE_CODES.INVALID_DATE,
      "spentOn must be a valid YYYY-MM-DD date",
    );
  }
  return value;
}

function readDescription(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length > 120) {
    throw new ExpenseError(
      400,
      EXPENSE_CODES.DESCRIPTION_TOO_LONG,
      "description must be 120 characters or fewer",
    );
  }
  return trimmed === "" ? null : trimmed;
}

function readPaidByMemberId(value: unknown, creatorMemberId: string): string {
  if (value === undefined || value === null) {
    return creatorMemberId;
  }
  return typeof value === "string" ? value : String(value);
}

function readParticipants(
  value: unknown,
  memberIds: Set<string>,
): NormalizedParticipant[] {
  if (value === undefined) {
    return [...memberIds].map((memberId) => ({ memberId, personalMinor: 0 }));
  }
  if (!Array.isArray(value)) {
    throw new ExpenseError(
      400,
      VALIDATION_CODES.EMPTY_PARTICIPANTS,
      "participants must be an array",
    );
  }
  return value.map((entry) => {
    const item =
      typeof entry === "object" && entry !== null
        ? (entry as Record<string, unknown>)
        : {};
    return {
      memberId: typeof item.memberId === "string" ? item.memberId : "",
      personalMinor:
        typeof item.personalMinor === "number" ? item.personalMinor : 0,
      splitBp: typeof item.splitBp === "number" ? item.splitBp : undefined,
    };
  });
}

async function attachReceipt(
  tx: TransactionExecutor,
  options: {
    receiptId: string;
    eventId: string;
    creatorUserId: string | null;
    expenseId: string;
  },
): Promise<void> {
  const [receipt] = await tx
    .select()
    .from(receipts)
    .where(eq(receipts.id, options.receiptId))
    .for("update");
  if (
    !receipt ||
    receipt.eventId !== options.eventId ||
    receipt.uploadedBy !== options.creatorUserId ||
    receipt.expenseId !== null ||
    receipt.deletedAt !== null
  ) {
    throw new ExpenseError(
      400,
      EXPENSE_CODES.RECEIPT_INVALID,
      "receipt is not an unattached receipt for this event",
    );
  }
  await tx
    .update(receipts)
    .set({ expenseId: options.expenseId })
    .where(eq(receipts.id, options.receiptId));
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

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Row 13: expense detail, capturer edits, void, personal contributions.
// ---------------------------------------------------------------------------

/** Fallback member id that matches nobody; used when the capturer's member row is gone. */
const NO_MEMBER_ID = "00000000-0000-4000-8000-000000000000";

export interface ExpenseDetailParticipant {
  memberId: string;
  displayName: string | null;
  emailNormalized: string;
  personalMinor: number;
  splitBp: number | null;
  shareMinor: number;
}

export interface ExpenseDetailAuditEntry {
  id: string;
  action: string;
  actorName: string | null;
  createdAt: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface ExpenseDetailOcr {
  jobId: string;
  status: string;
  result: OcrResultJson | null;
}

export interface ExpenseDetail {
  event: {
    id: string;
    name: string;
    currency: string;
    status: "open" | "closed";
  };
  expense: {
    id: string;
    eventId: string;
    totalMinor: number;
    spentOn: string;
    description: string | null;
    splitMode: SplitMode;
    paidByMemberId: string | null;
    status: "open" | "voided";
    version: number;
    voidedAt: string | null;
    voidReason: string | null;
  };
  /** Present when a receipt is attached; the receipt file route (row 15) serves the bytes. */
  receiptId: string | null;
  /** The attached receipt's latest OCR job (row 17), for the capturer's "Apply receipt values" action. */
  receiptOcr: ExpenseDetailOcr | null;
  currentMemberId: string;
  isCapturer: boolean;
  /** Capturer/organizer may void while the event is open and the expense is not voided. */
  canVoid: boolean;
  participants: ExpenseDetailParticipant[];
  audit: ExpenseDetailAuditEntry[];
  /** The viewer's own personal amount, or null when they are not a participant. */
  yourPersonalMinor: number | null;
  /** Upper bound for the viewer's personal amount: total - sum(other personals). */
  yourPersonalBoundMinor: number | null;
}

/**
 * Expense detail for the detail page: total, date, description, payer, split
 * mode, receipt reference, every participant's personal amount and computed
 * share, and the audit summary. Shares are computed server-side and never
 * persisted. Reads are open to every active member; a missing or foreign
 * expense is 404.
 */
export async function getExpenseDetail(
  eventId: string,
  expenseId: string,
): Promise<ExpenseDetail> {
  const { event, member, actor } = await requireEventMember(eventId);

  const expense = await db.query.expenses.findFirst({
    where: and(eq(expenses.id, expenseId), eq(expenses.eventId, eventId)),
  });
  if (!expense) {
    throw new AuthorizationError(404, "NOT_FOUND", "expense not found");
  }

  const capturerMemberId = await resolveCapturerMemberId(
    eventId,
    expense.createdBy,
  );
  const allMembers = await db.query.eventMembers.findMany({
    where: eq(eventMembers.eventId, eventId),
  });
  const memberById = new Map(allMembers.map((row) => [row.id, row]));
  const _payer =
    expense.paidByMemberId !== null
      ? memberById.get(expense.paidByMemberId)
      : undefined;

  const participantRows = await db.query.expenseParticipants.findMany({
    where: eq(expenseParticipants.expenseId, expenseId),
    orderBy: [asc(expenseParticipants.createdAt)],
  });
  const { shares } = computeShares({
    totalMinor: expense.totalMinor,
    mode: expense.splitMode as SplitMode,
    participants: participantRows.map((row) => ({
      memberId: row.memberId,
      personalMinor: row.personalMinor,
      splitBp: row.splitBp ?? undefined,
    })),
  });
  const shareByMemberId = new Map(
    shares.map((share) => [share.memberId, share.shareMinor]),
  );

  const participants: ExpenseDetailParticipant[] = participantRows.map(
    (row) => {
      const participantMember = memberById.get(row.memberId);
      return {
        memberId: row.memberId,
        displayName: participantMember?.displayName?.trim() || null,
        emailNormalized: participantMember?.emailNormalized ?? "",
        personalMinor: row.personalMinor,
        splitBp: row.splitBp,
        shareMinor: shareByMemberId.get(row.memberId) ?? 0,
      };
    },
  );

  const [receipt] = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(eq(receipts.expenseId, expenseId), isNull(receipts.deletedAt)))
    .limit(1);

  const [ocrJob] = receipt
    ? await db
        .select({
          id: ocrJobs.id,
          status: ocrJobs.status,
          resultJson: ocrJobs.resultJson,
        })
        .from(ocrJobs)
        .where(eq(ocrJobs.receiptId, receipt.id))
        .orderBy(desc(ocrJobs.createdAt))
        .limit(1)
    : [];

  const auditRows = await db.query.auditLog.findMany({
    where: and(
      eq(auditLog.eventId, eventId),
      eq(auditLog.entityType, "expense"),
      eq(auditLog.entityId, expenseId),
    ),
    orderBy: [asc(auditLog.createdAt)],
    limit: 50,
  });
  const nameByUserId = new Map(
    allMembers
      .filter((row) => row.userId !== null)
      .map((row) => [
        row.userId as string,
        row.displayName?.trim() || row.emailNormalized,
      ]),
  );

  const eventState = event.status === "closed" ? "closed" : "open";
  const yourRow = participantRows.find((row) => row.memberId === member.id);
  const othersPersonal = participantRows.reduce(
    (sum, row) => (row.memberId === member.id ? sum : sum + row.personalMinor),
    0,
  );

  const subject: ExpenseSubject = {
    state: expense.status === "voided" ? "voided" : eventState,
    capturerMemberId,
  };

  return {
    event: {
      id: event.id,
      name: event.name,
      currency: event.currency,
      status: event.status === "closed" ? "closed" : "open",
    },
    expense: {
      id: expense.id,
      eventId: expense.eventId,
      totalMinor: expense.totalMinor,
      spentOn: expense.spentOn,
      description: expense.description,
      splitMode: expense.splitMode as SplitMode,
      paidByMemberId: expense.paidByMemberId,
      status: expense.status === "voided" ? "voided" : "open",
      version: expense.version,
      voidedAt: expense.voidedAt ? expense.voidedAt.toISOString() : null,
      voidReason: expense.voidReason,
    },
    receiptId: receipt?.id ?? null,
    receiptOcr: ocrJob
      ? {
          jobId: ocrJob.id,
          status: ocrJob.status,
          result: (ocrJob.resultJson as OcrResultJson | null) ?? null,
        }
      : null,
    currentMemberId: member.id,
    isCapturer: capturerMemberId === member.id,
    canVoid: canVoidExpense(actor, subject).ok,
    participants,
    audit: auditRows.map((row) => ({
      id: row.id,
      action: row.action,
      actorName:
        row.actorUserId !== null
          ? (nameByUserId.get(row.actorUserId) ?? null)
          : null,
      createdAt: row.createdAt.toISOString(),
      before: (row.beforeJson as Record<string, unknown> | null) ?? null,
      after: (row.afterJson as Record<string, unknown> | null) ?? null,
    })),
    yourPersonalMinor: yourRow?.personalMinor ?? null,
    yourPersonalBoundMinor:
      yourRow === undefined ? null : expense.totalMinor - othersPersonal,
  };
}

export interface UpdateExpenseResult {
  expense: {
    id: string;
    eventId: string;
    totalMinor: number;
    currency: string;
    spentOn: string;
    splitMode: SplitMode;
    paidByMemberId: string | null;
    description: string | null;
    status: "open" | "voided";
    version: number;
  };
  shares: MemberShare[];
}

interface PlannedParticipant {
  memberId: string;
  personalMinor: number;
  splitBp: number | null;
}

/**
 * Capturer edit of an open, non-voided expense. Any subset of totalMinor,
 * spentOn, description, paidByMemberId, splitMode and participants may be
 * sent; omitted fields keep their stored value. Optimistic concurrency: the
 * client must send the `version` it loaded; a mismatch is 409 STALE_EXPENSE.
 * Personal amounts are never editable here: kept participants keep their
 * stored personalMinor, new participants start at 0, and removing a
 * participant who has a personal amount is 409 PARTICIPANT_HAS_PERSONAL. The
 * write runs in a transaction that locks the event, expense, member and
 * participant rows FOR UPDATE and revalidates every guard against fresh data.
 */
export async function updateExpense(
  expenseId: string,
  input: unknown,
): Promise<UpdateExpenseResult> {
  const body =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};

  const expense = await db.query.expenses.findFirst({
    where: eq(expenses.id, expenseId),
  });
  if (!expense) {
    throw new AuthorizationError(404, "NOT_FOUND", "expense not found");
  }
  const { event, member, actor } = await requireEventMember(expense.eventId);
  const capturerMemberId = await resolveCapturerMemberId(
    expense.eventId,
    expense.createdBy,
  );

  const expectedVersion = readVersion(body.version);
  if (expectedVersion !== expense.version) {
    throw new ExpenseError(
      409,
      EXPENSE_CODES.STALE_EXPENSE,
      "the expense changed since you loaded it; reload and try again",
    );
  }

  const subject: ExpenseSubject = {
    state:
      expense.status === "voided"
        ? "voided"
        : event.status === "closed"
          ? "closed"
          : "open",
    capturerMemberId,
  };
  for (const field of EXPENSE_FIELDS) {
    if (body[field] !== undefined) {
      assertPermission(canEditField(actor, subject, field));
    }
  }

  const newTotal =
    body.totalMinor === undefined
      ? expense.totalMinor
      : (body.totalMinor as number);
  const newSpentOn =
    body.spentOn === undefined ? expense.spentOn : readSpentOn(body.spentOn);
  const newDescription =
    body.description === undefined
      ? expense.description
      : readDescription(body.description);
  const newPayer =
    body.paidByMemberId === undefined
      ? expense.paidByMemberId
      : typeof body.paidByMemberId === "string"
        ? body.paidByMemberId
        : null;
  const newMode =
    body.splitMode === undefined
      ? (expense.splitMode as SplitMode)
      : readSplitMode(body.splitMode);

  const _storedParticipants = await db.query.expenseParticipants.findMany({
    where: eq(expenseParticipants.expenseId, expenseId),
    orderBy: [asc(expenseParticipants.createdAt)],
  });

  // Structural participant payload checks (duplicates, member id shape). The
  // authoritative set, personal preservation and removal guards run inside
  // the transaction against fresh rows.
  let requested: { memberId: string; splitBp: number | null }[] | null = null;
  if (body.participants !== undefined) {
    if (!Array.isArray(body.participants)) {
      throw new ExpenseError(
        400,
        VALIDATION_CODES.EMPTY_PARTICIPANTS,
        "participants must be an array",
      );
    }
    const seen = new Set<string>();
    requested = (body.participants as unknown[]).map((entry) => {
      const item =
        typeof entry === "object" && entry !== null
          ? (entry as Record<string, unknown>)
          : {};
      const memberId = typeof item.memberId === "string" ? item.memberId : "";
      if (memberId === "") {
        throw new ExpenseError(
          400,
          EXPENSE_CODES.PARTICIPANT_NOT_MEMBER,
          "participant is not an event member",
        );
      }
      if (seen.has(memberId)) {
        throw new ExpenseError(
          400,
          EXPENSE_CODES.DUPLICATE_PARTICIPANT,
          "each participant may appear only once",
        );
      }
      seen.add(memberId);
      return {
        memberId,
        splitBp: typeof item.splitBp === "number" ? item.splitBp : null,
      };
    });
  }

  if (newMode === "equal" && requested !== null) {
    for (const entry of requested) {
      if (entry.splitBp !== null) {
        throw new ExpenseError(
          400,
          EXPENSE_CODES.SPLIT_BP_NOT_ALLOWED,
          "basis points are not allowed in equal mode",
        );
      }
    }
  }

  const result = await db.transaction(async (tx) => {
    const [lockedEvent] = await tx
      .select()
      .from(events)
      .where(eq(events.id, event.id))
      .for("update");
    if (!lockedEvent || lockedEvent.status !== "open") {
      throw new ExpenseError(
        409,
        EXPENSE_CODES.EVENT_CLOSED,
        "the event is closed and read-only",
      );
    }

    const [lockedExpense] = await tx
      .select()
      .from(expenses)
      .where(eq(expenses.id, expenseId))
      .for("update");
    if (!lockedExpense) {
      throw new AuthorizationError(404, "NOT_FOUND", "expense not found");
    }
    if (lockedExpense.status === "voided") {
      throw new ExpenseError(
        409,
        PERMISSION_CODES.EXPENSE_VOIDED,
        "the expense is voided and read-only",
      );
    }
    if (lockedExpense.version !== expectedVersion) {
      throw new ExpenseError(
        409,
        EXPENSE_CODES.STALE_EXPENSE,
        "the expense changed since you loaded it; reload and try again",
      );
    }

    const lockedMembers = await tx
      .select()
      .from(eventMembers)
      .where(
        and(
          eq(eventMembers.eventId, event.id),
          ne(eventMembers.status, "removed"),
        ),
      )
      .orderBy(asc(eventMembers.createdAt))
      .for("update");
    const lockedMemberIds = new Set(lockedMembers.map((row) => row.id));

    // Fresh participant rows under the lock; personal amounts may have been
    // edited concurrently between the precheck and this point.
    const freshParticipants = await tx
      .select()
      .from(expenseParticipants)
      .where(eq(expenseParticipants.expenseId, expenseId))
      .orderBy(asc(expenseParticipants.createdAt))
      .for("update");
    const freshByMemberId = new Map(
      freshParticipants.map((row) => [row.memberId, row]),
    );

    let planned: PlannedParticipant[];
    if (requested === null) {
      planned = freshParticipants.map((row) => ({
        memberId: row.memberId,
        personalMinor: row.personalMinor,
        splitBp: newMode === "equal" ? null : row.splitBp,
      }));
    } else {
      // Removing a participant who has a personal amount is not allowed.
      const requestedIds = new Set(requested.map((entry) => entry.memberId));
      for (const fresh of freshParticipants) {
        if (!requestedIds.has(fresh.memberId) && fresh.personalMinor > 0) {
          assertPermission(
            canRemoveParticipant(
              actor,
              subject,
              fresh.memberId,
              fresh.personalMinor,
            ),
          );
        }
      }
      planned = requested.map((entry) => {
        const fresh = freshByMemberId.get(entry.memberId);
        const storedBp = fresh?.splitBp ?? null;
        const splitBp =
          newMode === "equal" ? null : (entry.splitBp ?? storedBp);
        return {
          memberId: entry.memberId,
          personalMinor: fresh?.personalMinor ?? 0,
          splitBp,
        };
      });
    }

    if (newPayer === null || !lockedMemberIds.has(newPayer)) {
      throw new ExpenseError(
        400,
        VALIDATION_CODES.PAYER_NOT_MEMBER,
        "the payer must be an event member",
      );
    }
    for (const participant of planned) {
      if (!lockedMemberIds.has(participant.memberId)) {
        throw new ExpenseError(
          400,
          EXPENSE_CODES.PARTICIPANT_NOT_MEMBER,
          "participant is not an event member",
        );
      }
    }

    const validation = validateExpenseInput({
      totalMinor: newTotal,
      mode: newMode,
      payerMemberId: newPayer,
      memberIds: [...lockedMemberIds],
      participants: planned.map((participant) => ({
        memberId: participant.memberId,
        personalMinor: participant.personalMinor,
        splitBp: participant.splitBp ?? undefined,
      })),
    });
    if (!validation.ok) {
      throw new ExpenseError(400, validation.code, validation.message);
    }

    const { shares } = computeShares({
      totalMinor: newTotal,
      mode: newMode,
      participants: planned.map((participant) => ({
        memberId: participant.memberId,
        personalMinor: participant.personalMinor,
        splitBp: participant.splitBp ?? undefined,
      })),
    });

    const [updatedExpense] = await tx
      .update(expenses)
      .set({
        totalMinor: newTotal,
        spentOn: newSpentOn,
        description: newDescription,
        paidByMemberId: newPayer,
        splitMode: newMode,
        version: lockedExpense.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(expenses.id, expenseId))
      .returning();

    const plannedIds = new Set(
      planned.map((participant) => participant.memberId),
    );
    const removedRows = freshParticipants.filter(
      (row) => !plannedIds.has(row.memberId),
    );
    if (removedRows.length > 0) {
      await tx.delete(expenseParticipants).where(
        inArray(
          expenseParticipants.id,
          removedRows.map((row) => row.id),
        ),
      );
    }
    for (const participant of planned) {
      const fresh = freshByMemberId.get(participant.memberId);
      if (fresh === undefined) {
        await tx.insert(expenseParticipants).values({
          expenseId,
          memberId: participant.memberId,
          personalMinor: participant.personalMinor,
          splitBp: participant.splitBp,
        });
      } else if (
        fresh.splitBp !== participant.splitBp ||
        fresh.personalMinor !== participant.personalMinor
      ) {
        await tx
          .update(expenseParticipants)
          .set({
            splitBp: participant.splitBp,
            personalMinor: participant.personalMinor,
            updatedAt: new Date(),
          })
          .where(eq(expenseParticipants.id, fresh.id));
      }
    }

    await writeAudit(
      {
        eventId: event.id,
        actorUserId: member.userId,
        entityType: "expense",
        entityId: expenseId,
        action: "expense.update",
        before: {
          totalMinor: lockedExpense.totalMinor,
          spentOn: lockedExpense.spentOn,
          description: lockedExpense.description,
          paidByMemberId: lockedExpense.paidByMemberId,
          splitMode: lockedExpense.splitMode,
          version: lockedExpense.version,
          participants: freshParticipants.map((row) => ({
            memberId: row.memberId,
            personalMinor: row.personalMinor,
            splitBp: row.splitBp,
          })),
        },
        after: {
          totalMinor: updatedExpense.totalMinor,
          spentOn: updatedExpense.spentOn,
          description: updatedExpense.description,
          paidByMemberId: updatedExpense.paidByMemberId,
          splitMode: updatedExpense.splitMode,
          version: updatedExpense.version,
          participants: planned.map((participant) => ({
            memberId: participant.memberId,
            personalMinor: participant.personalMinor,
            splitBp: participant.splitBp,
          })),
        },
      },
      tx,
    );

    return { expense: updatedExpense, shares };
  });

  return {
    expense: {
      id: result.expense.id,
      eventId: result.expense.eventId,
      totalMinor: result.expense.totalMinor,
      currency: result.expense.currency,
      spentOn: result.expense.spentOn,
      splitMode: result.expense.splitMode as SplitMode,
      paidByMemberId: result.expense.paidByMemberId,
      description: result.expense.description,
      status: result.expense.status === "voided" ? "voided" : "open",
      version: result.expense.version,
    },
    shares: result.shares,
  };
}

export interface UpdatePersonalResult {
  expense: {
    id: string;
    eventId: string;
    totalMinor: number;
    currency: string;
    version: number;
    status: "open" | "voided";
  };
  yourPersonalMinor: number;
  shares: MemberShare[];
}

/**
 * A member PUTs their own personal amount. The bound 0 <= P <= total -
 * sum(other personals) is revalidated against fresh rows inside the
 * transaction; violations are 400. Every accepted edit increments the expense
 * version so stale capturer forms reload.
 */
export async function updatePersonal(
  expenseId: string,
  input: unknown,
): Promise<UpdatePersonalResult> {
  const body =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};

  const expense = await db.query.expenses.findFirst({
    where: eq(expenses.id, expenseId),
  });
  if (!expense) {
    throw new AuthorizationError(404, "NOT_FOUND", "expense not found");
  }
  const { event, member, actor } = await requireEventMember(expense.eventId);
  const capturerMemberId = await resolveCapturerMemberId(
    expense.eventId,
    expense.createdBy,
  );

  const personalMinor = body.personalMinor;
  if (typeof personalMinor !== "number" || !Number.isInteger(personalMinor)) {
    throw new ExpenseError(
      400,
      VALIDATION_CODES.PERSONAL_NOT_INTEGER,
      "personal amounts must be integers",
    );
  }

  const storedParticipants = await db.query.expenseParticipants.findMany({
    where: eq(expenseParticipants.expenseId, expenseId),
  });
  const subject: ExpenseSubject = {
    state:
      expense.status === "voided"
        ? "voided"
        : event.status === "closed"
          ? "closed"
          : "open",
    capturerMemberId,
  };
  const verdict = canEditPersonal(actor, subject, member.id, personalMinor, {
    totalMinor: expense.totalMinor,
    participants: storedParticipants.map((row) => ({
      memberId: row.memberId,
      personalMinor: row.personalMinor,
    })),
  });
  if (!verdict.ok) {
    if (verdict.code === PERMISSION_CODES.PERSONAL_OUT_OF_BOUNDS) {
      // Row 13 contract: the bound is enforced with 400.
      throw new ExpenseError(400, verdict.code, verdict.message);
    }
    assertPermission(verdict);
  }

  const result = await db.transaction(async (tx) => {
    const [lockedEvent] = await tx
      .select()
      .from(events)
      .where(eq(events.id, event.id))
      .for("update");
    if (!lockedEvent || lockedEvent.status !== "open") {
      throw new ExpenseError(
        409,
        EXPENSE_CODES.EVENT_CLOSED,
        "the event is closed and read-only",
      );
    }

    const [lockedExpense] = await tx
      .select()
      .from(expenses)
      .where(eq(expenses.id, expenseId))
      .for("update");
    if (!lockedExpense) {
      throw new AuthorizationError(404, "NOT_FOUND", "expense not found");
    }
    if (lockedExpense.status === "voided") {
      throw new ExpenseError(
        409,
        PERMISSION_CODES.EXPENSE_VOIDED,
        "the expense is voided and read-only",
      );
    }

    const lockedParticipants = await tx
      .select()
      .from(expenseParticipants)
      .where(eq(expenseParticipants.expenseId, expenseId))
      .orderBy(asc(expenseParticipants.createdAt))
      .for("update");
    const mine = lockedParticipants.find((row) => row.memberId === member.id);
    if (mine === undefined) {
      throw new ExpenseError(
        409,
        PERMISSION_CODES.NOT_A_PARTICIPANT,
        "you are not a participant of this expense",
      );
    }
    const _othersPersonal = lockedParticipants.reduce(
      (sum, row) =>
        row.memberId === member.id ? sum : sum + row.personalMinor,
      0,
    );
    if (
      !isPersonalWithinBound(
        lockedExpense.totalMinor,
        lockedParticipants.map((row) => ({
          memberId: row.memberId,
          personalMinor: row.personalMinor,
        })),
        member.id,
        personalMinor,
      )
    ) {
      throw new ExpenseError(
        400,
        PERMISSION_CODES.PERSONAL_OUT_OF_BOUNDS,
        "personal amount must satisfy 0 <= P <= total - other personal amounts",
      );
    }

    const [updatedExpense] = await tx
      .update(expenses)
      .set({
        version: lockedExpense.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(expenses.id, expenseId))
      .returning();

    await tx
      .update(expenseParticipants)
      .set({ personalMinor, updatedAt: new Date() })
      .where(eq(expenseParticipants.id, mine.id));

    const finalParticipants = lockedParticipants.map((row) =>
      row.memberId === member.id ? { ...row, personalMinor } : row,
    );
    const { shares } = computeShares({
      totalMinor: updatedExpense.totalMinor,
      mode: updatedExpense.splitMode as SplitMode,
      participants: finalParticipants.map((row) => ({
        memberId: row.memberId,
        personalMinor: row.personalMinor,
        splitBp: row.splitBp ?? undefined,
      })),
    });

    await writeAudit(
      {
        eventId: event.id,
        actorUserId: member.userId,
        entityType: "expense",
        entityId: expenseId,
        action: "expense.personal_update",
        before: { memberId: member.id, personalMinor: mine.personalMinor },
        after: { memberId: member.id, personalMinor },
      },
      tx,
    );

    return {
      expense: updatedExpense,
      yourPersonalMinor: personalMinor,
      shares,
    };
  });

  return {
    expense: {
      id: result.expense.id,
      eventId: result.expense.eventId,
      totalMinor: result.expense.totalMinor,
      currency: result.expense.currency,
      version: result.expense.version,
      status: result.expense.status === "voided" ? "voided" : "open",
    },
    yourPersonalMinor: result.yourPersonalMinor,
    shares: result.shares,
  };
}

export interface VoidExpenseResult {
  expense: {
    id: string;
    eventId: string;
    status: "voided";
    version: number;
    voidedAt: string;
    voidReason: string;
  };
}

/**
 * Voids an expense with a reason. The capturer or the organizer may void
 * while the event is open; voided expenses are read-only and excluded from
 * reports, but the receipt is kept. No hard delete ever happens.
 */
export async function voidExpense(
  expenseId: string,
  input: unknown,
): Promise<VoidExpenseResult> {
  const body =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};

  const expense = await db.query.expenses.findFirst({
    where: eq(expenses.id, expenseId),
  });
  if (!expense) {
    throw new AuthorizationError(404, "NOT_FOUND", "expense not found");
  }
  const { event, member, actor } = await requireEventMember(expense.eventId);
  const capturerMemberId = await resolveCapturerMemberId(
    expense.eventId,
    expense.createdBy,
  );

  const reason = readVoidReason(body.reason);

  const subject: ExpenseSubject = {
    state:
      expense.status === "voided"
        ? "voided"
        : event.status === "closed"
          ? "closed"
          : "open",
    capturerMemberId,
  };
  assertPermission(canVoidExpense(actor, subject));

  const result = await db.transaction(async (tx) => {
    const [lockedEvent] = await tx
      .select()
      .from(events)
      .where(eq(events.id, event.id))
      .for("update");
    if (!lockedEvent || lockedEvent.status !== "open") {
      throw new ExpenseError(
        409,
        EXPENSE_CODES.EVENT_CLOSED,
        "the event is closed and read-only",
      );
    }

    const [lockedExpense] = await tx
      .select()
      .from(expenses)
      .where(eq(expenses.id, expenseId))
      .for("update");
    if (!lockedExpense) {
      throw new AuthorizationError(404, "NOT_FOUND", "expense not found");
    }
    if (lockedExpense.status === "voided") {
      throw new ExpenseError(
        409,
        PERMISSION_CODES.EXPENSE_VOIDED,
        "the expense is already voided",
      );
    }

    const [updated] = await tx
      .update(expenses)
      .set({
        status: "voided",
        voidedAt: new Date(),
        voidedBy: member.userId,
        voidReason: reason,
        version: lockedExpense.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(expenses.id, expenseId))
      .returning();

    await writeAudit(
      {
        eventId: event.id,
        actorUserId: member.userId,
        entityType: "expense",
        entityId: expenseId,
        action: "expense.void",
        before: {
          status: lockedExpense.status,
          totalMinor: lockedExpense.totalMinor,
        },
        after: {
          status: "voided",
          totalMinor: lockedExpense.totalMinor,
          voidReason: reason,
        },
      },
      tx,
    );

    return updated;
  });

  return {
    expense: {
      id: result.id,
      eventId: result.eventId,
      status: "voided",
      version: result.version,
      voidedAt: (result.voidedAt ?? new Date()).toISOString(),
      voidReason: result.voidReason ?? reason,
    },
  };
}

export interface ReportExpense {
  id: string;
  totalMinor: number;
  spentOn: string;
  description: string | null;
  paidByMemberId: string | null;
  shares: MemberShare[];
}

/**
 * The report/tally feed (row 18 consumes this): non-voided expenses only,
 * with server-computed shares. Voided expenses are excluded here, which is
 * the service-layer proof of report exclusion.
 */
export async function listReportExpenses(
  eventId: string,
): Promise<ReportExpense[]> {
  const { event } = await requireEventMember(eventId);

  const rows = await db.query.expenses.findMany({
    where: and(eq(expenses.eventId, event.id), eq(expenses.status, "open")),
    orderBy: [asc(expenses.createdAt)],
  });
  const report: ReportExpense[] = [];
  for (const expense of rows) {
    const participants = await db.query.expenseParticipants.findMany({
      where: eq(expenseParticipants.expenseId, expense.id),
    });
    const { shares } = computeShares({
      totalMinor: expense.totalMinor,
      mode: expense.splitMode as SplitMode,
      participants: participants.map((row) => ({
        memberId: row.memberId,
        personalMinor: row.personalMinor,
        splitBp: row.splitBp ?? undefined,
      })),
    });
    report.push({
      id: expense.id,
      totalMinor: expense.totalMinor,
      spentOn: expense.spentOn,
      description: expense.description,
      paidByMemberId: expense.paidByMemberId,
      shares,
    });
  }
  return report;
}

/** Resolves the member row of the capturer (expense.createdBy user id). */
async function resolveCapturerMemberId(
  eventId: string,
  capturerUserId: string | null,
): Promise<string> {
  if (capturerUserId === null) {
    return NO_MEMBER_ID;
  }
  const [row] = await db
    .select({ id: eventMembers.id })
    .from(eventMembers)
    .where(
      and(
        eq(eventMembers.eventId, eventId),
        eq(eventMembers.userId, capturerUserId),
      ),
    )
    .limit(1);
  return row?.id ?? NO_MEMBER_ID;
}

function readVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ExpenseError(
      400,
      EXPENSE_CODES.INVALID_VERSION,
      "version must be the expense version you loaded",
    );
  }
  return value;
}

function readVoidReason(value: unknown): string {
  if (typeof value !== "string") {
    throw new ExpenseError(
      400,
      EXPENSE_CODES.VOID_REASON_INVALID,
      "a void reason is required",
    );
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 200) {
    throw new ExpenseError(
      400,
      EXPENSE_CODES.VOID_REASON_INVALID,
      "the void reason must be 1-200 characters",
    );
  }
  return trimmed;
}
