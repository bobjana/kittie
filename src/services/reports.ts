import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { eventMembers, eventSettlements, events, expenses } from "@/db/schema";
import { computeBalances, settle, type Transfer } from "@/domain/settlement";

export type { Transfer };

import {
  AuthorizationError,
  requireEventMember,
  requireSession,
} from "@/lib/authorization";
import { listReportExpenses } from "@/services/expenses";

/**
 * Row 18: the live tally report and the tally-first landing data.
 *
 * Binding API note: row 5 exposes computeBalances(expenses) for totals and
 * balances and settle(balances, canonicalOrder) for transfers. This service
 * composes the report shape from both - no money math is re-implemented here
 * and none may live in components or pages.
 */

export interface ReportMember {
  memberId: string;
  displayName: string | null;
  emailNormalized: string;
  role: "organizer" | "member";
  /** Sum of every non-voided expense this member paid for. */
  paidMinor: number;
  /** Sum of this member's computed share across non-voided expenses. */
  shareMinor: number;
  /** paid - share. Positive: this member should receive money back. */
  netMinor: number;
}

export interface EventReport {
  event: {
    id: string;
    name: string;
    currency: string;
    status: "open" | "closed";
    closedAt: string | null;
  };
  viewerMemberId: string;
  totalSpentMinor: number;
  totalOwedMinor: number;
  members: ReportMember[];
  transfers: Transfer[];
  /** True when the numbers were read from the frozen settlement snapshot. */
  frozen: boolean;
  /** The frozen settlement, needed to fetch its tally-email delivery status. */
  settlementId: string | null;
}

export interface TallyEventCard {
  id: string;
  name: string;
  currency: string;
  status: "open" | "closed";
  role: "organizer" | "member";
  updatedAt: string;
  /** Server-computed sum of non-voided expense totals. */
  totalSpentMinor: number;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ReportError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = "ReportError";
    this.status = status;
    this.code = code;
  }
}

export const REPORT_CODES = {
  SETTLEMENT_MISSING: "SETTLEMENT_MISSING",
} as const;

/**
 * Frozen snapshot contract: row 19's close transaction must store
 * serializeSettlementSnapshot(...) in balances_json and the Transfer[] in
 * transfers_json. This reader accepts exactly that shape and rejects
 * anything else, so a drifted snapshot can never render as live data.
 */
export const SETTLEMENT_SNAPSHOT_VERSION = 1;

export interface SettlementSnapshotJson {
  version: typeof SETTLEMENT_SNAPSHOT_VERSION;
  totalSpentMinor: number;
  totalOwedMinor: number;
  members: {
    memberId: string;
    paidMinor: number;
    shareMinor: number;
    netMinor: number;
  }[];
  transfers: Transfer[];
}

export function serializeSettlementSnapshot(
  members: ReportMember[],
  transfers: Transfer[],
  totalSpentMinor: number,
  totalOwedMinor: number,
): SettlementSnapshotJson {
  return {
    version: SETTLEMENT_SNAPSHOT_VERSION,
    totalSpentMinor,
    totalOwedMinor,
    members: members.map((member) => ({
      memberId: member.memberId,
      paidMinor: member.paidMinor,
      shareMinor: member.shareMinor,
      netMinor: member.netMinor,
    })),
    transfers,
  };
}

function readInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ReportError(
      500,
      REPORT_CODES.SETTLEMENT_MISSING,
      `settlement snapshot field ${field} must be an integer`,
    );
  }
  return value;
}

function readNonNegativeInt(value: unknown, field: string): number {
  const parsed = readInteger(value, field);
  if (parsed < 0) {
    throw new ReportError(
      500,
      REPORT_CODES.SETTLEMENT_MISSING,
      `settlement snapshot field ${field} must be a non-negative integer`,
    );
  }
  return parsed;
}

export function readSettlementSnapshot(raw: unknown): SettlementSnapshotJson {
  if (typeof raw !== "object" || raw === null) {
    throw new ReportError(
      500,
      REPORT_CODES.SETTLEMENT_MISSING,
      "settlement snapshot is malformed",
    );
  }
  const snapshot = raw as Record<string, unknown>;
  if (snapshot.version !== SETTLEMENT_SNAPSHOT_VERSION) {
    throw new ReportError(
      500,
      REPORT_CODES.SETTLEMENT_MISSING,
      "settlement snapshot version is unsupported",
    );
  }
  const totalSpentMinor = readNonNegativeInt(
    snapshot.totalSpentMinor,
    "totalSpentMinor",
  );
  const totalOwedMinor = readNonNegativeInt(
    snapshot.totalOwedMinor,
    "totalOwedMinor",
  );
  if (!Array.isArray(snapshot.members)) {
    throw new ReportError(
      500,
      REPORT_CODES.SETTLEMENT_MISSING,
      "settlement snapshot members must be an array",
    );
  }
  const members = snapshot.members.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new ReportError(
        500,
        REPORT_CODES.SETTLEMENT_MISSING,
        "settlement snapshot member is malformed",
      );
    }
    const member = entry as Record<string, unknown>;
    if (typeof member.memberId !== "string" || member.memberId === "") {
      throw new ReportError(
        500,
        REPORT_CODES.SETTLEMENT_MISSING,
        "settlement snapshot member id is missing",
      );
    }
    return {
      memberId: member.memberId,
      paidMinor: readNonNegativeInt(member.paidMinor, "paidMinor"),
      shareMinor: readNonNegativeInt(member.shareMinor, "shareMinor"),
      netMinor: readInteger(member.netMinor, "netMinor"),
    };
  });
  return {
    version: SETTLEMENT_SNAPSHOT_VERSION,
    totalSpentMinor,
    totalOwedMinor,
    members,
    transfers: readTransfers(snapshot.transfers),
  };
}

export function readTransfers(raw: unknown): Transfer[] {
  if (!Array.isArray(raw)) {
    throw new ReportError(
      500,
      REPORT_CODES.SETTLEMENT_MISSING,
      "settlement transfers must be an array",
    );
  }
  return raw.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new ReportError(
        500,
        REPORT_CODES.SETTLEMENT_MISSING,
        "settlement transfer is malformed",
      );
    }
    const transfer = entry as Record<string, unknown>;
    if (
      typeof transfer.fromMemberId !== "string" ||
      typeof transfer.toMemberId !== "string" ||
      typeof transfer.amountMinor !== "number" ||
      !Number.isInteger(transfer.amountMinor) ||
      transfer.amountMinor <= 0
    ) {
      throw new ReportError(
        500,
        REPORT_CODES.SETTLEMENT_MISSING,
        "settlement transfer is malformed",
      );
    }
    return {
      fromMemberId: transfer.fromMemberId,
      toMemberId: transfer.toMemberId,
      amountMinor: transfer.amountMinor,
    };
  });
}

function toReportMember(
  row: typeof eventMembers.$inferSelect,
  paidMinor: number,
  shareMinor: number,
): ReportMember {
  const displayName = row.displayName?.trim() || null;
  return {
    memberId: row.id,
    displayName,
    emailNormalized: row.emailNormalized,
    role: row.role === "organizer" ? "organizer" : "member",
    paidMinor,
    shareMinor,
    netMinor: paidMinor - shareMinor,
  };
}

/**
 * Builds the report for an event the viewer belongs to. Closed events read
 * the frozen settlement snapshot instead of recomputing, so the numbers can
 * never drift after Close.
 */
export async function getEventReport(eventId: string): Promise<EventReport> {
  if (!UUID_PATTERN.test(eventId)) {
    throw new AuthorizationError(404, "NOT_FOUND", "event not found");
  }
  const { event, member } = await requireEventMember(eventId);

  const memberRows = await db.query.eventMembers.findMany({
    where: and(
      eq(eventMembers.eventId, eventId),
      ne(eventMembers.status, "removed"),
    ),
    orderBy: [asc(eventMembers.createdAt)],
  });

  if (event.status === "closed") {
    const [settlement] = await db
      .select()
      .from(eventSettlements)
      .where(
        and(
          eq(eventSettlements.eventId, eventId),
          isNull(eventSettlements.supersededAt),
        ),
      )
      .orderBy(desc(eventSettlements.version))
      .limit(1);
    if (!settlement) {
      throw new ReportError(
        500,
        REPORT_CODES.SETTLEMENT_MISSING,
        "closed event has no frozen settlement snapshot",
      );
    }
    const snapshot = readSettlementSnapshot(settlement.balancesJson);
    const transfers = readTransfers(settlement.transfersJson);
    const memberById = new Map(memberRows.map((row) => [row.id, row]));
    const members = snapshot.members.map((entry) => {
      const row = memberById.get(entry.memberId);
      if (!row) {
        throw new ReportError(
          500,
          REPORT_CODES.SETTLEMENT_MISSING,
          "settlement snapshot references an unknown member",
        );
      }
      return toReportMember(row, entry.paidMinor, entry.shareMinor);
    });
    return {
      event: {
        id: event.id,
        name: event.name,
        currency: event.currency,
        status: "closed",
        closedAt: event.closedAt?.toISOString() ?? null,
      },
      viewerMemberId: member.id,
      totalSpentMinor: snapshot.totalSpentMinor,
      totalOwedMinor: snapshot.totalOwedMinor,
      members,
      transfers,
      frozen: true,
      settlementId: settlement.id,
    };
  }

  const reportExpenses = await listReportExpenses(eventId);
  const settlementExpenses = reportExpenses
    .filter((expense) => expense.paidByMemberId !== null)
    .map((expense) => ({
      paidByMemberId: expense.paidByMemberId as string,
      totalMinor: expense.totalMinor,
      shares: expense.shares.map((share) => ({
        memberId: share.memberId,
        shareMinor: share.shareMinor,
      })),
      voided: false,
    }));

  const { totalSpentMinor, totalOwedMinor, balances } =
    computeBalances(settlementExpenses);
  const canonicalOrder = memberRows.map((row) => row.id);
  const transfers = settle(balances, canonicalOrder);

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

  const members = memberRows.map((row) =>
    toReportMember(row, paidBy.get(row.id) ?? 0, shareBy.get(row.id) ?? 0),
  );

  return {
    event: {
      id: event.id,
      name: event.name,
      currency: event.currency,
      status: "open",
      closedAt: null,
    },
    viewerMemberId: member.id,
    totalSpentMinor,
    totalOwedMinor,
    members,
    transfers,
    frozen: false,
    settlementId: null,
  };
}

/**
 * The current user's events ordered by events.updated_at desc, most recent
 * first. Pending memberships are excluded: a pending invitee has no tally.
 */
export async function listTallyEvents(): Promise<TallyEventCard[]> {
  const session = await requireSession();
  const rows = await db
    .select({ event: events, member: eventMembers })
    .from(eventMembers)
    .innerJoin(events, eq(events.id, eventMembers.eventId))
    .where(
      and(
        eq(eventMembers.userId, session.user.id),
        eq(eventMembers.status, "active"),
      ),
    )
    .orderBy(desc(events.updatedAt));
  const eventIds = rows.map((row) => row.event.id);
  const totals = await db
    .select({
      eventId: expenses.eventId,
      totalSpent: sql<string>`coalesce(sum(${expenses.totalMinor}), 0)`,
    })
    .from(expenses)
    .where(
      and(eq(expenses.status, "open"), inArray(expenses.eventId, eventIds)),
    )
    .groupBy(expenses.eventId);
  const totalByEvent = new Map(
    totals.map((row) => [row.eventId, Number(row.totalSpent)]),
  );
  return rows.map(({ event, member }) => ({
    id: event.id,
    name: event.name,
    currency: event.currency,
    status: event.status === "closed" ? "closed" : "open",
    role: member.role === "organizer" ? "organizer" : "member",
    updatedAt: event.updatedAt.toISOString(),
    totalSpentMinor: totalByEvent.get(event.id) ?? 0,
  }));
}

export type TallyDecision =
  | { kind: "redirect"; eventId: string }
  | { kind: "cards"; events: TallyEventCard[] }
  | { kind: "closed"; eventId: string }
  | { kind: "empty" };

/**
 * The tally-first landing rule: one open event redirects to its report,
 * several render cards, none renders the empty state, and closed-only reads
 * the most recent frozen report.
 */
export function resolveTallyLanding(events: TallyEventCard[]): TallyDecision {
  const openEvents = events.filter((event) => event.status === "open");
  const [first] = events;
  const [onlyOpen] = openEvents;

  if (openEvents.length === 0) {
    return first ? { kind: "closed", eventId: first.id } : { kind: "empty" };
  }
  if (openEvents.length === 1 && onlyOpen) {
    return { kind: "redirect", eventId: onlyOpen.id };
  }
  return { kind: "cards", events: openEvents };
}
