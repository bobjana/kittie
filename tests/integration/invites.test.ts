import { createHash } from "node:crypto";
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
const FRIEND = "cccccccc-0000-4000-8000-00000000000c";

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
let inviteRoute: typeof import("../../src/app/api/events/[id]/invites/route");
let revokeRoute: typeof import("../../src/app/api/events/[id]/invites/[memberId]/route");
let resendRoute: typeof import("../../src/app/api/events/[id]/invites/[memberId]/resend/route");
let acceptRoute: typeof import("../../src/app/api/invites/[token]/accept/route");
let fakeEmail: typeof import("../../src/lib/email/fake");

function inviteRequest(eventId: string, email: string): Request {
  return new Request(`http://localhost/api/events/${eventId}/invites`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

function postRequest(url: string): Request {
  return new Request(url, { method: "POST" });
}

function tokenFromLastEmail(): string {
  const latest = fakeEmail.lastEmail();
  if (!latest) {
    throw new Error("no email sent");
  }
  const match = /\/invite\/([A-Za-z0-9_-]+)/.exec(latest.text);
  if (!match) {
    throw new Error("no invite link found in the latest email");
  }
  return match[1];
}

async function createOrganizedEvent(name = "Trip"): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    insert into events (name, organizer_user_id) values (${name}, ${USER_A}) returning id
  `;
  const eventId = rows[0].id;
  await sql`
    insert into event_members (event_id, user_id, email_normalized, display_name, role, status, joined_at)
    values (${eventId}, ${USER_A}, 'organizer@example.com', 'Organizer', 'organizer', 'active', now())
  `;
  return eventId;
}

async function addActiveMember(
  eventId: string,
  userId: string,
  email: string,
): Promise<void> {
  await sql`
    insert into event_members (event_id, user_id, email_normalized, display_name, role, status, joined_at)
    values (${eventId}, ${userId}, ${email}, 'Member', 'member', 'active', now())
  `;
}

async function pendingMemberId(
  eventId: string,
  email: string,
): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    select id from event_members where event_id = ${eventId} and email_normalized = ${email}
  `;
  return rows[0].id;
}

beforeAll(async () => {
  sql = postgres(url, { max: 1 });
  await sql`drop schema if exists public cascade`;
  await sql`drop schema if exists drizzle cascade`;
  await sql`create schema public`;
  const db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: "drizzle" });

  inviteRoute = await import("../../src/app/api/events/[id]/invites/route");
  revokeRoute = await import(
    "../../src/app/api/events/[id]/invites/[memberId]/route"
  );
  resendRoute = await import(
    "../../src/app/api/events/[id]/invites/[memberId]/resend/route"
  );
  acceptRoute = await import("../../src/app/api/invites/[token]/accept/route");
  fakeEmail = await import("../../src/lib/email/fake");
});

afterAll(async () => {
  await sql?.end();
  await client.end();
});

beforeEach(async () => {
  await sql`truncate table events cascade`;
  getSessionMock.mockReset();
  fakeEmail.clearSentEmails();
});

describe("POST /api/events/[id]/invites", () => {
  it("returns 401 when unauthenticated", async () => {
    getSessionMock.mockResolvedValue(null);
    const eventId = await createOrganizedEvent();
    const response = await inviteRoute.POST(
      inviteRequest(eventId, "friend@example.com"),
      {
        params: Promise.resolve({ id: eventId }),
      },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
  });

  it("returns 403 NOT_ORGANIZER for a non-organizer member", async () => {
    const eventId = await createOrganizedEvent();
    await addActiveMember(eventId, USER_B, "member@example.com");
    getSessionMock.mockResolvedValue(sessionFor(USER_B, "member@example.com"));

    const response = await inviteRoute.POST(
      inviteRequest(eventId, "friend@example.com"),
      {
        params: Promise.resolve({ id: eventId }),
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "NOT_ORGANIZER" });
  });

  it("rejects a malformed email with 400 INVALID_EMAIL", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const eventId = await createOrganizedEvent();

    const response = await inviteRoute.POST(
      inviteRequest(eventId, "not-an-email"),
      {
        params: Promise.resolve({ id: eventId }),
      },
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("INVALID_EMAIL");
  });

  it("invites a friend, stores only the token hash, and sends one email", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const eventId = await createOrganizedEvent();

    const response = await inviteRoute.POST(
      inviteRequest(eventId, "Friend@Example.com"),
      { params: Promise.resolve({ id: eventId }) },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      member: { emailNormalized: string; status: string };
      invite: { emailNormalized: string };
    };
    expect(body.member).toMatchObject({
      emailNormalized: "friend@example.com",
      status: "pending",
    });
    expect(body.invite.emailNormalized).toBe("friend@example.com");

    const members = await sql<Array<{ status: string }>>`
      select status from event_members where event_id = ${eventId} and email_normalized = 'friend@example.com'
    `;
    expect(members).toHaveLength(1);
    expect(members[0].status).toBe("pending");

    const token = tokenFromLastEmail();
    const invites = await sql<Array<{ token_hash: string }>>`
      select token_hash from event_invites where email_normalized = 'friend@example.com'
    `;
    expect(invites).toHaveLength(1);
    const expectedHash = createHash("sha256").update(token).digest("hex");
    expect(invites[0].token_hash).toBe(expectedHash);
    expect(invites[0].token_hash).not.toBe(token);

    expect(fakeEmail.getSentEmails()).toHaveLength(1);
  });

  it("refreshes a duplicate invite instead of duplicating the member", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const eventId = await createOrganizedEvent();

    const first = await inviteRoute.POST(
      inviteRequest(eventId, "friend@example.com"),
      { params: Promise.resolve({ id: eventId }) },
    );
    expect(first.status).toBe(201);
    const second = await inviteRoute.POST(
      inviteRequest(eventId, "friend@example.com"),
      { params: Promise.resolve({ id: eventId }) },
    );
    expect(second.status).toBe(201);

    const members = await sql<Array<{ n: number }>>`
      select count(*)::int as n from event_members where event_id = ${eventId} and email_normalized = 'friend@example.com'
    `;
    expect(members[0].n).toBe(1);

    const invites = await sql<Array<{ revoked_at: Date | null }>>`
      select revoked_at from event_invites where email_normalized = 'friend@example.com' order by created_at asc
    `;
    expect(invites).toHaveLength(2);
    expect(invites[0].revoked_at).not.toBeNull();
    expect(invites[1].revoked_at).toBeNull();
    expect(fakeEmail.getSentEmails()).toHaveLength(2);
  });
});

describe("POST /api/events/[id]/invites/[memberId]/resend", () => {
  it("invalidates the old token and sends a new one", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const eventId = await createOrganizedEvent();
    await inviteRoute.POST(inviteRequest(eventId, "friend@example.com"), {
      params: Promise.resolve({ id: eventId }),
    });
    const oldToken = tokenFromLastEmail();
    const memberId = await pendingMemberId(eventId, "friend@example.com");

    const response = await resendRoute.POST(
      postRequest("http://localhost/api/events/x/invites/y/resend"),
      { params: Promise.resolve({ id: eventId, memberId }) },
    );
    expect(response.status).toBe(200);

    const newToken = tokenFromLastEmail();
    expect(newToken).not.toBe(oldToken);

    const invites = await sql<Array<{ revoked_at: Date | null }>>`
      select revoked_at from event_invites where member_id = ${memberId} order by created_at asc
    `;
    expect(invites).toHaveLength(2);
    expect(invites[0].revoked_at).not.toBeNull();
    expect(invites[1].revoked_at).toBeNull();

    getSessionMock.mockResolvedValue(sessionFor(FRIEND, "friend@example.com"));
    const staleAccept = await acceptRoute.POST(
      postRequest("http://localhost/api/invites/x/accept"),
      { params: Promise.resolve({ token: oldToken }) },
    );
    expect(staleAccept.status).toBe(410);
    expect((await staleAccept.json()).error).toBe("INVITE_REVOKED");
  });
});

describe("DELETE /api/events/[id]/invites/[memberId]", () => {
  it("revokes the invite and tombstones the member; re-invite makes a new row", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const eventId = await createOrganizedEvent();
    await inviteRoute.POST(inviteRequest(eventId, "friend@example.com"), {
      params: Promise.resolve({ id: eventId }),
    });
    const memberId = await pendingMemberId(eventId, "friend@example.com");

    const response = await revokeRoute.DELETE(
      postRequest("http://localhost/api/events/x/invites/y"),
      { params: Promise.resolve({ id: eventId, memberId }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const revoked = await sql<Array<{ status: string }>>`
      select status from event_members where id = ${memberId}
    `;
    expect(revoked[0].status).toBe("removed");

    const reInvite = await inviteRoute.POST(
      inviteRequest(eventId, "friend@example.com"),
      { params: Promise.resolve({ id: eventId }) },
    );
    expect(reInvite.status).toBe(201);

    const members = await sql<Array<{ id: string; status: string }>>`
      select id, status from event_members where event_id = ${eventId} and email_normalized = 'friend@example.com' order by created_at asc
    `;
    expect(members).toHaveLength(2);
    expect(members[0].status).toBe("removed");
    expect(members[1].status).toBe("pending");
    expect(members[1].id).not.toBe(members[0].id);
  });
});

describe("POST /api/invites/[token]/accept", () => {
  it("rejects a malformed token with 404", async () => {
    getSessionMock.mockResolvedValue(sessionFor(FRIEND, "friend@example.com"));
    const response = await acceptRoute.POST(
      postRequest("http://localhost/api/invites/x/accept"),
      { params: Promise.resolve({ token: "!!bad!!" }) },
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("INVITE_NOT_FOUND");
  });

  it("rejects an expired token with 410 INVITE_EXPIRED", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const eventId = await createOrganizedEvent();
    await inviteRoute.POST(inviteRequest(eventId, "friend@example.com"), {
      params: Promise.resolve({ id: eventId }),
    });
    const token = tokenFromLastEmail();

    await sql`update event_invites set expires_at = now() - interval '1 hour' where email_normalized = 'friend@example.com'`;

    getSessionMock.mockResolvedValue(sessionFor(FRIEND, "friend@example.com"));
    const response = await acceptRoute.POST(
      postRequest("http://localhost/api/invites/x/accept"),
      { params: Promise.resolve({ token }) },
    );
    expect(response.status).toBe(410);
    expect((await response.json()).error).toBe("INVITE_EXPIRED");
  });

  it("rejects a wrong-email session with 403 EMAIL_MISMATCH", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const eventId = await createOrganizedEvent();
    await inviteRoute.POST(inviteRequest(eventId, "friend@example.com"), {
      params: Promise.resolve({ id: eventId }),
    });
    const token = tokenFromLastEmail();

    getSessionMock.mockResolvedValue(
      sessionFor(USER_B, "someoneelse@example.com"),
    );
    const response = await acceptRoute.POST(
      postRequest("http://localhost/api/invites/x/accept"),
      { params: Promise.resolve({ token }) },
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("EMAIL_MISMATCH");
  });

  it("activates the member and preserves the pending personal amount at 0", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const eventId = await createOrganizedEvent();
    await inviteRoute.POST(inviteRequest(eventId, "friend@example.com"), {
      params: Promise.resolve({ id: eventId }),
    });
    const token = tokenFromLastEmail();
    const memberId = await pendingMemberId(eventId, "friend@example.com");

    const expenseRows = await sql<Array<{ id: string }>>`
      insert into expenses (event_id, created_by, total_minor, currency, spent_on, split_mode, status)
      values (${eventId}, ${USER_A}, 100, 'EUR', '2026-11-04', 'equal', 'open')
      returning id
    `;
    await sql`
      insert into expense_participants (expense_id, member_id, personal_minor)
      values (${expenseRows[0].id}, ${memberId}, 0)
    `;

    getSessionMock.mockResolvedValue(sessionFor(FRIEND, "friend@example.com"));
    const response = await acceptRoute.POST(
      postRequest("http://localhost/api/invites/x/accept"),
      { params: Promise.resolve({ token }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, eventId });

    const member = await sql<
      Array<{ user_id: string | null; status: string; joined_at: Date | null }>
    >`
      select user_id, status, joined_at from event_members where id = ${memberId}
    `;
    expect(member[0].status).toBe("active");
    expect(member[0].user_id).toBe(FRIEND);
    expect(member[0].joined_at).not.toBeNull();

    const invite = await sql<Array<{ accepted_at: Date | null }>>`
      select accepted_at from event_invites where member_id = ${memberId}
    `;
    expect(invite[0].accepted_at).not.toBeNull();

    const participant = await sql<Array<{ personal_minor: number }>>`
      select personal_minor::int as personal_minor from expense_participants where expense_id = ${expenseRows[0].id} and member_id = ${memberId}
    `;
    expect(participant[0].personal_minor).toBe(0);
  });
});

describe("GET /api/events/[id]/invites", () => {
  it("lists pending invites for the organizer", async () => {
    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const eventId = await createOrganizedEvent();
    await inviteRoute.POST(inviteRequest(eventId, "friend@example.com"), {
      params: Promise.resolve({ id: eventId }),
    });

    const response = await inviteRoute.GET(
      postRequest("http://localhost/api/events/x/invites"),
      { params: Promise.resolve({ id: eventId }) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      invites: Array<{ emailNormalized: string; status: string }>;
    };
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0]).toMatchObject({
      emailNormalized: "friend@example.com",
      status: "pending",
    });
  });
});
