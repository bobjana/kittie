import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_URL = "http://localhost:3100";
process.env.BETTER_AUTH_URL = "http://localhost:3100";
process.env.BETTER_AUTH_SECRET =
  "test-secret-0123456789abcdef0123456789abcdef0123";
process.env.EMAIL_FROM = "Kittie <kittie@localhost>";
process.env.EMAIL_DRIVER = "fake";
process.env.COOKIE_SECURE = "false";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error("TEST_DATABASE_URL is not set");
}

type JsonHandler = (request: Request) => Promise<Response>;

let sql: ReturnType<typeof postgres>;
let registerPost: JsonHandler;
let setPasswordPost: JsonHandler;
let processNotificationJob: typeof import("../../src/services/notifications").processNotificationJob;
let auth: typeof import("../../src/lib/auth").auth;
let fakeEmail: typeof import("../../src/lib/email/fake");

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost:3100${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function cookieHeader(setCookies: string[]): string {
  return setCookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

function lastEmail(): { subject: string; text: string } {
  const emails = fakeEmail.getSentEmails();
  expect(emails.length).toBeGreaterThan(0);
  return emails[emails.length - 1];
}

function linkFromEmail(text: string, pathname: string): URL {
  const pattern = new RegExp(`http:\\/\\/localhost:3100${pathname}\\?\\S+`);
  const match = pattern.exec(text);
  expect(match).not.toBeNull();
  return new URL(match?.[0] ?? "");
}

beforeAll(async () => {
  sql = postgres(url, { max: 1 });
  await sql`drop schema if exists public cascade`;
  await sql`drop schema if exists drizzle cascade`;
  await sql`create schema public`;
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder: "drizzle" });

  const authModule = await import("../../src/lib/auth");
  auth = authModule.auth;
  const registerModule = await import("../../src/app/api/auth/register/route");
  registerPost = registerModule.POST as unknown as JsonHandler;
  const setPasswordModule = await import(
    "../../src/app/api/auth/set-password/route"
  );
  setPasswordPost = setPasswordModule.POST as unknown as JsonHandler;
  const notificationsModule = await import("../../src/services/notifications");
  processNotificationJob = notificationsModule.processNotificationJob;
  fakeEmail = await import("../../src/lib/email/fake");
});

afterAll(async () => {
  await sql?.end();
});

describe("pending member registers through the tally email link", () => {
  it("registers, links the pending membership and lands on the frozen report path", async () => {
    fakeEmail.clearSentEmails();
    const pendingEmail = "tally-pending@example.com";
    const password = "correct-horse-battery";

    const organizerRows = await sql<Array<{ id: string }>>`
      insert into "user" (email, name, email_verified, created_at, updated_at)
      values ('tally-organizer@example.com', 'Organizer', true, now(), now())
      returning id
    `;
    const organizerUserId = organizerRows[0].id;

    const eventRows = await sql<Array<{ id: string }>>`
      insert into events (name, organizer_user_id, currency, status, closed_at, created_at, updated_at)
      values ('Tally link event', ${organizerUserId}, 'EUR', 'closed', now(), now(), now())
      returning id
    `;
    const eventId = eventRows[0].id;

    const memberRows = await sql<Array<{ id: string }>>`
      insert into event_members (event_id, user_id, email_normalized, display_name, role, status, joined_at, created_at)
      values (${eventId}, null, ${pendingEmail}, null, 'member', 'pending', null, now())
      returning id
    `;
    const pendingMemberId = memberRows[0].id;

    const settlementRows = await sql<Array<{ id: string }>>`
      insert into event_settlements (
        event_id, version, total_spent_minor, balances_json, transfers_json,
        closed_at, superseded_at
      )
      values (
        ${eventId}, 1, 0,
        ${JSON.stringify({
          version: 1,
          totalSpentMinor: 0,
          totalOwedMinor: 0,
          members: [
            {
              memberId: pendingMemberId,
              paidMinor: 0,
              shareMinor: 0,
              netMinor: 0,
            },
          ],
          transfers: [],
        })}::jsonb,
        ${JSON.stringify([])}::jsonb,
        now(), null
      )
      returning id
    `;
    const settlementId = settlementRows[0].id;

    const jobRows = await sql<Array<{ id: string }>>`
      insert into notification_jobs (
        type, event_id, settlement_id, recipient_member_id, recipient_email, status, created_at
      )
      values ('close_tally', ${eventId}, ${settlementId}, ${pendingMemberId}, ${pendingEmail}, 'queued', now())
      returning id
    `;
    const jobId = jobRows[0].id;

    const outcome = await processNotificationJob(jobId);
    expect(outcome.status).toBe("sent");

    const tallyEmail = fakeEmail
      .getSentEmails()
      .find((email) => email.subject === "Final tally: Tally link event");
    if (tallyEmail === undefined) {
      throw new Error("no tally email for the pending member");
    }
    expect(tallyEmail.to).toBe(pendingEmail);
    expect(tallyEmail.text).toContain(
      `${pendingEmail}: paid EUR 0.00, share EUR 0.00, net EUR 0.00.`,
    );

    const registerLink = linkFromEmail(tallyEmail.text, "/register");
    expect(registerLink.searchParams.get("email")).toBe(pendingEmail);
    expect(registerLink.searchParams.get("next")).toBe(
      `/events/${eventId}/report`,
    );

    const registerResponse = await registerPost(
      jsonRequest("/api/auth/register", {
        email: registerLink.searchParams.get("email"),
        next: registerLink.searchParams.get("next"),
      }),
    );
    expect(registerResponse.status).toBe(200);
    expect(await registerResponse.json()).toEqual({ ok: true });

    const resetLink = linkFromEmail(lastEmail().text, "/welcome/password");
    const token = resetLink.searchParams.get("token");
    expect(token).toBeTruthy();

    const setPasswordResponse = await setPasswordPost(
      jsonRequest("/api/auth/set-password", {
        token,
        email: pendingEmail,
        password,
        next: registerLink.searchParams.get("next"),
      }),
    );
    expect(setPasswordResponse.status).toBe(200);
    const body = (await setPasswordResponse.json()) as {
      ok: boolean;
      redirectTo: string;
    };
    expect(body.ok).toBe(true);
    expect(body.redirectTo).toBe(`/events/${eventId}/report`);

    const setCookies = setPasswordResponse.headers.getSetCookie();
    expect(setCookies.length).toBeGreaterThan(0);

    const session = (await auth.api.getSession({
      headers: { cookie: cookieHeader(setCookies) },
    })) as { user: { email: string } } | null;
    expect(session?.user.email).toBe(pendingEmail);

    const memberAfter = await sql<
      Array<{
        status: string;
        user_id: string | null;
        joined_at: string | null;
      }>
    >`select status, user_id, joined_at from event_members where id = ${pendingMemberId}`;
    expect(memberAfter[0].status).toBe("active");
    expect(memberAfter[0].user_id).toBeTruthy();
    expect(memberAfter[0].joined_at).toBeTruthy();

    const settlementAfter = await sql<
      Array<{ superseded_at: string | null }>
    >`select superseded_at from event_settlements where id = ${settlementId}`;
    expect(settlementAfter[0].superseded_at).toBeNull();

    const jobAfter = await sql<Array<{ status: string }>>`
      select status from notification_jobs where id = ${jobId}
    `;
    expect(jobAfter[0].status).toBe("sent");
  });
});
