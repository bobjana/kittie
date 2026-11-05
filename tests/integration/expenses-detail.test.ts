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
let route: typeof import("../../src/app/api/expenses/[id]/route");
let voidRoute: typeof import("../../src/app/api/expenses/[id]/void/route");
let personalRoute: typeof import("../../src/app/api/expenses/[id]/personal/route");

async function createOrganizedEvent(
  name = "Trip",
): Promise<{ eventId: string; organizerMemberId: string }> {
  const rows = await sql<Array<{ id: string }>>`
    insert into events (name, organizer_user_id, currency)
    values (${name}, ${USER_A}, 'EUR') returning id
  `;
  const eventId = rows[0].id;
  const members = await sql<Array<{ id: string }>>`
    insert into event_members (event_id, user_id, email_normalized, display_name, role, status, joined_at)
    values (${eventId}, ${USER_A}, 'organizer@example.com', 'Organizer', 'organizer', 'active', now())
    returning id
  `;
  return { eventId, organizerMemberId: members[0].id };
}

async function addMember(
  eventId: string,
  userId: string,
  email: string,
  status: "active" | "pending" = "active",
): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    insert into event_members (event_id, user_id, email_normalized, display_name, role, status, joined_at)
    values (${eventId}, ${userId}, ${email}, 'Member', 'member', ${status}, now())
    returning id
  `;
  return rows[0].id;
}

interface CreateExpenseResult {
  expense: { id: string; version: number; totalMinor: number };
  shares: Array<{ memberId: string; shareMinor: number }>;
}

async function createExpense(
  eventId: string,
  body: Record<string, unknown>,
): Promise<CreateExpenseResult> {
  getSessionMock.mockResolvedValue(sessionFor(USER_A, "organizer@example.com"));
  const createRoute = await import(
    "../../src/app/api/events/[id]/expenses/route"
  );
  const response = await createRoute.POST(
    new Request(`http://localhost/api/events/${eventId}/expenses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: eventId }) },
  );
  if (response.status !== 201) {
    throw new Error(`createExpense failed: ${response.status}`);
  }
  return (await response.json()) as CreateExpenseResult;
}

function patchExpense(expenseId: string, body: unknown): Promise<Response> {
  return route.PATCH(
    new Request(`http://localhost/api/expenses/${expenseId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: expenseId }) },
  );
}

function voidExpense(expenseId: string, body: unknown): Promise<Response> {
  return voidRoute.POST(
    new Request(`http://localhost/api/expenses/${expenseId}/void`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: expenseId }) },
  );
}

function putPersonal(expenseId: string, body: unknown): Promise<Response> {
  return personalRoute.PUT(
    new Request(`http://localhost/api/expenses/${expenseId}/personal`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: expenseId }) },
  );
}

beforeAll(async () => {
  sql = postgres(url, { max: 1 });
  await sql`drop schema if exists public cascade`;
  await sql`drop schema if exists drizzle cascade`;
  await sql`create schema public`;
  const db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: "drizzle" });

  route = await import("../../src/app/api/expenses/[id]/route");
  voidRoute = await import("../../src/app/api/expenses/[id]/void/route");
  personalRoute = await import(
    "../../src/app/api/expenses/[id]/personal/route"
  );
});

afterAll(async () => {
  await sql?.end();
  await client.end();
});

beforeEach(async () => {
  await sql`truncate table events cascade`;
  getSessionMock.mockReset();
});

describe("PATCH /api/expenses/[id] (capturer edit)", () => {
  it("returns 401 when unauthenticated", async () => {
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const expense = await createExpense(eventId, {
      totalMinor: 30000,
      paidByMemberId: organizerMemberId,
    });
    getSessionMock.mockResolvedValue(null);

    const response = await patchExpense(expense.expense.id, {
      version: expense.expense.version,
      totalMinor: 31000,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
  });

  it("returns 404 for a non-member", async () => {
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const expense = await createExpense(eventId, {
      totalMinor: 30000,
      paidByMemberId: organizerMemberId,
    });
    getSessionMock.mockResolvedValue(sessionFor(USER_C, "c@example.com"));

    const response = await patchExpense(expense.expense.id, {
      version: expense.expense.version,
      totalMinor: 31000,
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("NOT_FOUND");
  });

  it("lets the capturer correct the total, date and description", async () => {
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const expense = await createExpense(eventId, {
      totalMinor: 30000,
      paidByMemberId: organizerMemberId,
      description: "Groceries",
    });
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );

    const response = await patchExpense(expense.expense.id, {
      version: expense.expense.version,
      totalMinor: 31000,
      description: "Groceries (with drinks)",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      expense: { totalMinor: number; version: number };
    };
    expect(body.expense.totalMinor).toBe(31000);
    expect(body.expense.version).toBe(expense.expense.version + 1);

    const stored = await sql<Array<{ description: string | null }>>`
      select description from expenses where id = ${expense.expense.id}
    `;
    expect(stored[0].description).toBe("Groceries (with drinks)");
  });

  it("rejects a stale version with 409 STALE_EXPENSE", async () => {
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const expense = await createExpense(eventId, {
      totalMinor: 30000,
      paidByMemberId: organizerMemberId,
    });
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );

    const response = await patchExpense(expense.expense.id, {
      version: expense.expense.version + 5,
      totalMinor: 31000,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("STALE_EXPENSE");
  });

  it("rejects a capturer edit on a closed event with 409 EVENT_CLOSED", async () => {
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const expense = await createExpense(eventId, {
      totalMinor: 30000,
      paidByMemberId: organizerMemberId,
    });
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    await sql`update events set status = 'closed', closed_at = now() where id = ${eventId}`;

    const response = await patchExpense(expense.expense.id, {
      version: expense.expense.version,
      totalMinor: 31000,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("EVENT_CLOSED");
  });

  it("rejects removing a participant with a personal amount with 409", async () => {
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const friendId = await addMember(eventId, USER_B, "friend@example.com");
    const expense = await createExpense(eventId, {
      totalMinor: 30000,
      paidByMemberId: organizerMemberId,
      participants: [
        { memberId: organizerMemberId, personalMinor: 5000 },
        { memberId: friendId },
      ],
    });
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );

    const response = await patchExpense(expense.expense.id, {
      version: expense.expense.version,
      participants: [{ memberId: friendId }],
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("PARTICIPANT_HAS_PERSONAL");
  });

  it("rejects a malformed body with 400", async () => {
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const expense = await createExpense(eventId, {
      totalMinor: 30000,
      paidByMemberId: organizerMemberId,
    });
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );

    const response = await patchExpense(expense.expense.id, {
      version: expense.expense.version,
      totalMinor: "not-a-number",
    });
    expect(response.status).toBe(400);
  });
});

describe("PUT /api/expenses/[id]/personal (self personal)", () => {
  it("lets a member set their own personal amount and recomputes shares", async () => {
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const friendId = await addMember(eventId, USER_B, "friend@example.com");
    const expense = await createExpense(eventId, {
      totalMinor: 30000,
      paidByMemberId: organizerMemberId,
      participants: [{ memberId: organizerMemberId }, { memberId: friendId }],
    });
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );

    const response = await putPersonal(expense.expense.id, {
      personalMinor: 5000,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      expense: { version: number };
      shares: Array<{ memberId: string; shareMinor: number }>;
    };
    expect(body.expense.version).toBe(expense.expense.version + 1);
    expect(body.shares).toEqual([
      { memberId: organizerMemberId, shareMinor: 17500 },
      { memberId: friendId, shareMinor: 12500 },
    ]);
  });

  it("rejects a personal amount exceeding the bound with 400", async () => {
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const friendId = await addMember(eventId, USER_B, "friend@example.com");
    const expense = await createExpense(eventId, {
      totalMinor: 30000,
      paidByMemberId: organizerMemberId,
      participants: [
        { memberId: organizerMemberId, personalMinor: 5000 },
        { memberId: friendId },
      ],
    });
    getSessionMock.mockResolvedValue(sessionFor(USER_B, "friend@example.com"));

    const response = await putPersonal(expense.expense.id, {
      personalMinor: 26000,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("PERSONAL_OUT_OF_BOUNDS");
  });

  it("rejects a closed event with 409", async () => {
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const friendId = await addMember(eventId, USER_B, "friend@example.com");
    const expense = await createExpense(eventId, {
      totalMinor: 30000,
      paidByMemberId: organizerMemberId,
      participants: [{ memberId: organizerMemberId }, { memberId: friendId }],
    });
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    await sql`update events set status = 'closed', closed_at = now() where id = ${eventId}`;

    const response = await putPersonal(expense.expense.id, {
      personalMinor: 1000,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("EVENT_CLOSED");
  });

  it("rejects a voided expense as read-only", async () => {
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const friendId = await addMember(eventId, USER_B, "friend@example.com");
    const expense = await createExpense(eventId, {
      totalMinor: 30000,
      paidByMemberId: organizerMemberId,
      participants: [{ memberId: organizerMemberId }, { memberId: friendId }],
    });
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    await voidExpense(expense.expense.id, { reason: "wrong amount" });

    const response = await putPersonal(expense.expense.id, {
      personalMinor: 1000,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("EXPENSE_VOIDED");
  });
});

describe("POST /api/expenses/[id]/void", () => {
  it("lets the capturer void with a reason and exclude from reports", async () => {
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const friendId = await addMember(eventId, USER_B, "friend@example.com");
    const expense = await createExpense(eventId, {
      totalMinor: 30000,
      paidByMemberId: organizerMemberId,
      participants: [{ memberId: organizerMemberId }, { memberId: friendId }],
    });
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );

    const response = await voidExpense(expense.expense.id, {
      reason: "entered the wrong amount",
    });
    expect(response.status).toBe(200);

    const stored = await sql<
      Array<{ status: string; void_reason: string | null }>
    >`
      select status, void_reason from expenses where id = ${expense.expense.id}
    `;
    expect(stored[0].status).toBe("voided");
    expect(stored[0].void_reason).toBe("entered the wrong amount");

    const { listReportExpenses } = await import("../../src/services/expenses");
    const report = await listReportExpenses(eventId);
    expect(report.find((row) => row.id === expense.expense.id)).toBeUndefined();
  });

  it("rejects a void without a reason with 400", async () => {
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const expense = await createExpense(eventId, {
      totalMinor: 30000,
      paidByMemberId: organizerMemberId,
    });
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );

    const response = await voidExpense(expense.expense.id, { reason: "" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("VOID_REASON_INVALID");
  });

  it("rejects a void on a closed event with 409", async () => {
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const expense = await createExpense(eventId, {
      totalMinor: 30000,
      paidByMemberId: organizerMemberId,
    });
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    await sql`update events set status = 'closed', closed_at = now() where id = ${eventId}`;

    const response = await voidExpense(expense.expense.id, {
      reason: "late void",
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("EVENT_CLOSED");
  });

  it("rejects a second void as read-only", async () => {
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const expense = await createExpense(eventId, {
      totalMinor: 30000,
      paidByMemberId: organizerMemberId,
    });
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    await voidExpense(expense.expense.id, { reason: "wrong amount" });

    const response = await voidExpense(expense.expense.id, {
      reason: "double void",
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("EXPENSE_VOIDED");
  });

  it("rejects a void by a non-capturer non-organizer with 403", async () => {
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    await addMember(eventId, USER_B, "friend@example.com");
    const expense = await createExpense(eventId, {
      totalMinor: 30000,
      paidByMemberId: organizerMemberId,
    });
    getSessionMock.mockResolvedValue(sessionFor(USER_B, "friend@example.com"));

    const response = await voidExpense(expense.expense.id, {
      reason: "unauthorized void",
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("NOT_ORGANIZER");
  });
});
