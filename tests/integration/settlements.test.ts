import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { client } from "@/db/client";
import * as schema from "@/db/schema";
import { AuthorizationError } from "@/lib/authorization";
import {
  createExpense,
  ExpenseError,
  updateExpense,
  updatePersonal,
  voidExpense,
} from "@/services/expenses";
import { inviteMember, revokeInvite } from "@/services/invites";
import { removeMember } from "@/services/members";
import { getEventReport } from "@/services/reports";
import {
  closeEvent,
  reopenEvent,
  SettlementError,
} from "@/services/settlements";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error("TEST_DATABASE_URL is not set");
}

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: getSessionMock } },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

const USER_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const USER_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const USER_C = "cccccccc-0000-4000-8000-00000000000c";

function sessionFor(userId: string, email: string) {
  return {
    session: {
      id: `session-${userId}`,
      userId,
      token: "token",
      expiresAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ipAddress: null,
      userAgent: null,
    },
    user: {
      id: userId,
      email,
      name: "Test User",
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

let sql: ReturnType<typeof postgres>;

async function createOrganizedEvent(name: string): Promise<{
  eventId: string;
  organizerMemberId: string;
}> {
  const rows = await sql<Array<{ id: string }>>`
    insert into events (name, organizer_user_id, currency, status, created_at, updated_at)
    values (${name}, ${USER_A}, 'EUR', 'open', now(), now())
    returning id
  `;
  const eventId = rows[0].id;
  const organizerMemberId = await addMember(
    eventId,
    USER_A,
    "organizer@example.com",
    "Organizer",
    "organizer",
    "active",
  );
  return { eventId, organizerMemberId };
}

async function addMember(
  eventId: string,
  userId: string | null,
  email: string,
  displayName: string | null,
  role: "organizer" | "member",
  status: "pending" | "active" | "removed",
): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    insert into event_members (event_id, user_id, email_normalized, display_name, role, status, joined_at, created_at)
    values (
      ${eventId},
      ${userId},
      ${email},
      ${displayName},
      ${role},
      ${status},
      ${status === "active" ? sql`now()` : null},
      now()
    )
    returning id
  `;
  return rows[0].id;
}

async function addExpense(input: {
  eventId: string;
  paidByMemberId: string;
  totalMinor: number;
  participants: { memberId: string; personalMinor?: number }[];
}): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    insert into expenses (event_id, created_by, paid_by_member_id, total_minor, currency, spent_on, split_mode, status)
    values (${input.eventId}, ${USER_A}, ${input.paidByMemberId}, ${input.totalMinor}, 'EUR', '2026-02-01', 'equal', 'open')
    returning id
  `;
  const expenseId = rows[0].id;
  for (const participant of input.participants) {
    await sql`
      insert into expense_participants (expense_id, member_id, personal_minor)
      values (${expenseId}, ${participant.memberId}, ${participant.personalMinor ?? 0})
    `;
  }
  return expenseId;
}

function errorCode(error: unknown): { status: number; code: string } | null {
  if (
    error instanceof AuthorizationError ||
    error instanceof ExpenseError ||
    error instanceof SettlementError
  ) {
    return { status: error.status, code: error.code };
  }
  return null;
}

beforeAll(async () => {
  sql = postgres(url, { max: 1 });
  await sql`drop schema if exists public cascade`;
  await sql`drop schema if exists drizzle cascade`;
  await sql`create schema public`;
  const db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await sql?.end();
  await client.end();
});

beforeEach(async () => {
  await sql`truncate table events cascade`;
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue(sessionFor(USER_A, "organizer@example.com"));
});

describe("close", () => {
  it("freezes one settlement, queues a tally job per non-removed member and writes audit rows", async () => {
    const { eventId, organizerMemberId } =
      await createOrganizedEvent("Close me");
    const friendId = await addMember(
      eventId,
      USER_B,
      "friend@example.com",
      "Friend",
      "member",
      "active",
    );
    await addMember(
      eventId,
      USER_C,
      "pending@example.com",
      null,
      "member",
      "pending",
    );
    await addMember(
      eventId,
      null,
      "gone@example.com",
      "Gone",
      "member",
      "removed",
    );
    await addExpense({
      eventId,
      paidByMemberId: organizerMemberId,
      totalMinor: 30000,
      participants: [{ memberId: organizerMemberId }, { memberId: friendId }],
    });

    const result = await closeEvent(eventId);

    expect(result).toMatchObject({
      status: "closed",
      version: 1,
      totalSpentMinor: 30000,
      totalOwedMinor: 15000,
    });

    const settlements = await sql<
      Array<{
        version: number;
        total_spent_minor: number;
        balances_json: {
          version: number;
          totalSpentMinor: number;
          totalOwedMinor: number;
          members: Array<{
            memberId: string;
            paidMinor: number;
            shareMinor: number;
            netMinor: number;
          }>;
          transfers: Array<{
            fromMemberId: string;
            toMemberId: string;
            amountMinor: number;
          }>;
        };
        transfers_json: unknown;
        superseded_at: string | null;
      }>
    >`select version, total_spent_minor, balances_json, transfers_json, superseded_at
        from event_settlements where event_id = ${eventId}`;
    expect(settlements).toHaveLength(1);
    expect(settlements[0].version).toBe(1);
    expect(Number(settlements[0].total_spent_minor)).toBe(30000);
    expect(settlements[0].superseded_at).toBeNull();
    expect(settlements[0].balances_json).toMatchObject({
      version: 1,
      totalSpentMinor: 30000,
      totalOwedMinor: 15000,
    });
    expect(settlements[0].balances_json.members).toHaveLength(3);
    expect(settlements[0].balances_json.transfers).toEqual([
      {
        fromMemberId: friendId,
        toMemberId: organizerMemberId,
        amountMinor: 15000,
      },
    ]);
    expect(settlements[0].transfers_json).toEqual([
      {
        fromMemberId: friendId,
        toMemberId: organizerMemberId,
        amountMinor: 15000,
      },
    ]);

    const [event] = await sql<
      Array<{ status: string; closed_at: string | null }>
    >`
      select status, closed_at from events where id = ${eventId}
    `;
    expect(event.status).toBe("closed");
    expect(event.closed_at).not.toBeNull();

    const jobs = await sql<Array<{ status: string; recipient_email: string }>>`
      select status, recipient_email from notification_jobs where event_id = ${eventId} order by recipient_email
    `;
    expect(jobs.map((job) => job.recipient_email)).toEqual([
      "friend@example.com",
      "organizer@example.com",
      "pending@example.com",
    ]);
    expect(jobs.every((job) => job.status === "queued")).toBe(true);

    const audit = await sql<Array<{ action: string; entity_type: string }>>`
      select action, entity_type from audit_log where event_id = ${eventId}
    `;
    expect(audit).toEqual([{ action: "event.close", entity_type: "event" }]);

    const report = await getEventReport(eventId);
    expect(report.frozen).toBe(true);
    expect(report.totalSpentMinor).toBe(30000);
    expect(report.transfers).toEqual([
      {
        fromMemberId: friendId,
        toMemberId: organizerMemberId,
        amountMinor: 15000,
      },
    ]);
  });

  it("keeps serving the frozen numbers after the live expense table drifts", async () => {
    const { eventId, organizerMemberId } = await createOrganizedEvent("Frozen");
    const friendId = await addMember(
      eventId,
      USER_B,
      "friend@example.com",
      "Friend",
      "member",
      "active",
    );
    const expenseId = await addExpense({
      eventId,
      paidByMemberId: organizerMemberId,
      totalMinor: 10000,
      participants: [{ memberId: organizerMemberId }, { memberId: friendId }],
    });
    await closeEvent(eventId);

    // Simulate a dirty write that slipped past the API: the frozen report
    // must still render the snapshot, never the live rows.
    await sql`update expenses set total_minor = 99999 where id = ${expenseId}`;

    const report = await getEventReport(eventId);
    expect(report.frozen).toBe(true);
    expect(report.totalSpentMinor).toBe(10000);
  });

  it("rejects a double close with 409 and creates nothing new", async () => {
    const { eventId, organizerMemberId } = await createOrganizedEvent("Double");
    await addExpense({
      eventId,
      paidByMemberId: organizerMemberId,
      totalMinor: 5000,
      participants: [{ memberId: organizerMemberId }],
    });
    await closeEvent(eventId);

    const failure = await closeEvent(eventId).then(
      () => null,
      (error: unknown) => errorCode(error),
    );
    expect(failure).toEqual({ status: 409, code: "EVENT_CLOSED" });

    const [count] = await sql<Array<{ count: string }>>`
      select count(*)::text as count from event_settlements where event_id = ${eventId}
    `;
    expect(count.count).toBe("1");
  });

  it("rejects a non-organizer close with 403 and leaves the event open", async () => {
    const { eventId } = await createOrganizedEvent("Not yours");
    await addMember(
      eventId,
      USER_B,
      "friend@example.com",
      "Friend",
      "member",
      "active",
    );

    getSessionMock.mockResolvedValue(sessionFor(USER_B, "friend@example.com"));
    const failure = await closeEvent(eventId).then(
      () => null,
      (error: unknown) => errorCode(error),
    );
    expect(failure).toEqual({ status: 403, code: "NOT_ORGANIZER" });

    const [event] = await sql<Array<{ status: string }>>`
      select status from events where id = ${eventId}
    `;
    expect(event.status).toBe("open");
  });
});

describe("closed event is read-only", () => {
  it("rejects expense, personal, void, invite and member writes with 409", async () => {
    const { eventId, organizerMemberId } =
      await createOrganizedEvent("Read only");
    const friendId = await addMember(
      eventId,
      USER_B,
      "friend@example.com",
      "Friend",
      "member",
      "active",
    );
    const pendingId = await addMember(
      eventId,
      USER_C,
      "pending@example.com",
      null,
      "member",
      "pending",
    );
    const expenseId = await addExpense({
      eventId,
      paidByMemberId: organizerMemberId,
      totalMinor: 9000,
      participants: [{ memberId: organizerMemberId }, { memberId: friendId }],
    });
    await closeEvent(eventId);

    const attempts: Array<[string, () => Promise<unknown>]> = [
      [
        "create expense",
        () =>
          createExpense(eventId, {
            totalMinor: 100,
            paidByMemberId: organizerMemberId,
            splitMode: "equal",
            participants: [{ memberId: organizerMemberId }],
          }),
      ],
      [
        "update expense",
        () => updateExpense(expenseId, { version: 1, totalMinor: 200 }),
      ],
      [
        "update personal",
        () => updatePersonal(expenseId, { personalMinor: 100 }),
      ],
      [
        "void expense",
        () => voidExpense(expenseId, { version: 1, reason: "nope" }),
      ],
      ["invite", () => inviteMember(eventId, "new@example.com")],
      ["resend/revoke invite", () => revokeInvite(eventId, pendingId)],
      ["remove member", () => removeMember(eventId, friendId)],
    ];

    for (const [label, attempt] of attempts) {
      const failure = await attempt().then(
        () => null,
        (error: unknown) => errorCode(error),
      );
      expect(failure, label).toEqual({ status: 409, code: "EVENT_CLOSED" });
    }
  });
});

describe("reopen", () => {
  it("requires confirmation, supersedes the settlement and cancels queued jobs", async () => {
    const { eventId, organizerMemberId } =
      await createOrganizedEvent("Reopen me");
    const friendId = await addMember(
      eventId,
      USER_B,
      "friend@example.com",
      "Friend",
      "member",
      "active",
    );
    await addExpense({
      eventId,
      paidByMemberId: organizerMemberId,
      totalMinor: 8000,
      participants: [{ memberId: organizerMemberId }, { memberId: friendId }],
    });
    await closeEvent(eventId);

    const unconfirmed = await reopenEvent(eventId, false).then(
      () => null,
      (error: unknown) => errorCode(error),
    );
    expect(unconfirmed).toEqual({
      status: 400,
      code: "CONFIRMATION_REQUIRED",
    });

    const reopened = await reopenEvent(eventId, true);
    expect(reopened.status).toBe("open");

    const [event] = await sql<
      Array<{ status: string; reopened_at: string | null }>
    >`
      select status, reopened_at from events where id = ${eventId}
    `;
    expect(event.status).toBe("open");
    expect(event.reopened_at).not.toBeNull();

    const [settlement] = await sql<Array<{ superseded_at: string | null }>>`
      select superseded_at from event_settlements where event_id = ${eventId}
    `;
    expect(settlement.superseded_at).not.toBeNull();

    const jobs = await sql<Array<{ status: string }>>`
      select status from notification_jobs where event_id = ${eventId}
    `;
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((job) => job.status === "cancelled")).toBe(true);

    const audit = await sql<Array<{ action: string }>>`
      select action from audit_log where event_id = ${eventId} order by created_at
    `;
    expect(audit.map((row) => row.action)).toEqual([
      "event.close",
      "event.reopen",
    ]);

    // Writes are restored, and the next close freezes a fresh version.
    await createExpense(eventId, {
      totalMinor: 2000,
      paidByMemberId: organizerMemberId,
      splitMode: "equal",
      participants: [{ memberId: organizerMemberId }, { memberId: friendId }],
    });
    const secondClose = await closeEvent(eventId);
    expect(secondClose.version).toBe(2);

    const active = await sql<
      Array<{ version: number; total_spent_minor: number }>
    >`
      select version, total_spent_minor from event_settlements
      where event_id = ${eventId} and superseded_at is null
    `;
    expect(active).toHaveLength(1);
    expect(active[0].version).toBe(2);
    expect(Number(active[0].total_spent_minor)).toBe(10000);

    const report = await getEventReport(eventId);
    expect(report.frozen).toBe(true);
    expect(report.totalSpentMinor).toBe(10000);
  });
});

describe("concurrency", () => {
  it("serializes an expense write racing close: the tally never tears", async () => {
    const { eventId, organizerMemberId } = await createOrganizedEvent("Race");
    await addExpense({
      eventId,
      paidByMemberId: organizerMemberId,
      totalMinor: 4000,
      participants: [{ memberId: organizerMemberId }],
    });

    const [closeOutcome, expenseOutcome] = await Promise.allSettled([
      closeEvent(eventId),
      createExpense(eventId, {
        totalMinor: 1000,
        paidByMemberId: organizerMemberId,
        splitMode: "equal",
        participants: [{ memberId: organizerMemberId }],
      }),
    ]);

    expect(closeOutcome.status).toBe("fulfilled");
    if (expenseOutcome.status === "rejected") {
      expect(errorCode(expenseOutcome.reason)).toEqual({
        status: 409,
        code: "EVENT_CLOSED",
      });
    }

    const [settlement] = await sql<Array<{ total_spent_minor: number }>>`
      select total_spent_minor from event_settlements
      where event_id = ${eventId} and superseded_at is null
    `;
    const [live] = await sql<Array<{ total: string; count: string }>>`
      select coalesce(sum(total_minor), 0)::text as total, count(*)::text as count
      from expenses where event_id = ${eventId} and status = 'open'
    `;

    // Whatever the interleaving, the frozen tally equals a committed set of
    // non-voided expenses: either the race winner was included, or it was
    // refused with 409 before it could be inserted.
    expect(Number(settlement.total_spent_minor)).toBe(Number(live.total));
    expect(Number(settlement.total_spent_minor)).toBeGreaterThanOrEqual(4000);
    if (expenseOutcome.status === "rejected") {
      expect(live.count).toBe("1");
    } else {
      expect(live.count).toBe("2");
    }
  });
});
