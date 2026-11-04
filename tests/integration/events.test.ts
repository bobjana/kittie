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

import { GET, POST } from "@/app/api/events/route";
import { client } from "@/db/client";
import * as schema from "@/db/schema";
import {
  createEvent,
  getEventForMember,
  listEventsForUser,
} from "@/services/events";

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

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

let sql: ReturnType<typeof postgres>;

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
});

describe("POST /api/events", () => {
  it("returns 401 when unauthenticated", async () => {
    getSessionMock.mockResolvedValue(null);
    const response = await post({ name: "Lisbon 2026" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
  });

  it("rejects a blank name with 400 NAME_REQUIRED", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const response = await post({ name: "   " });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("NAME_REQUIRED");
  });

  it("rejects an over-long name with 400 NAME_TOO_LONG", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const response = await post({ name: "x".repeat(81) });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("NAME_TOO_LONG");
  });

  it("rejects an invalid currency with 400 INVALID_CURRENCY", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const response = await post({ name: "Lisbon 2026", currency: "EURO" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("INVALID_CURRENCY");
  });

  it("rejects end-before-start with 400 ENDS_BEFORE_STARTS", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const response = await post({
      name: "Lisbon 2026",
      startsOn: "2026-11-10",
      endsOn: "2026-11-03",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("ENDS_BEFORE_STARTS");
  });

  it("creates an event with exactly one organizer member and an audit row", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "ORGANIZER@Example.COM"),
    );
    const response = await post({ name: "Lisbon 2026" });
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      event: { id: string; name: string; currency: string };
    };
    expect(body.event.name).toBe("Lisbon 2026");
    expect(body.event.currency).toBe("EUR");

    const memberRows = await sql<
      Array<{
        role: string;
        status: string;
        email_normalized: string;
        user_id: string | null;
      }>
    >`select role, status, email_normalized, user_id from event_members where event_id = ${body.event.id}`;
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]).toMatchObject({
      role: "organizer",
      status: "active",
      email_normalized: "organizer@example.com",
      user_id: USER_A,
    });

    const auditRows = await sql<
      Array<{
        action: string;
        entity_type: string;
        actor_user_id: string | null;
      }>
    >`select action, entity_type, actor_user_id from audit_log where event_id = ${body.event.id}`;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "event.create",
      entity_type: "event",
      actor_user_id: USER_A,
    });
  });
});

describe("GET /api/events", () => {
  it("returns 401 when unauthenticated", async () => {
    getSessionMock.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("lists only the current user's events", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    await createEvent({ name: "Trip A1" });
    await createEvent({ name: "Trip A2" });

    getSessionMock.mockResolvedValue(sessionFor(USER_B, "b@example.com"));
    await createEvent({ name: "Trip B" });

    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { events: Array<{ name: string }> };
    const names = body.events.map((event) => event.name).sort();
    expect(names).toEqual(["Trip A1", "Trip A2"]);
  });
});

describe("event detail access control", () => {
  it("returns the detail for the organizer with empty totals", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const created = await createEvent({
      name: "Lisbon 2026",
      currency: "EUR",
      startsOn: "2026-11-03",
      endsOn: "2026-11-08",
    });

    const detail = await getEventForMember(created.event.id);
    expect(detail.event.name).toBe("Lisbon 2026");
    expect(detail.event.status).toBe("open");
    expect(detail.event.currency).toBe("EUR");
    expect(detail.members).toHaveLength(1);
    expect(detail.members[0]?.role).toBe("organizer");
    expect(detail.totalMinor).toBe(0);
    expect(detail.yourBalanceMinor).toBe(0);
    expect(detail.expenses).toHaveLength(0);
  });

  it("returns 404 for a second user who is not a member", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const created = await createEvent({ name: "Private trip" });

    getSessionMock.mockResolvedValue(sessionFor(USER_B, "b@example.com"));
    await expect(getEventForMember(created.event.id)).rejects.toMatchObject({
      name: "AuthorizationError",
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("returns 404 for a missing event", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    await expect(
      getEventForMember("00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("returns an empty list for a user with no events", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_B, "b@example.com"));
    await expect(listEventsForUser()).resolves.toEqual([]);
  });
});
