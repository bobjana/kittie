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

process.env.DATABASE_URL = "postgres://kittie:kittie@localhost:5433/kittie";
process.env.BETTER_AUTH_SECRET =
  "test-secret-0123456789abcdef0123456789abcdef0123";
process.env.APP_URL = "http://localhost:3100";
process.env.BETTER_AUTH_URL = "http://localhost:3100";
process.env.EMAIL_FROM = "Kittie <kittie@localhost>";
process.env.EMAIL_DRIVER = "fake";
process.env.COOKIE_SECURE = "false";

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
const USER_D = "dddddddd-0000-4000-8000-00000000000d";

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
let memberRoute: typeof import("../../src/app/api/events/[id]/members/[memberId]/route");
let getMembersPageData: typeof import("@/services/invites").getMembersPageData;

async function createOrganizedEvent(
  name = "Trip",
): Promise<{ eventId: string; organizerMemberId: string }> {
  const rows = await sql<Array<{ id: string }>>`
    insert into events (name, organizer_user_id) values (${name}, ${USER_A}) returning id
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

async function addExpense(
  eventId: string,
  paidByMemberId: string | null,
  participantIds: string[],
  status: "open" | "voided" = "open",
): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    insert into expenses (event_id, created_by, paid_by_member_id, total_minor, currency, spent_on, split_mode, status, voided_at)
    values (${eventId}, ${USER_A}, ${paidByMemberId}, 100, 'EUR', '2026-11-04', 'equal', ${status}, ${status === "voided" ? sql`now()` : null})
    returning id
  `;
  const expenseId = rows[0].id;
  for (const memberId of participantIds) {
    await sql`
      insert into expense_participants (expense_id, member_id, personal_minor)
      values (${expenseId}, ${memberId}, 0)
    `;
  }
  return expenseId;
}

function remove(eventId: string, memberId: string): Promise<Response> {
  return memberRoute.DELETE(
    new Request(`http://localhost/api/events/${eventId}/members/${memberId}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id: eventId, memberId }) },
  );
}

beforeAll(async () => {
  sql = postgres(url, { max: 1 });
  await sql`drop schema if exists public cascade`;
  await sql`drop schema if exists drizzle cascade`;
  await sql`create schema public`;
  const db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: "drizzle" });

  memberRoute = await import(
    "../../src/app/api/events/[id]/members/[memberId]/route"
  );
  ({ getMembersPageData } = await import("@/services/invites"));
});

afterAll(async () => {
  await sql?.end();
  await client.end();
});

beforeEach(async () => {
  await sql`truncate table events cascade`;
  getSessionMock.mockReset();
});

describe("DELETE /api/events/[id]/members/[memberId]", () => {
  it("returns 401 when unauthenticated", async () => {
    getSessionMock.mockResolvedValue(null);
    const { eventId } = await createOrganizedEvent();
    const friendId = await addMember(eventId, USER_B, "friend@example.com");

    const response = await remove(eventId, friendId);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
  });

  it("removes an accepted member with no expense references and keeps a tombstone", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId } = await createOrganizedEvent();
    const friendId = await addMember(eventId, USER_B, "friend@example.com");

    const response = await remove(eventId, friendId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const rows = await sql<Array<{ status: string; role: string }>>`
      select status, role from event_members where id = ${friendId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "removed", role: "member" });

    const auditRows = await sql<
      Array<{
        action: string;
        entity_type: string;
        entity_id: string;
        actor_user_id: string | null;
      }>
    >`select action, entity_type, entity_id, actor_user_id from audit_log where entity_id = ${friendId}`;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "member.remove",
      entity_type: "member",
      entity_id: friendId,
      actor_user_id: USER_A,
    });

    const page = await getMembersPageData(eventId);
    expect(page.activeMembers.map((member) => member.id)).not.toContain(
      friendId,
    );
  });

  it("returns 403 NOT_ORGANIZER for a non-organizer and leaves the target active", async () => {
    const { eventId } = await createOrganizedEvent();
    await addMember(eventId, USER_B, "member@example.com");
    const friendId = await addMember(eventId, USER_C, "friend@example.com");
    getSessionMock.mockResolvedValue(sessionFor(USER_B, "member@example.com"));

    const response = await remove(eventId, friendId);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "NOT_ORGANIZER" });

    const rows = await sql<Array<{ status: string }>>`
      select status from event_members where id = ${friendId}
    `;
    expect(rows[0].status).toBe("active");
  });

  it("returns 409 MEMBER_HAS_EXPENSES when the member is a non-voided payer", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const friendId = await addMember(eventId, USER_B, "friend@example.com");
    await addExpense(eventId, friendId, [organizerMemberId, friendId]);

    const response = await remove(eventId, friendId);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("MEMBER_HAS_EXPENSES");

    const rows = await sql<Array<{ status: string }>>`
      select status from event_members where id = ${friendId}
    `;
    expect(rows[0].status).toBe("active");
  });

  it("returns 409 MEMBER_HAS_EXPENSES when the member is a non-voided participant", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const friendId = await addMember(eventId, USER_B, "friend@example.com");
    await addExpense(eventId, organizerMemberId, [organizerMemberId, friendId]);

    const response = await remove(eventId, friendId);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("MEMBER_HAS_EXPENSES");
  });

  it("removes a member referenced only by a voided expense", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const friendId = await addMember(eventId, USER_B, "friend@example.com");
    await addExpense(
      eventId,
      friendId,
      [organizerMemberId, friendId],
      "voided",
    );

    const response = await remove(eventId, friendId);
    expect(response.status).toBe(200);

    const rows = await sql<Array<{ status: string }>>`
      select status from event_members where id = ${friendId}
    `;
    expect(rows[0].status).toBe("removed");
  });

  it("returns 409 CANNOT_REMOVE_SELF for the organizer", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId, organizerMemberId } = await createOrganizedEvent();

    const response = await remove(eventId, organizerMemberId);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("CANNOT_REMOVE_SELF");

    const rows = await sql<Array<{ status: string }>>`
      select status from event_members where id = ${organizerMemberId}
    `;
    expect(rows[0].status).toBe("active");
  });

  it("returns 404 for a malformed member id instead of a 500", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId } = await createOrganizedEvent();

    const response = await remove(eventId, "not-a-uuid");
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("NOT_FOUND");
  });

  it("returns 404 for a member of another event", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId } = await createOrganizedEvent();
    const other = await createOrganizedEvent("Other Trip");
    const outsiderId = await addMember(
      other.eventId,
      USER_D,
      "outsider@example.com",
    );

    const response = await remove(eventId, outsiderId);
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("NOT_FOUND");

    const rows = await sql<Array<{ status: string }>>`
      select status from event_members where id = ${outsiderId}
    `;
    expect(rows[0].status).toBe("active");
  });

  it("returns a named 409 ALREADY_REMOVED instead of a 500 on a repeat call", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId } = await createOrganizedEvent();
    const friendId = await addMember(eventId, USER_B, "friend@example.com");

    expect((await remove(eventId, friendId)).status).toBe(200);
    const second = await remove(eventId, friendId);
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("ALREADY_REMOVED");
  });

  it("revokes a pending invite and tombstones the pending member", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId } = await createOrganizedEvent();
    const pendingId = await addMember(
      eventId,
      USER_B,
      "pending@example.com",
      "pending",
    );
    await sql`
      insert into event_invites (event_id, member_id, token_hash, email_normalized, expires_at, created_by)
      values (${eventId}, ${pendingId}, ${"a".repeat(64)}, 'pending@example.com', now() + interval '7 days', ${USER_A})
    `;

    const response = await remove(eventId, pendingId);
    expect(response.status).toBe(200);

    const memberRows = await sql<Array<{ status: string }>>`
      select status from event_members where id = ${pendingId}
    `;
    expect(memberRows[0].status).toBe("removed");

    const inviteRows = await sql<Array<{ revoked_at: Date | null }>>`
      select revoked_at from event_invites where member_id = ${pendingId}
    `;
    expect(inviteRows[0].revoked_at).not.toBeNull();
  });

  it("returns 409 MEMBER_HAS_EXPENSES for a pending member referenced by an expense", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId, organizerMemberId } = await createOrganizedEvent();
    const pendingId = await addMember(
      eventId,
      USER_B,
      "pending@example.com",
      "pending",
    );
    await addExpense(eventId, organizerMemberId, [
      organizerMemberId,
      pendingId,
    ]);

    const response = await remove(eventId, pendingId);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("MEMBER_HAS_EXPENSES");
  });

  it("returns 409 EVENT_CLOSED on a closed event", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const { eventId } = await createOrganizedEvent();
    const friendId = await addMember(eventId, USER_B, "friend@example.com");
    await sql`update events set status = 'closed', closed_at = now(), closed_by = ${USER_A} where id = ${eventId}`;

    const response = await remove(eventId, friendId);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("EVENT_CLOSED");

    const rows = await sql<Array<{ status: string }>>`
      select status from event_members where id = ${friendId}
    `;
    expect(rows[0].status).toBe("active");
  });
});
