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
let route: typeof import("../../src/app/api/events/[id]/expenses/route");

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

function post(eventId: string, body: unknown): Promise<Response> {
  return route.POST(
    new Request(`http://localhost/api/events/${eventId}/expenses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: eventId }) },
  );
}

beforeAll(async () => {
  sql = postgres(url, { max: 1 });
  await sql`drop schema if exists public cascade`;
  await sql`drop schema if exists drizzle cascade`;
  await sql`create schema public`;
  const db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: "drizzle" });

  route = await import("../../src/app/api/events/[id]/expenses/route");
});

afterAll(async () => {
  await sql?.end();
  await client.end();
});

beforeEach(async () => {
  await sql`truncate table events cascade`;
  getSessionMock.mockReset();
});

describe("POST /api/events/[id]/expenses", () => {
  it("returns 401 when unauthenticated", async () => {
    getSessionMock.mockResolvedValue(null);
    const { eventId } = await createOrganizedEvent();

    const response = await post(eventId, { totalMinor: 30000 });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
  });

  it("returns 404 NOT_FOUND for a non-member", async () => {
    const { eventId } = await createOrganizedEvent();
    getSessionMock.mockResolvedValue(sessionFor(USER_B, "b@example.com"));

    const response = await post(eventId, { totalMinor: 30000 });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("returns 409 EVENT_CLOSED on a closed event", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId } = await createOrganizedEvent();
    await sql`update events set status = 'closed', closed_at = now(), closed_by = ${USER_A} where id = ${eventId}`;

    const response = await post(eventId, { totalMinor: 30000 });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("EVENT_CLOSED");
  });

  it("produces expected equal shares with a personal carve-out and writes an audit row", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const friendId = await addMember(eventId, USER_B, "friend@example.com");

    const response = await post(eventId, {
      totalMinor: 30000,
      paidByMemberId: organizerMemberId,
      splitMode: "equal",
      participants: [
        { memberId: organizerMemberId, personalMinor: 5000 },
        { memberId: friendId },
      ],
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      expense: { id: string; totalMinor: number };
      shares: Array<{ memberId: string; shareMinor: number }>;
    };
    expect(body.expense.totalMinor).toBe(30000);
    expect(body.shares).toEqual([
      { memberId: organizerMemberId, shareMinor: 17500 },
      { memberId: friendId, shareMinor: 12500 },
    ]);

    const auditRows = await sql<Array<{ action: string; entity_type: string }>>`
      select action, entity_type from audit_log where event_id = ${eventId}
    `;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "expense.create",
      entity_type: "expense",
    });
  });

  it("produces expected percentage shares (5000/3000/2000 on 1000)", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const bId = await addMember(eventId, USER_B, "b@example.com");
    const cId = await addMember(eventId, USER_C, "c@example.com");

    const response = await post(eventId, {
      totalMinor: 1000,
      splitMode: "percentage",
      participants: [
        { memberId: organizerMemberId, splitBp: 5000 },
        { memberId: bId, splitBp: 3000 },
        { memberId: cId, splitBp: 2000 },
      ],
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      shares: Array<{ memberId: string; shareMinor: number }>;
    };
    expect(body.shares).toEqual([
      { memberId: organizerMemberId, shareMinor: 500 },
      { memberId: bId, shareMinor: 300 },
      { memberId: cId, shareMinor: 200 },
    ]);
  });

  it("defaults payer, date and participants so only an amount is required", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const friendId = await addMember(eventId, USER_B, "friend@example.com");
    const pendingId = await addMember(
      eventId,
      USER_C,
      "pending@example.com",
      "pending",
    );

    const response = await post(eventId, { totalMinor: 30000 });
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      expense: {
        paidByMemberId: string;
        spentOn: string;
        splitMode: string;
        totalMinor: number;
      };
      shares: Array<{ shareMinor: number }>;
    };
    expect(body.expense.paidByMemberId).toBe(organizerMemberId);
    expect(body.expense.spentOn).toBe(new Date().toISOString().slice(0, 10));
    expect(body.expense.splitMode).toBe("equal");
    expect(body.shares.reduce((sum, share) => sum + share.shareMinor, 0)).toBe(
      body.expense.totalMinor,
    );

    const participants = await sql<Array<{ member_id: string }>>`
      select member_id from expense_participants
    `;
    expect(participants.map((row) => row.member_id).sort()).toEqual(
      [organizerMemberId, friendId, pendingId].sort(),
    );
  });

  it("ignores a client-supplied total and recomputes shares server-side", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const friendId = await addMember(eventId, USER_B, "friend@example.com");

    const response = await post(eventId, {
      totalMinor: 30000,
      total: 1,
      shares: [{ memberId: organizerMemberId, shareMinor: 1 }],
      participants: [{ memberId: organizerMemberId }, { memberId: friendId }],
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      expense: { totalMinor: number };
      shares: Array<{ shareMinor: number }>;
    };
    expect(body.expense.totalMinor).toBe(30000);
    expect(body.shares.reduce((sum, share) => sum + share.shareMinor, 0)).toBe(
      30000,
    );
  });

  it("attaches an unattached receipt owned by the creator", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId } = await createOrganizedEvent();
    const receiptRows = await sql<Array<{ id: string }>>`
      insert into receipts (event_id, uploaded_by, object_key)
      values (${eventId}, ${USER_A}, 'receipts/owned.jpg') returning id
    `;

    const response = await post(eventId, {
      totalMinor: 30000,
      receiptId: receiptRows[0].id,
    });
    expect(response.status).toBe(201);

    const attached = await sql<Array<{ expense_id: string | null }>>`
      select expense_id from receipts where id = ${receiptRows[0].id}
    `;
    expect(attached[0].expense_id).not.toBeNull();
  });

  it("rejects a receipt owned by someone else with 400 RECEIPT_INVALID", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId } = await createOrganizedEvent();
    const receiptRows = await sql<Array<{ id: string }>>`
      insert into receipts (event_id, uploaded_by, object_key)
      values (${eventId}, ${USER_B}, 'receipts/foreign.jpg') returning id
    `;

    const response = await post(eventId, {
      totalMinor: 30000,
      receiptId: receiptRows[0].id,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("RECEIPT_INVALID");
  });

  it.each([
    ["zero total", { totalMinor: 0 }, "TOTAL_NOT_POSITIVE"],
    ["negative total", { totalMinor: -1 }, "TOTAL_NOT_POSITIVE"],
    [
      "empty participants",
      { totalMinor: 30000, participants: [] },
      "EMPTY_PARTICIPANTS",
    ],
  ])("rejects %s with 400 %s", async (_label, body, code) => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId } = await createOrganizedEvent();

    const response = await post(eventId, body);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(code);
  });

  it("rejects a percentage split that does not sum to 10000 with 400 PCT_SUM_INVALID", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const friendId = await addMember(eventId, USER_B, "friend@example.com");

    const response = await post(eventId, {
      totalMinor: 1000,
      splitMode: "percentage",
      participants: [
        { memberId: organizerMemberId, splitBp: 5000 },
        { memberId: friendId, splitBp: 4000 },
      ],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("PCT_SUM_INVALID");
  });

  it("rejects a non-member payer with 400 PAYER_NOT_MEMBER", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId, organizerMemberId } = await createOrganizedEvent();

    const response = await post(eventId, {
      totalMinor: 30000,
      paidByMemberId: "ffffffff-0000-4000-8000-000000000000",
      participants: [{ memberId: organizerMemberId }],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("PAYER_NOT_MEMBER");
  });

  it("rejects a non-member participant with 400 PARTICIPANT_NOT_MEMBER", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId } = await createOrganizedEvent();

    const response = await post(eventId, {
      totalMinor: 30000,
      participants: [{ memberId: "ffffffff-0000-4000-8000-000000000000" }],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("PARTICIPANT_NOT_MEMBER");
  });

  it("rejects a personal amount larger than the total with 400 PERSONAL_EXCEEDS_TOTAL", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId, organizerMemberId } = await createOrganizedEvent();

    const response = await post(eventId, {
      totalMinor: 30000,
      participants: [{ memberId: organizerMemberId, personalMinor: 40000 }],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("PERSONAL_EXCEEDS_TOTAL");
  });

  it("rejects another member's personal amount with 400 OWN_PERSONAL_ONLY", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const friendId = await addMember(eventId, USER_B, "friend@example.com");

    const response = await post(eventId, {
      totalMinor: 30000,
      participants: [
        { memberId: organizerMemberId },
        { memberId: friendId, personalMinor: 100 },
      ],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("OWN_PERSONAL_ONLY");
  });

  it("rejects a description over 120 characters with 400 DESCRIPTION_TOO_LONG", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId } = await createOrganizedEvent();

    const response = await post(eventId, {
      totalMinor: 30000,
      description: "x".repeat(121),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("DESCRIPTION_TOO_LONG");
  });
});
