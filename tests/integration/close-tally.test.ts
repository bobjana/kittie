import { randomUUID } from "node:crypto";

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
import { clearSentEmails, fakeDriver, getSentEmails } from "@/lib/email/fake";
import type { EmailDriver } from "@/lib/email/service";
import { smtpDriver } from "@/lib/email/smtp";
import {
  claimNextNotificationJob,
  listSettlementNotifications,
  type NotificationOutcome,
  processNotificationJob,
  reclaimStaleNotificationJobs,
  resendNotification,
} from "@/services/notifications";
import { closeEvent, reopenEvent } from "@/services/settlements";
import { POST as resendRoute } from "../../src/app/api/events/[id]/settlements/[settlementId]/notifications/resend/route";
import { GET as notificationsRoute } from "../../src/app/api/events/[id]/settlements/[settlementId]/notifications/route";

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

const MAILPIT_API = process.env.MAILPIT_API_URL ?? "http://localhost:8025";

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
  participants: { memberId: string }[];
}): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    insert into expenses (event_id, created_by, paid_by_member_id, total_minor, currency, spent_on, split_mode, status, created_at)
    values (${input.eventId}, ${USER_A}, ${input.paidByMemberId}, ${input.totalMinor}, 'EUR', '2026-11-01', 'equal', 'open', now())
    returning id
  `;
  const expenseId = rows[0].id;
  for (const participant of input.participants) {
    await sql`
      insert into expense_participants (expense_id, member_id, personal_minor)
      values (${expenseId}, ${participant.memberId}, 0)
    `;
  }
  return rows[0].id;
}

async function organizerMemberIdOf(eventId: string): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    select id from event_members where event_id = ${eventId} and role = 'organizer' limit 1
  `;
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

async function addOrganizerExpense(
  eventId: string,
  totalMinor: number,
): Promise<void> {
  const paidBy = await organizerMemberIdOf(eventId);
  await addExpense({
    eventId,
    paidByMemberId: paidBy,
    totalMinor,
    participants: [{ memberId: paidBy }],
  });
}

async function activeSettlement(eventId: string): Promise<{
  id: string;
  version: number;
}> {
  const rows = await sql<Array<{ id: string; version: number }>>`
    select id, version from event_settlements
    where event_id = ${eventId} and superseded_at is null
    limit 1
  `;
  expect(rows).toHaveLength(1);
  return rows[0];
}

interface JobRow {
  id: string;
  settlement_id: string;
  recipient_email: string;
  status: string;
  attempts: number;
  error_code: string | null;
  next_attempt_at: string | null;
}

async function jobRowsFor(eventId: string): Promise<JobRow[]> {
  return sql`
    select id, settlement_id, recipient_email, status, attempts, error_code, next_attempt_at
    from notification_jobs
    where event_id = ${eventId}
    order by created_at
  `;
}

interface MailpitMessageSummary {
  ID: string;
  Subject: string;
}

interface MailpitMessage {
  ID: string;
  Subject: string;
  Text: string;
  HTML: string;
}

async function mailpitSearch(to: string): Promise<{
  total: number;
  count: number;
  messages: MailpitMessageSummary[];
}> {
  const response = await fetch(
    `${MAILPIT_API}/api/v1/search?query=to:${encodeURIComponent(to)}`,
  );
  if (!response.ok) {
    throw new Error(`mailpit search failed: ${response.status}`);
  }
  return (await response.json()) as {
    total: number;
    count: number;
    messages: MailpitMessageSummary[];
  };
}

async function mailpitMessage(id: string): Promise<MailpitMessage> {
  const response = await fetch(`${MAILPIT_API}/api/v1/message/${id}`);
  if (!response.ok) {
    throw new Error(`mailpit message fetch failed: ${response.status}`);
  }
  return (await response.json()) as MailpitMessage;
}

async function mailpitDelete(ids: string[]): Promise<void> {
  if (!ids.length) {
    return;
  }
  await fetch(`${MAILPIT_API}/api/v1/messages`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

function failingDriver(): EmailDriver {
  return {
    async send(): Promise<void> {
      throw new Error("smtp relay unreachable");
    },
  };
}

async function processAll(
  jobs: Array<{ id: string }>,
  driver?: EmailDriver,
): Promise<NotificationOutcome[]> {
  const outcomes = [];
  for (const job of jobs) {
    outcomes.push(await processNotificationJob(job.id, driver));
  }
  return outcomes;
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
  clearSentEmails();
});

describe("close-tally delivery", () => {
  it("sends exactly one tally email per member through Mailpit and marks every job sent", async () => {
    const run = randomUUID().slice(0, 8);
    const organizerEmail = `r20-org-${run}@mailpit.test`;
    const friendEmail = `r20-friend-${run}@mailpit.test`;
    const pendingEmail = `r20-pending-${run}@mailpit.test`;
    const removedEmail = `r20-removed-${run}@mailpit.test`;

    const rows = await sql<Array<{ id: string }>>`
      insert into events (name, organizer_user_id, currency, status, created_at, updated_at)
      values (${`Tally run ${run}`}, ${USER_A}, 'EUR', 'open', now(), now())
      returning id
    `;
    const eventId = rows[0].id;
    const organizerMemberId = await addMember(
      eventId,
      USER_A,
      organizerEmail,
      "Organizer",
      "organizer",
      "active",
    );
    const friendId = await addMember(
      eventId,
      USER_B,
      friendEmail,
      "Friend",
      "member",
      "active",
    );
    await addMember(eventId, null, pendingEmail, null, "member", "pending");
    await addMember(eventId, null, removedEmail, null, "member", "removed");
    await addExpense({
      eventId,
      paidByMemberId: organizerMemberId,
      totalMinor: 30000,
      participants: [{ memberId: organizerMemberId }, { memberId: friendId }],
    });

    await closeEvent(eventId);
    const settlement = await activeSettlement(eventId);
    const jobs = await jobRowsFor(eventId);
    expect(jobs).toHaveLength(3);
    expect(jobs.map((job) => job.recipient_email).sort()).toEqual(
      [organizerEmail, friendEmail, pendingEmail].sort(),
    );
    expect(jobs.every((job) => job.settlement_id === settlement.id)).toBe(true);

    const outcomes = await processAll(jobs, smtpDriver);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "sent",
      "sent",
      "sent",
    ]);
    expect(outcomes.every((outcome) => outcome.attempts === 1)).toBe(true);

    const organizerMail = await mailpitSearch(organizerEmail);
    const friendMail = await mailpitSearch(friendEmail);
    const pendingMail = await mailpitSearch(pendingEmail);
    const removedMail = await mailpitSearch(removedEmail);
    expect(organizerMail.count).toBe(1);
    expect(friendMail.count).toBe(1);
    expect(pendingMail.count).toBe(1);
    expect(removedMail.count).toBe(0);

    const organizerMessage = await mailpitMessage(organizerMail.messages[0].ID);
    const pendingMessage = await mailpitMessage(pendingMail.messages[0].ID);
    expect(organizerMessage.Subject).toBe(`Final tally: Tally run ${run}`);
    expect(organizerMessage.Text).toContain("Group total: EUR 300.00");
    expect(organizerMessage.Text).toContain(
      "Organizer: paid EUR 300.00, share EUR 150.00, net EUR 150.00.",
    );
    expect(organizerMessage.Text).toContain("Friend pays Organizer EUR 150.00");
    expect(organizerMessage.HTML).toContain("You get back");
    expect(organizerMessage.Text).toContain(
      `${process.env.APP_URL}/events/${eventId}/report`,
    );
    expect(pendingMessage.Text).toContain(
      `email=${encodeURIComponent(pendingEmail)}`,
    );
    expect(pendingMessage.Text).toContain(
      `next=${encodeURIComponent(`/events/${eventId}/report`)}`,
    );

    const rowsAfter = await jobRowsFor(eventId);
    expect(rowsAfter.every((job) => job.status === "sent")).toBe(true);
    expect(rowsAfter.every((job) => job.attempts === 1)).toBe(true);

    await mailpitDelete([
      organizerMail.messages[0].ID,
      friendMail.messages[0].ID,
      pendingMail.messages[0].ID,
    ]);
  });

  it("retries a forced send failure three times then fails the job", async () => {
    const { eventId } = await createOrganizedEvent("Failing close");
    await addOrganizerExpense(eventId, 10000);

    await closeEvent(eventId);
    const jobs = await jobRowsFor(eventId);
    expect(jobs).toHaveLength(1);

    let outcome = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const results = await processAll(jobs, failingDriver());
      outcome = results[0];
    }
    expect(outcome?.status).toBe("failed");

    const rowsAfter = await jobRowsFor(eventId);
    expect(rowsAfter[0].status).toBe("failed");
    expect(rowsAfter[0].attempts).toBe(3);
    expect(rowsAfter[0].error_code).toBe("EMAIL_SEND_FAILED");
    expect(getSentEmails()).toHaveLength(0);
  });

  it("queues a retry with backoff after one failure and does not re-claim it early", async () => {
    const { eventId } = await createOrganizedEvent("Backoff close");
    await addOrganizerExpense(eventId, 10000);
    await closeEvent(eventId);
    const [job] = await jobRowsFor(eventId);

    let calls = 0;
    const outcome = await processNotificationJob(job.id, {
      async send() {
        calls += 1;
        throw new Error("transient smtp failure");
      },
    });
    expect(outcome.status).toBe("retrying");
    expect(outcome.attempts).toBe(1);
    expect(calls).toBe(1);

    const [row] = await jobRowsFor(eventId);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).toBeTruthy();

    expect(await claimNextNotificationJob()).toBeNull();
  });

  it("resends a failed tally email and refuses non-organizers and non-failed jobs", async () => {
    const { eventId } = await createOrganizedEvent("Resend close");
    await addOrganizerExpense(eventId, 10000);
    await closeEvent(eventId);
    const settlement = await activeSettlement(eventId);
    const [job] = await jobRowsFor(eventId);

    for (let attempt = 0; attempt < 3; attempt++) {
      await processNotificationJob(job.id, failingDriver());
    }
    expect((await jobRowsFor(eventId))[0].status).toBe("failed");

    const resent = await resendNotification(eventId, settlement.id, job.id);
    expect(resent.status).toBe("queued");
    expect(resent.attempts).toBe(0);

    const sent = await processNotificationJob(job.id, fakeDriver);
    expect(sent.status).toBe("sent");
    expect(getSentEmails()).toHaveLength(1);
    expect(getSentEmails()[0].to).toBe("organizer@example.com");

    const view = await listSettlementNotifications(eventId, settlement.id);
    expect(view.settlementId).toBe(settlement.id);
    expect(view.notifications).toHaveLength(1);
    expect(view.notifications[0]).toMatchObject({
      id: job.id,
      status: "sent",
      attempts: 1,
    });

    await expect(
      resendNotification(eventId, settlement.id, job.id),
    ).rejects.toMatchObject({ code: "NOT_RESENDABLE", status: 409 });

    getSessionMock.mockResolvedValue(
      sessionFor(USER_B, "intruder@example.com"),
    );
    await expect(
      resendNotification(eventId, settlement.id, job.id),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      listSettlementNotifications(eventId, settlement.id),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("skips a queued job for a superseded settlement and keeps job sets per close apart", async () => {
    const name = "Reopen close";
    const { eventId } = await createOrganizedEvent(name);
    await addOrganizerExpense(eventId, 10000);

    await closeEvent(eventId);
    const v1 = await activeSettlement(eventId);
    const v1Jobs = await jobRowsFor(eventId);
    expect(v1Jobs).toHaveLength(1);

    await reopenEvent(eventId, true);
    await closeEvent(eventId);
    const v2 = await activeSettlement(eventId);
    expect(v2.version).toBe(2);
    expect(v2.id).not.toBe(v1.id);

    const allJobs = await jobRowsFor(eventId);
    expect(allJobs).toHaveLength(2);
    const v1Job = allJobs.find((job) => job.settlement_id === v1.id);
    const v2Job = allJobs.find((job) => job.settlement_id === v2.id);
    expect(v1Job?.status).toBe("cancelled");
    expect(v2Job?.status).toBe("queued");
    expect(v1Job?.id).not.toBe(v2Job?.id);
    if (v1Job === undefined || v2Job === undefined) {
      throw new Error("expected one job per settlement version");
    }

    const sent = await processNotificationJob(v2Job.id, fakeDriver);
    expect(sent.status).toBe("sent");
    const tallyEmails = getSentEmails().filter((email) =>
      email.subject.startsWith("Updated final tally"),
    );
    expect(tallyEmails).toHaveLength(1);
    expect(tallyEmails[0].subject).toBe(`Updated final tally: ${name}`);

    await sql`update notification_jobs set status = 'queued' where id = ${v1Job.id}`;
    const skipped = await processNotificationJob(v1Job.id, fakeDriver);
    expect(skipped.status).toBe("cancelled");
    expect(skipped.errorCode).toBe("SETTLEMENT_SUPERSEDED");
    expect(
      (await jobRowsFor(eventId)).find((j) => j.id === v1Job.id)?.status,
    ).toBe("cancelled");
  });

  it("cancels the job when the recipient is removed after close", async () => {
    const { eventId } = await createOrganizedEvent("Removal close");
    await addMember(
      eventId,
      USER_B,
      "friend@example.com",
      "Friend",
      "member",
      "active",
    );
    await addOrganizerExpense(eventId, 10000);
    await closeEvent(eventId);
    const jobs = await jobRowsFor(eventId);
    const friendJob = jobs.find(
      (job) => job.recipient_email === "friend@example.com",
    );
    if (friendJob === undefined) {
      throw new Error("expected a tally job for the friend");
    }

    await sql`update event_members set status = 'removed' where event_id = ${eventId} and email_normalized = 'friend@example.com'`;
    const outcome = await processNotificationJob(friendJob.id, fakeDriver);
    expect(outcome.status).toBe("cancelled");
    expect(outcome.errorCode).toBe("RECIPIENT_REMOVED");
    expect(getSentEmails()).toHaveLength(0);
  });

  it("reclaims a stale running job and fails it once attempts are exhausted", async () => {
    const { eventId } = await createOrganizedEvent("Stale close");
    await addOrganizerExpense(eventId, 10000);
    await closeEvent(eventId);
    const [job] = await jobRowsFor(eventId);

    await sql`update notification_jobs set status = 'running', attempts = 1, updated_at = now() - interval '11 minutes' where id = ${job.id}`;
    expect(await reclaimStaleNotificationJobs()).toEqual([job.id]);
    let row = (await jobRowsFor(eventId))[0];
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(2);
    expect(row.error_code).toBe("STALE_JOB");

    await sql`update notification_jobs set status = 'running', updated_at = now() - interval '11 minutes' where id = ${job.id}`;
    expect(await reclaimStaleNotificationJobs()).toEqual([job.id]);
    row = (await jobRowsFor(eventId))[0];
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(3);

    await sql`update notification_jobs set status = 'running', updated_at = now() - interval '11 minutes' where id = ${job.id}`;
    expect(await reclaimStaleNotificationJobs()).toEqual([job.id]);
    row = (await jobRowsFor(eventId))[0];
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(3);
    expect(row.error_code).toBe("STALE_JOB");

    await sql`update notification_jobs set status = 'running', updated_at = now() - interval '9 minutes' where id = ${job.id}`;
    expect(await reclaimStaleNotificationJobs()).toEqual([]);
    expect((await jobRowsFor(eventId))[0].status).toBe("running");
  });

  it("claims queued jobs oldest-first and never claims a running one twice", async () => {
    const { eventId } = await createOrganizedEvent("Claim close");
    await addMember(
      eventId,
      USER_B,
      "friend@example.com",
      "Friend",
      "member",
      "active",
    );
    await addOrganizerExpense(eventId, 10000);
    await closeEvent(eventId);
    const jobs = await jobRowsFor(eventId);
    expect(jobs).toHaveLength(2);

    const first = await claimNextNotificationJob();
    const second = await claimNextNotificationJob();
    if (first === null || second === null) {
      throw new Error("expected two claimable jobs");
    }
    expect(new Set([first.jobId, second.jobId])).toEqual(
      new Set(jobs.map((job) => job.id)),
    );

    expect(await claimNextNotificationJob()).toBeNull();
  });
});

describe("notifications API routes", () => {
  async function openFailedSettlement() {
    const { eventId } = await createOrganizedEvent("Route close");
    await addOrganizerExpense(eventId, 10000);
    await closeEvent(eventId);
    const settlement = await activeSettlement(eventId);
    const [job] = await jobRowsFor(eventId);
    await processNotificationJob(job.id, failingDriver());
    for (let attempt = 0; attempt < 2; attempt++) {
      await processNotificationJob(job.id, failingDriver());
    }
    return { eventId, settlement, job };
  }

  function resendRequest(eventId: string): Request {
    return new Request(
      `http://localhost/api/events/${eventId}/settlements/x/notifications/resend`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: "not-a-real-job" }),
      },
    );
  }

  it("serves the delivery status list to the organizer and refuses other members", async () => {
    const { eventId, settlement } = await openFailedSettlement();

    const response = await notificationsRoute(new Request("http://localhost"), {
      params: Promise.resolve({ id: eventId, settlementId: settlement.id }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      settlementId: string;
      notifications: Array<{ status: string; attempts: number }>;
    };
    expect(body.settlementId).toBe(settlement.id);
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]).toMatchObject({
      status: "failed",
      attempts: 3,
    });

    getSessionMock.mockResolvedValue(
      sessionFor(USER_B, "intruder@example.com"),
    );
    const nonMember = await notificationsRoute(
      new Request("http://localhost"),
      {
        params: Promise.resolve({ id: eventId, settlementId: settlement.id }),
      },
    );
    expect(nonMember.status).toBe(404);
    expect(await nonMember.json()).toEqual({ error: "NOT_FOUND" });

    await addMember(
      eventId,
      USER_B,
      "intruder@example.com",
      "Intruder",
      "member",
      "active",
    );
    const denied = await notificationsRoute(new Request("http://localhost"), {
      params: Promise.resolve({ id: eventId, settlementId: settlement.id }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "NOT_ORGANIZER" });
  });

  it("returns 404 for an unknown settlement and 400 for a missing job id", async () => {
    const { eventId } = await openFailedSettlement();
    const unknown = await notificationsRoute(new Request("http://localhost"), {
      params: Promise.resolve({ id: eventId, settlementId: randomUUID() }),
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({
      error: "SETTLEMENT_NOT_FOUND",
    });

    const malformedSettlement = await notificationsRoute(
      new Request("http://localhost"),
      {
        params: Promise.resolve({ id: eventId, settlementId: "not-a-uuid" }),
      },
    );
    expect(malformedSettlement.status).toBe(404);
    expect(await malformedSettlement.json()).toMatchObject({
      error: "SETTLEMENT_NOT_FOUND",
    });

    const missingJob = await resendRoute(
      new Request("http://localhost/x", { method: "POST", body: "{}" }),
      { params: Promise.resolve({ id: eventId, settlementId: randomUUID() }) },
    );
    expect(missingJob.status).toBe(400);
    expect(await missingJob.json()).toEqual({ error: "INVALID_JOB" });
  });

  it("resends a failed tally email through the route and rejects an unknown job", async () => {
    const { eventId, settlement, job } = await openFailedSettlement();

    const response = await resendRoute(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: job.id }),
      }),
      { params: Promise.resolve({ id: eventId, settlementId: settlement.id }) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      notification: { status: string; attempts: number };
    };
    expect(body.notification).toMatchObject({ status: "queued", attempts: 0 });
    expect((await jobRowsFor(eventId))[0].status).toBe("queued");

    const unknown = await resendRoute(resendRequest(eventId), {
      params: Promise.resolve({ id: eventId, settlementId: settlement.id }),
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({
      error: "NOTIFICATION_JOB_NOT_FOUND",
    });

    const wellFormedMissingJob = await resendRoute(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: randomUUID() }),
      }),
      { params: Promise.resolve({ id: eventId, settlementId: settlement.id }) },
    );
    expect(wellFormedMissingJob.status).toBe(404);
    expect(await wellFormedMissingJob.json()).toMatchObject({
      error: "NOTIFICATION_JOB_NOT_FOUND",
    });
  });
});
