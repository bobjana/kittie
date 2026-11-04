import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

type JsonHandler = (request: Request) => Promise<Response>;

let sql: ReturnType<typeof postgres>;
let auth: typeof import("../../src/lib/auth").auth;
let createAuth: typeof import("../../src/lib/auth").createAuth;
let registerPost: JsonHandler;
let setPasswordPost: JsonHandler;
let fakeEmail: typeof import("../../src/lib/email/fake");

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost:3100${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function setCookieAttributes(setCookies: string[]): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const cookie of setCookies) {
    for (const part of cookie.split(";").slice(1)) {
      const separator = part.indexOf("=");
      if (separator === -1) {
        attributes[part.trim().toLowerCase()] = "true";
      } else {
        attributes[part.slice(0, separator).trim().toLowerCase()] = part
          .slice(separator + 1)
          .trim();
      }
    }
  }
  return attributes;
}

function cookieHeader(setCookies: string[]): string {
  return setCookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

function resetLinkFromLastEmail(): URL {
  const emails = fakeEmail.getSentEmails();
  const latest = emails[emails.length - 1];
  expect(latest).toBeTruthy();
  const match = /http:\/\/localhost:3100\/welcome\/password\?\S+/.exec(
    latest.text,
  );
  if (!match) {
    throw new Error("no reset link found in the latest email");
  }
  return new URL(match[0]);
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
  createAuth = authModule.createAuth;
  const registerModule = await import("../../src/app/api/auth/register/route");
  registerPost = registerModule.POST as unknown as JsonHandler;
  const setPasswordModule = await import(
    "../../src/app/api/auth/set-password/route"
  );
  setPasswordPost = setPasswordModule.POST as unknown as JsonHandler;
  fakeEmail = await import("../../src/lib/email/fake");
});

afterAll(async () => {
  await sql?.end();
});

describe("Better Auth registration and set-password flow", () => {
  it("runs the full register -> set-password -> auto-login -> password login flow", async () => {
    fakeEmail.clearSentEmails();
    const email = "alice@example.com";
    const password = "correct-horse-battery";

    const registerResponse = await registerPost(
      jsonRequest("/api/auth/register", { email }),
    );
    expect(registerResponse.status).toBe(200);
    expect(await registerResponse.json()).toEqual({ ok: true });

    const link = resetLinkFromLastEmail();
    expect(link.searchParams.get("email")).toBe(email);
    const token = link.searchParams.get("token");
    expect(token).toBeTruthy();

    const setPasswordResponse = await setPasswordPost(
      jsonRequest("/api/auth/set-password", { token, email, password }),
    );
    expect(setPasswordResponse.status).toBe(200);
    const setPasswordBody = (await setPasswordResponse.json()) as {
      ok: boolean;
      redirectTo: string;
    };
    expect(setPasswordBody.ok).toBe(true);
    expect(setPasswordBody.redirectTo).toBe("/tally");

    const setCookies = setPasswordResponse.headers.getSetCookie();
    expect(setCookies.length).toBeGreaterThan(0);
    const attributes = setCookieAttributes(setCookies);
    expect(attributes.httponly).toBe("true");
    expect(attributes.samesite).toBe("Lax");
    expect(attributes["max-age"]).toBe(String(30 * 24 * 60 * 60));
    expect(attributes.secure).toBeUndefined();

    const session = await auth.api.getSession({
      headers: { cookie: cookieHeader(setCookies) },
    });
    expect(session?.user.email).toBe(email);
    expect(session?.user.emailVerified).toBe(true);

    const login = await auth.api.signInEmail({
      body: { email, password, rememberMe: true },
      returnHeaders: true,
    });
    const loginCookies = login.headers.getSetCookie();
    expect(loginCookies.length).toBeGreaterThan(0);
    const loginSession = await auth.api.getSession({
      headers: { cookie: cookieHeader(loginCookies) },
    });
    expect(loginSession?.user.email).toBe(email);
  });

  it("sets the Secure attribute in production mode", async () => {
    const productionAuth = createAuth({ cookieSecure: true });
    const email = "secure@example.com";
    const password = "secure-password-1";

    await registerPost(jsonRequest("/api/auth/register", { email }));
    const link = resetLinkFromLastEmail();
    const token = link.searchParams.get("token");
    await setPasswordPost(
      jsonRequest("/api/auth/set-password", { token, email, password }),
    );

    const login = await productionAuth.api.signInEmail({
      body: { email, password, rememberMe: true },
      returnHeaders: true,
    });
    const cookies = login.headers.getSetCookie();
    const attributes = setCookieAttributes(cookies);
    expect(attributes.secure).toBe("true");
    expect(attributes.httponly).toBe("true");
    expect(attributes.samesite).toBe("Lax");
  });

  it("rejects a reused token with a named error", async () => {
    fakeEmail.clearSentEmails();
    const email = "reuse@example.com";
    const password = "reuse-password-1";

    await registerPost(jsonRequest("/api/auth/register", { email }));
    const token = resetLinkFromLastEmail().searchParams.get("token");
    const first = await setPasswordPost(
      jsonRequest("/api/auth/set-password", { token, email, password }),
    );
    expect(first.status).toBe(200);

    const second = await setPasswordPost(
      jsonRequest("/api/auth/set-password", { token, email, password }),
    );
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({
      ok: false,
      error: "INVALID_TOKEN",
    });
  });

  it("rejects an expired token with a named error", async () => {
    const email = "expired@example.com";
    await registerPost(jsonRequest("/api/auth/register", { email }));
    const token = resetLinkFromLastEmail().searchParams.get("token");

    await sql`update verification set expires_at = now() - interval '1 hour' where identifier = ${`reset-password:${token}`}`;

    const response = await setPasswordPost(
      jsonRequest("/api/auth/set-password", {
        token,
        email,
        password: "expired-password-1",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "INVALID_TOKEN",
    });
  });

  it("rejects a tampered email with a named error", async () => {
    const email = "owner@example.com";
    await registerPost(jsonRequest("/api/auth/register", { email }));
    const token = resetLinkFromLastEmail().searchParams.get("token");

    const response = await setPasswordPost(
      jsonRequest("/api/auth/set-password", {
        token,
        email: "attacker@example.com",
        password: "attacker-password-1",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "EMAIL_MISMATCH",
    });
  });

  it("returns the same 200 for duplicate registration", async () => {
    fakeEmail.clearSentEmails();
    const email = "duplicate@example.com";

    const first = await registerPost(
      jsonRequest("/api/auth/register", { email }),
    );
    const second = await registerPost(
      jsonRequest("/api/auth/register", { email }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect(await second.json()).toEqual({ ok: true });
    expect(fakeEmail.getSentEmails()).toHaveLength(2);
  });

  it("throttles registration by email and sends no new email", async () => {
    fakeEmail.clearSentEmails();
    const email = "throttled@example.com";
    const limit = 5;

    for (let attempt = 0; attempt < limit; attempt += 1) {
      const response = await registerPost(
        jsonRequest("/api/auth/register", { email }),
      );
      expect(response.status).toBe(200);
    }
    expect(fakeEmail.getSentEmails()).toHaveLength(limit);

    const throttled = await registerPost(
      jsonRequest("/api/auth/register", { email }),
    );
    expect(throttled.status).toBe(200);
    expect(await throttled.json()).toEqual({ ok: true });
    expect(fakeEmail.getSentEmails()).toHaveLength(limit);
  });

  it("rejects an invalid email and a protocol-relative next", async () => {
    const badEmail = await registerPost(
      jsonRequest("/api/auth/register", { email: "not-an-email" }),
    );
    expect(badEmail.status).toBe(400);
    expect(await badEmail.json()).toEqual({
      ok: false,
      error: "INVALID_EMAIL",
    });

    const badNext = await registerPost(
      jsonRequest("/api/auth/register", {
        email: "redirect@example.com",
        next: "//evil.com",
      }),
    );
    expect(badNext.status).toBe(400);
    expect(await badNext.json()).toEqual({
      ok: false,
      error: "INVALID_REDIRECT",
    });
  });

  it("links pending event members on first sign-in and stays idempotent", async () => {
    fakeEmail.clearSentEmails();
    const email = "linkme@example.com";
    const password = "linkme-password-1";

    const eventId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await sql`insert into events (id, name, organizer_user_id) values (${eventId}, 'Trip', '11111111-1111-4111-8111-111111111111')`;
    await sql`insert into event_members (event_id, email_normalized, role, status) values (${eventId}, ${email}, 'member', 'pending')`;

    await registerPost(jsonRequest("/api/auth/register", { email }));
    const token = resetLinkFromLastEmail().searchParams.get("token");
    const response = await setPasswordPost(
      jsonRequest("/api/auth/set-password", { token, email, password }),
    );
    expect(response.status).toBe(200);

    const members = await sql<
      Array<{ user_id: string | null; status: string; joined_at: Date | null }>
    >`select user_id, status, joined_at from event_members where event_id = ${eventId}`;
    expect(members).toHaveLength(1);
    expect(members[0].status).toBe("active");
    expect(members[0].user_id).toBeTruthy();
    expect(members[0].joined_at).toBeTruthy();

    const linkingModule = await import("../../src/lib/member-linking");
    await linkingModule.linkPendingMembersByEmail(email);

    const membersAfter = await sql<
      Array<{ status: string }>
    >`select status from event_members where event_id = ${eventId}`;
    expect(membersAfter).toHaveLength(1);
    expect(membersAfter[0].status).toBe("active");
  });
});
