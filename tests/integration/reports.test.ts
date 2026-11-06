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
import { computeBalances, settle } from "@/domain/settlement";
import { computeShares } from "@/domain/split";
import { AuthorizationError } from "@/lib/authorization";
import {
  getEventReport,
  listTallyEvents,
  ReportError,
  resolveTallyLanding,
  serializeSettlementSnapshot,
} from "@/services/reports";

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
const OUTSIDER = "dddddddd-0000-4000-8000-00000000000d";

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

async function createEvent(options: {
  name: string;
  updatedAt: string;
  status?: "open" | "closed";
  organizerUserId?: string;
}): Promise<string> {
  const status = options.status ?? "open";
  const rows = await sql<Array<{ id: string }>>`
    insert into events (name, organizer_user_id, currency, status, updated_at, closed_at)
    values (
      ${options.name},
      ${options.organizerUserId ?? USER_A},
      'EUR',
      ${status},
      ${options.updatedAt}::timestamptz,
      ${status === "closed" ? sql`now()` : null}
    )
    returning id
  `;
  return rows[0].id;
}

async function addMember(
  eventId: string,
  userId: string | null,
  email: string,
  displayName: string,
  role: "organizer" | "member",
  createdAt: string,
): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    insert into event_members (event_id, user_id, email_normalized, display_name, role, status, joined_at, created_at)
    values (${eventId}, ${userId}, ${email}, ${displayName}, ${role}, 'active', now(), ${createdAt}::timestamptz)
    returning id
  `;
  return rows[0].id;
}

interface SeedExpense {
  eventId: string;
  paidByMemberId: string;
  totalMinor: number;
  spentOn: string;
  splitMode: "equal" | "percentage";
  status?: "open" | "voided";
  participants: {
    memberId: string;
    personalMinor?: number;
    splitBp?: number;
  }[];
}

interface ParticipantSeed {
  memberId: string;
  personalMinor?: number;
  splitBp?: number;
}

interface ExpenseSeedInput {
  paidBy: string;
  totalMinor: number;
  splitMode: "equal" | "percentage";
  participants: ParticipantSeed[];
}

async function addExpense(input: SeedExpense): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    insert into expenses (event_id, created_by, paid_by_member_id, total_minor, currency, spent_on, split_mode, status)
    values (
      ${input.eventId},
      ${USER_A},
      ${input.paidByMemberId},
      ${input.totalMinor},
      'EUR',
      ${input.spentOn},
      ${input.splitMode},
      ${input.status ?? "open"}
    )
    returning id
  `;
  const expenseId = rows[0].id;
  for (const participant of input.participants) {
    await sql`
      insert into expense_participants (expense_id, member_id, personal_minor, split_bp)
      values (
        ${expenseId},
        ${participant.memberId},
        ${participant.personalMinor ?? 0},
        ${participant.splitBp ?? null}
      )
    `;
  }
  return expenseId;
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

describe("tally-first landing", () => {
  it("redirects to the single open event's report", async () => {
    const eventId = await createEvent({
      name: "Only trip",
      updatedAt: "2026-02-01T10:00:00Z",
    });
    await addMember(
      eventId,
      USER_A,
      "organizer@example.com",
      "Organizer",
      "organizer",
      "2026-02-01T10:00:00Z",
    );

    const events = await listTallyEvents();
    expect(events.map((event) => event.id)).toEqual([eventId]);
    expect(resolveTallyLanding(events)).toEqual({
      kind: "redirect",
      eventId,
    });
  });

  it("renders cards most-recent-first when several events are open", async () => {
    const older = await createEvent({
      name: "Older trip",
      updatedAt: "2026-01-01T10:00:00Z",
    });
    const newer = await createEvent({
      name: "Newer trip",
      updatedAt: "2026-02-01T10:00:00Z",
    });
    await addMember(
      older,
      USER_A,
      "organizer@example.com",
      "Organizer",
      "organizer",
      "2026-01-01T10:00:00Z",
    );
    await addMember(
      newer,
      USER_A,
      "organizer@example.com",
      "Organizer",
      "organizer",
      "2026-02-01T10:00:00Z",
    );

    const events = await listTallyEvents();
    expect(events.map((event) => event.id)).toEqual([newer, older]);
    const decision = resolveTallyLanding(events);
    expect(decision.kind).toBe("cards");
    if (decision.kind === "cards") {
      expect(decision.events.map((event) => event.id)).toEqual([newer, older]);
    }
  });

  it("renders the empty state when the user has no events", async () => {
    expect(await listTallyEvents()).toEqual([]);
    expect(resolveTallyLanding([])).toEqual({ kind: "empty" });
  });

  it("reads the most recent frozen report when only closed events exist", async () => {
    const older = await createEvent({
      name: "Old closed",
      updatedAt: "2026-01-01T10:00:00Z",
      status: "closed",
    });
    const newer = await createEvent({
      name: "Recent closed",
      updatedAt: "2026-03-01T10:00:00Z",
      status: "closed",
    });
    for (const [eventId, createdAt] of [
      [older, "2026-01-01T10:00:00Z"],
      [newer, "2026-01-01T10:00:00Z"],
    ] as const) {
      await addMember(
        eventId,
        USER_A,
        "organizer@example.com",
        "Organizer",
        "organizer",
        createdAt,
      );
    }

    const events = await listTallyEvents();
    expect(events.map((event) => event.id)).toEqual([newer, older]);
    expect(resolveTallyLanding(events)).toEqual({
      kind: "closed",
      eventId: newer,
    });
  });

  it("excludes pending memberships from the tally", async () => {
    const eventId = await createEvent({
      name: "Trip",
      updatedAt: "2026-02-01T10:00:00Z",
    });
    await sql`
      insert into event_members (event_id, user_id, email_normalized, display_name, role, status)
      values (${eventId}, ${USER_B}, 'pending@example.com', 'Pending', 'member', 'pending')
    `;

    expect(await listTallyEvents()).toEqual([]);
  });
});

describe("GET report data", () => {
  it("returns 404 for a non-member", async () => {
    const eventId = await createEvent({
      name: "Private trip",
      updatedAt: "2026-02-01T10:00:00Z",
    });
    await addMember(
      eventId,
      USER_A,
      "organizer@example.com",
      "Organizer",
      "organizer",
      "2026-02-01T10:00:00Z",
    );
    getSessionMock.mockResolvedValue(
      sessionFor(OUTSIDER, "outsider@example.com"),
    );

    await expect(getEventReport(eventId)).rejects.toMatchObject({
      name: "AuthorizationError",
      status: 404,
      code: "NOT_FOUND",
    });
    await expect(getEventReport(eventId)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("returns 404 for a malformed event id instead of querying Postgres", async () => {
    await expect(getEventReport("not-a-uuid")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("matches domain totals, per-member paid/share/net and transfers", async () => {
    const eventId = await createEvent({
      name: "Lisbon",
      updatedAt: "2026-02-01T10:00:00Z",
    });
    const a = await addMember(
      eventId,
      USER_A,
      "organizer@example.com",
      "Ana",
      "organizer",
      "2026-01-01T10:00:00Z",
    );
    const b = await addMember(
      eventId,
      USER_B,
      "b@example.com",
      "Bruno",
      "member",
      "2026-01-01T10:00:01Z",
    );
    const c = await addMember(
      eventId,
      USER_C,
      "c@example.com",
      "Carla",
      "member",
      "2026-01-01T10:00:02Z",
    );

    const inputs: ExpenseSeedInput[] = [
      {
        paidBy: a,
        totalMinor: 30000,
        splitMode: "equal" as const,
        participants: [
          { memberId: a, personalMinor: 5000 },
          { memberId: b },
          { memberId: c },
        ],
      },
      {
        paidBy: b,
        totalMinor: 10000,
        splitMode: "percentage" as const,
        participants: [
          { memberId: a, splitBp: 5000 },
          { memberId: b, splitBp: 3000 },
          { memberId: c, splitBp: 2000 },
        ],
      },
      {
        paidBy: c,
        totalMinor: 9999,
        splitMode: "equal" as const,
        participants: [{ memberId: a }, { memberId: b }, { memberId: c }],
      },
    ];
    for (const input of inputs) {
      await addExpense({
        eventId,
        paidByMemberId: input.paidBy,
        totalMinor: input.totalMinor,
        spentOn: "2026-02-01",
        splitMode: input.splitMode,
        status: input.totalMinor === 9999 ? "voided" : "open",
        participants: input.participants,
      });
    }

    const live = inputs.filter((input) => input.totalMinor !== 9999);
    const expectedBalances = computeBalances(
      live.map((input) => ({
        paidByMemberId: input.paidBy,
        totalMinor: input.totalMinor,
        shares: computeShares({
          totalMinor: input.totalMinor,
          mode: input.splitMode,
          participants: input.participants.map((participant) => ({
            memberId: participant.memberId,
            personalMinor: participant.personalMinor ?? 0,
            splitBp: participant.splitBp,
          })),
        }).shares.map((share) => ({
          memberId: share.memberId,
          shareMinor: share.shareMinor,
        })),
        voided: false,
      })),
    );
    const expectedTransfers = settle(expectedBalances.balances, [a, b, c]);

    const report = await getEventReport(eventId);

    expect(report.frozen).toBe(false);
    expect(report.totalSpentMinor).toBe(40000);
    expect(report.totalOwedMinor).toBe(expectedBalances.totalOwedMinor);
    expect(report.transfers).toEqual(expectedTransfers);
    expect(report.transfers.length).toBeLessThanOrEqual(2);
    expect(report.event.currency).toBe("EUR");

    const expectedMembers = [a, b, c].map((memberId) => {
      let paidMinor = 0;
      let shareMinor = 0;
      for (const input of live) {
        if (input.paidBy === memberId) paidMinor += input.totalMinor;
        const share = computeShares({
          totalMinor: input.totalMinor,
          mode: input.splitMode,
          participants: input.participants.map((participant) => ({
            memberId: participant.memberId,
            personalMinor: participant.personalMinor ?? 0,
            splitBp: participant.splitBp,
          })),
        }).shares.find((entry) => entry.memberId === memberId);
        shareMinor += share?.shareMinor ?? 0;
      }
      return {
        memberId,
        paidMinor,
        shareMinor,
        netMinor: paidMinor - shareMinor,
      };
    });
    for (const expected of expectedMembers) {
      const actual = report.members.find(
        (member) => member.memberId === expected.memberId,
      );
      expect(actual).toMatchObject(expected);
    }
    for (const member of report.members) {
      expect(member.paidMinor - member.shareMinor).toBe(member.netMinor);
    }
  });

  it("excludes voided expenses from totals and shares", async () => {
    const eventId = await createEvent({
      name: "Trip",
      updatedAt: "2026-02-01T10:00:00Z",
    });
    const a = await addMember(
      eventId,
      USER_A,
      "organizer@example.com",
      "Ana",
      "organizer",
      "2026-01-01T10:00:00Z",
    );
    const b = await addMember(
      eventId,
      USER_B,
      "b@example.com",
      "Bruno",
      "member",
      "2026-01-01T10:00:01Z",
    );
    await addExpense({
      eventId,
      paidByMemberId: a,
      totalMinor: 1000,
      spentOn: "2026-02-01",
      splitMode: "equal",
      participants: [{ memberId: a }, { memberId: b }],
    });
    await addExpense({
      eventId,
      paidByMemberId: b,
      totalMinor: 5000,
      spentOn: "2026-02-01",
      splitMode: "equal",
      status: "voided",
      participants: [{ memberId: a }, { memberId: b }],
    });

    const report = await getEventReport(eventId);
    expect(report.totalSpentMinor).toBe(1000);
    expect(report.members).toEqual([
      {
        memberId: a,
        displayName: "Ana",
        emailNormalized: "organizer@example.com",
        role: "organizer",
        paidMinor: 1000,
        shareMinor: 500,
        netMinor: 500,
      },
      {
        memberId: b,
        displayName: "Bruno",
        emailNormalized: "b@example.com",
        role: "member",
        paidMinor: 0,
        shareMinor: 500,
        netMinor: -500,
      },
    ]);
    expect(report.transfers).toEqual([
      { fromMemberId: b, toMemberId: a, amountMinor: 500 },
    ]);
  });

  it("reads the frozen snapshot after close instead of recomputing", async () => {
    const eventId = await createEvent({
      name: "Closed trip",
      updatedAt: "2026-02-01T10:00:00Z",
      status: "closed",
    });
    const a = await addMember(
      eventId,
      USER_A,
      "organizer@example.com",
      "Ana",
      "organizer",
      "2026-01-01T10:00:00Z",
    );
    const b = await addMember(
      eventId,
      USER_B,
      "b@example.com",
      "Bruno",
      "member",
      "2026-01-01T10:00:01Z",
    );
    await addExpense({
      eventId,
      paidByMemberId: a,
      totalMinor: 1000,
      spentOn: "2026-02-01",
      splitMode: "equal",
      participants: [{ memberId: a }, { memberId: b }],
    });

    const snapshot = serializeSettlementSnapshot(
      [
        {
          memberId: a,
          displayName: "Ana",
          emailNormalized: "organizer@example.com",
          role: "organizer",
          paidMinor: 1000,
          shareMinor: 500,
          netMinor: 500,
        },
        {
          memberId: b,
          displayName: "Bruno",
          emailNormalized: "b@example.com",
          role: "member",
          paidMinor: 0,
          shareMinor: 500,
          netMinor: -500,
        },
      ],
      [{ fromMemberId: b, toMemberId: a, amountMinor: 500 }],
      1000,
      500,
    );
    await sql`
      insert into event_settlements (event_id, version, total_spent_minor, balances_json, transfers_json, closed_at, closed_by)
      values (
        ${eventId},
        1,
        1000,
        ${JSON.stringify(snapshot)}::jsonb,
        ${JSON.stringify(snapshot.transfers)}::jsonb,
        now(),
        ${USER_A}
      )
    `;

    // A post-close write must not leak into the frozen report.
    await addExpense({
      eventId,
      paidByMemberId: b,
      totalMinor: 77777,
      spentOn: "2026-02-02",
      splitMode: "equal",
      participants: [{ memberId: a }, { memberId: b }],
    });

    const report = await getEventReport(eventId);
    expect(report.frozen).toBe(true);
    expect(report.event.status).toBe("closed");
    expect(report.totalSpentMinor).toBe(1000);
    expect(report.totalOwedMinor).toBe(500);
    expect(report.transfers).toEqual([
      { fromMemberId: b, toMemberId: a, amountMinor: 500 },
    ]);
    expect(
      report.members.map((member) => [member.paidMinor, member.shareMinor]),
    ).toEqual([
      [1000, 500],
      [0, 500],
    ]);
  });

  it("rejects a closed event whose frozen snapshot is missing", async () => {
    const eventId = await createEvent({
      name: "Broken close",
      updatedAt: "2026-02-01T10:00:00Z",
      status: "closed",
    });
    await addMember(
      eventId,
      USER_A,
      "organizer@example.com",
      "Organizer",
      "organizer",
      "2026-01-01T10:00:00Z",
    );

    await expect(getEventReport(eventId)).rejects.toBeInstanceOf(ReportError);
  });
});
