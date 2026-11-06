import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

// The app parses env at import time; force the in-memory email driver before
// any service module is imported so invites never reach the shared Mailpit.
process.env.EMAIL_DRIVER = "fake";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error("TEST_DATABASE_URL is not set");
}

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((target: string) => {
    throw new Error(`NEXT_REDIRECT:${target}`);
  }),
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: getSessionMock } },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  notFound: navigation.notFound,
  redirect: navigation.redirect,
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({
      href,
      children,
      ...rest
    }: {
      href: string;
      children: ReactNode;
    } & Record<string, unknown>) =>
      React.createElement("a", { href, ...rest }, children),
  };
});

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

let getEventHistory: typeof import("@/services/audit").getEventHistory;
let writeAudit: typeof import("@/services/audit").writeAudit;
let AuthorizationError: typeof import("@/lib/authorization").AuthorizationError;
let createEvent: typeof import("@/services/events").createEvent;
let createExpense: typeof import("@/services/expenses").createExpense;
let updateExpense: typeof import("@/services/expenses").updateExpense;
let updatePersonal: typeof import("@/services/expenses").updatePersonal;
let voidExpense: typeof import("@/services/expenses").voidExpense;
let inviteMember: typeof import("@/services/invites").inviteMember;
let resendInvite: typeof import("@/services/invites").resendInvite;
let revokeInvite: typeof import("@/services/invites").revokeInvite;
let acceptInvite: typeof import("@/services/invites").acceptInvite;
let removeMember: typeof import("@/services/members").removeMember;
let closeEvent: typeof import("@/services/settlements").closeEvent;
let reopenEvent: typeof import("@/services/settlements").reopenEvent;

async function addMember(
  eventId: string,
  userId: string | null,
  email: string,
  displayName: string | null,
  status: "active" | "pending",
): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    insert into event_members (event_id, user_id, email_normalized, display_name, role, status, joined_at)
    values (
      ${eventId},
      ${userId},
      ${email},
      ${displayName},
      'member',
      ${status},
      ${status === "active" ? sql`now()` : null}
    )
    returning id
  `;
  return rows[0].id;
}

function inviteToken(latestText: string): string {
  const match = /\/invite\/([A-Za-z0-9_-]+)/.exec(latestText);
  if (!match) {
    throw new Error("no invite link in the latest email");
  }
  return match[1];
}

interface AuditRow {
  action: string;
  actor_user_id: string | null;
  entity_type: string;
  entity_id: string;
  before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
}

async function auditRows(eventId: string): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    select action, actor_user_id, entity_type, entity_id, before_json, after_json
    from audit_log
    where event_id = ${eventId}
    order by created_at asc, id asc
  `;
}

beforeAll(async () => {
  sql = postgres(url, { max: 1 });
  await sql`drop schema if exists public cascade`;
  await sql`drop schema if exists drizzle cascade`;
  await sql`create schema public`;
  const db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: "drizzle" });

  ({ getEventHistory, writeAudit } = await import("@/services/audit"));
  ({ AuthorizationError } = await import("@/lib/authorization"));
  ({ createEvent } = await import("@/services/events"));
  ({ createExpense, updateExpense, updatePersonal, voidExpense } = await import(
    "@/services/expenses"
  ));
  ({ inviteMember, resendInvite, revokeInvite, acceptInvite } = await import(
    "@/services/invites"
  ));
  ({ removeMember } = await import("@/services/members"));
  ({ closeEvent, reopenEvent } = await import("@/services/settlements"));
});

afterAll(async () => {
  await sql?.end();
  await client.end();
});

beforeEach(async () => {
  await sql`truncate table events cascade`;
  await sql`truncate table request_throttle`;
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue(sessionFor(USER_A, "organizer@example.com"));
  navigation.notFound.mockClear();
});

describe("money audit trail", () => {
  it("writes exactly one row per money-affecting action with actor and before/after, and renders history in order", async () => {
    const { event } = await createEvent({ name: "Audit trip" });
    const eventId = event.id;
    const brunoId = await addMember(
      eventId,
      USER_B,
      "bruno@example.com",
      "Bruno",
      "active",
    );
    const organizerRow = await sql<Array<{ id: string }>>`
      select id from event_members where event_id = ${eventId} and user_id = ${USER_A}
    `;
    const organizerId = organizerRow[0].id;

    const created = await createExpense(eventId, {
      totalMinor: 40000,
      spentOn: "2026-11-01",
      description: "Dinner",
      paidByMemberId: organizerId,
      splitMode: "equal",
      participants: [
        { memberId: organizerId, personalMinor: 5000 },
        { memberId: brunoId },
      ],
    });

    getSessionMock.mockResolvedValue(sessionFor(USER_B, "bruno@example.com"));
    await updatePersonal(created.expense.id, { personalMinor: 2000 });

    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    await updateExpense(created.expense.id, {
      version: 2,
      totalMinor: 50000,
      description: "Dinner and drinks",
    });
    await voidExpense(created.expense.id, { reason: "duplicate receipt" });

    const friend = await inviteMember(eventId, "friend@example.com");
    await resendInvite(eventId, friend.member.id);
    await revokeInvite(eventId, friend.member.id);

    const fakeEmail = await import("@/lib/email/fake");
    await inviteMember(eventId, "carol@example.com");
    const token = inviteToken(fakeEmail.lastEmail()?.text ?? "");
    getSessionMock.mockResolvedValue(sessionFor(USER_C, "carol@example.com"));
    await acceptInvite(token);

    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const eve = await inviteMember(eventId, "eve@example.com");
    await removeMember(eventId, eve.member.id);

    await closeEvent(eventId);
    await reopenEvent(eventId, true);
    await removeMember(eventId, brunoId);

    const rows = await auditRows(eventId);
    expect(rows).toHaveLength(15);

    const byAction = (action: string) =>
      rows.filter((row) => row.action === action);
    expect(byAction("event.create")).toHaveLength(1);
    expect(byAction("expense.create")).toHaveLength(1);
    expect(byAction("expense.update")).toHaveLength(1);
    expect(byAction("expense.personal_update")).toHaveLength(1);
    expect(byAction("expense.void")).toHaveLength(1);
    expect(byAction("invite.create")).toHaveLength(3);
    expect(byAction("invite.resend")).toHaveLength(1);
    expect(byAction("invite.revoke")).toHaveLength(1);
    expect(byAction("member.accept_invite")).toHaveLength(1);
    expect(byAction("member.remove")).toHaveLength(2);
    expect(byAction("event.close")).toHaveLength(1);
    expect(byAction("event.reopen")).toHaveLength(1);

    const actorOf = (action: string) => byAction(action)[0].actor_user_id;
    expect(actorOf("expense.create")).toBe(USER_A);
    expect(actorOf("expense.update")).toBe(USER_A);
    expect(actorOf("expense.personal_update")).toBe(USER_B);
    expect(actorOf("expense.void")).toBe(USER_A);
    expect(actorOf("invite.create")).toBe(USER_A);
    expect(actorOf("member.accept_invite")).toBe(USER_C);
    expect(actorOf("member.remove")).toBe(USER_A);
    expect(actorOf("event.close")).toBe(USER_A);
    expect(actorOf("event.reopen")).toBe(USER_A);

    expect(byAction("expense.update")[0].before_json).toMatchObject({
      totalMinor: 40000,
    });
    expect(byAction("expense.update")[0].after_json).toMatchObject({
      totalMinor: 50000,
    });
    expect(byAction("expense.personal_update")[0].before_json).toMatchObject({
      memberId: brunoId,
      personalMinor: 0,
    });
    expect(byAction("expense.personal_update")[0].after_json).toMatchObject({
      memberId: brunoId,
      personalMinor: 2000,
    });
    expect(byAction("expense.void")[0].before_json).toMatchObject({
      status: "open",
      totalMinor: 50000,
    });
    expect(byAction("expense.void")[0].after_json).toMatchObject({
      status: "voided",
      totalMinor: 50000,
      voidReason: "duplicate receipt",
    });
    expect(byAction("event.close")[0].before_json).toMatchObject({
      status: "open",
    });
    expect(byAction("event.close")[0].after_json).toMatchObject({
      status: "closed",
      totalSpentMinor: 0,
    });
    expect(byAction("event.reopen")[0].before_json).toMatchObject({
      status: "closed",
    });
    expect(byAction("event.reopen")[0].after_json).toMatchObject({
      status: "open",
    });

    const history = await getEventHistory(eventId);
    expect(history.event).toMatchObject({
      id: eventId,
      name: "Audit trip",
      currency: "EUR",
    });
    expect(history.entries).toHaveLength(15);
    const timestamps = history.entries.map((entry) => entry.createdAt);
    expect(timestamps).toEqual([...timestamps].sort());

    const personalIndex = history.entries.findIndex(
      (entry) => entry.action === "expense.personal_update",
    );
    const voidIndex = history.entries.findIndex(
      (entry) => entry.action === "expense.void",
    );
    expect(personalIndex).toBeGreaterThanOrEqual(0);
    expect(voidIndex).toBeGreaterThan(personalIndex);

    const personal = history.entries[personalIndex];
    expect(personal.actorName).toBe("Bruno");
    expect(personal.title).toBe("Changed a personal amount");
    expect(personal.changes).toContainEqual({
      label: "Personal · Bruno",
      before: "€0.00",
      after: "€20.00",
    });

    const voided = history.entries[voidIndex];
    expect(voided.title).toBe("Voided an expense");
    expect(voided.actorName).toBe("Test User");
    expect(voided.changes).toContainEqual({
      label: "Status",
      before: "Open",
      after: "Voided",
    });
    expect(voided.changes).toContainEqual({
      label: "Reason",
      before: null,
      after: "duplicate receipt",
    });

    const edited = history.entries.find(
      (entry) => entry.action === "expense.update",
    );
    expect(edited?.changes).toContainEqual({
      label: "Total",
      before: "€400.00",
      after: "€500.00",
    });

    const page = await import("../../src/app/(app)/events/[id]/history/page");
    // A removed member still has their audit rows, but can no longer read them.
    getSessionMock.mockResolvedValue(sessionFor(USER_B, "bruno@example.com"));
    await expect(getEventHistory(eventId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      page.default({ params: Promise.resolve({ id: eventId }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const html = renderToStaticMarkup(
      await page.default({ params: Promise.resolve({ id: eventId }) }),
    );
    expect(html).toContain("Bruno");
    expect(html).toContain("Changed a personal amount");
    expect(html).toContain("Voided an expense");
    expect(html).toContain("€20.00");
    expect(html).toContain("€500.00");
    expect(html.indexOf("Changed a personal amount")).toBeLessThan(
      html.indexOf("Voided an expense"),
    );
    expect(html).not.toMatch(/totalMinor|beforeJson|afterJson|personalMinor/);
  });

  it("returns 404 to a non-member and never leaks another event's rows", async () => {
    const { event } = await createEvent({ name: "Private trip" });
    const eventId = event.id;
    const other = await createEvent({ name: "Other trip" });

    getSessionMock.mockResolvedValue(
      sessionFor(OUTSIDER, "outsider@example.com"),
    );
    await expect(getEventHistory(eventId)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(getEventHistory(eventId)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    await expect(getEventHistory("not-a-uuid")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });

    const page = await import("../../src/app/(app)/events/[id]/history/page");
    await expect(
      page.default({ params: Promise.resolve({ id: eventId }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    getSessionMock.mockResolvedValue(
      sessionFor(USER_A, "organizer@example.com"),
    );
    const mine = await getEventHistory(eventId);
    const theirs = await getEventHistory(other.event.id);
    expect(mine.entries.map((entry) => entry.action)).toEqual(["event.create"]);
    expect(theirs.entries.map((entry) => entry.action)).toEqual([
      "event.create",
    ]);
    expect(mine.entries[0].id).not.toBe(theirs.entries[0].id);
  });

  it("refuses to write receipts, tokens or secrets into the audit trail", async () => {
    const { event } = await createEvent({ name: "Secrets trip" });
    const eventId = event.id;
    await sql`delete from audit_log where event_id = ${eventId}`;

    await expect(
      writeAudit({
        eventId,
        actorUserId: USER_A,
        entityType: "invite",
        entityId: eventId,
        action: "invite.create",
        after: { emailNormalized: "friend@example.com", token: "raw-token" },
      }),
    ).rejects.toThrow(/sensitive audit field/);

    await expect(
      writeAudit({
        eventId,
        actorUserId: USER_A,
        entityType: "expense",
        entityId: eventId,
        action: "expense.create",
        after: { participants: [{ memberId: eventId, receiptId: "r1" }] },
      }),
    ).rejects.toThrow(/sensitive audit field/);

    const rows = await auditRows(eventId);
    expect(rows).toHaveLength(0);

    await writeAudit({
      eventId,
      actorUserId: USER_A,
      entityType: "expense",
      entityId: eventId,
      action: "expense.create",
      after: { totalMinor: 100, emailNormalized: "friend@example.com" },
    });
    expect(await auditRows(eventId)).toHaveLength(1);
  });
});
