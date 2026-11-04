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

const APP = "http://localhost:3100";
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error("TEST_DATABASE_URL is not set");
}

type JsonHandler = (request: Request) => Promise<Response>;

let sql: ReturnType<typeof postgres>;
let auth: typeof import("../../src/lib/auth").auth;
let profilePost: JsonHandler;
let passwordPost: JsonHandler;
let registerPost: JsonHandler;
let setPasswordPost: JsonHandler;
let fakeEmail: typeof import("../../src/lib/email/fake");

function jsonRequest(path: string, body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cookie) {
    headers.cookie = cookie;
  }
  return new Request(`${APP}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function cookieHeader(setCookies: string[]): string {
  return setCookies.map((cookie) => cookie.split(";")[0]).join("; ");
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

async function createUser(email: string, password: string): Promise<string> {
  fakeEmail.clearSentEmails();
  const registerResponse = await registerPost(
    jsonRequest("/api/auth/register", { email }),
  );
  expect(registerResponse.status).toBe(200);

  const token = resetLinkFromLastEmail().searchParams.get("token");
  const setPasswordResponse = await setPasswordPost(
    jsonRequest("/api/auth/set-password", { token, email, password }),
  );
  expect(setPasswordResponse.status).toBe(200);
  return cookieHeader(setPasswordResponse.headers.getSetCookie());
}

async function userName(email: string): Promise<string | null> {
  const rows = await sql<Array<{ name: string }>>`
    select name from "user" where email = ${email}
  `;
  return rows[0]?.name ?? null;
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
  const profileModule = await import("../../src/app/api/account/profile/route");
  profilePost = profileModule.POST as unknown as JsonHandler;
  const passwordModule = await import(
    "../../src/app/api/account/password/route"
  );
  passwordPost = passwordModule.POST as unknown as JsonHandler;
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

describe("profile display name", () => {
  it("updates the display name for the signed-in user", async () => {
    const email = "profile-name@example.com";
    const cookie = await createUser(email, "profile-password-1");

    const response = await profilePost(
      jsonRequest("/api/account/profile", { name: "  Ada Lovelace  " }, cookie),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      user: { name: "Ada Lovelace" },
    });
    expect(await userName(email)).toBe("Ada Lovelace");

    const reloaded = await auth.api.getSession({ headers: { cookie } });
    expect(reloaded?.user.name).toBe("Ada Lovelace");
  });

  it("rejects an empty name with a named 400 and leaves the row unchanged", async () => {
    const email = "profile-empty@example.com";
    const cookie = await createUser(email, "profile-password-1");

    for (const name of ["", "   "]) {
      const response = await profilePost(
        jsonRequest("/api/account/profile", { name }, cookie),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        ok: false,
        error: "NAME_REQUIRED",
        field: "name",
      });
    }
    expect(await userName(email)).toBe("");
  });

  it("rejects an overlong name with a named 400", async () => {
    const email = "profile-long@example.com";
    const cookie = await createUser(email, "profile-password-1");

    const response = await profilePost(
      jsonRequest("/api/account/profile", { name: "x".repeat(81) }, cookie),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "NAME_TOO_LONG",
      field: "name",
    });
    expect(await userName(email)).toBe("");
  });

  it("accepts exactly 80 characters", async () => {
    const email = "profile-eighty@example.com";
    const cookie = await createUser(email, "profile-password-1");
    const name = "y".repeat(80);

    const response = await profilePost(
      jsonRequest("/api/account/profile", { name }, cookie),
    );
    expect(response.status).toBe(200);
    expect(await userName(email)).toBe(name);
  });

  it("rejects malformed bodies and unauthenticated requests", async () => {
    const email = "profile-malformed@example.com";
    const cookie = await createUser(email, "profile-password-1");

    const badType = await profilePost(
      jsonRequest("/api/account/profile", { name: 42 }, cookie),
    );
    expect(badType.status).toBe(400);
    expect(await badType.json()).toEqual({
      ok: false,
      error: "INVALID_NAME",
      field: "name",
    });

    const badJson = await profilePost(
      new Request(`${APP}/api/account/profile`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: "{not json",
      }),
    );
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({
      ok: false,
      error: "INVALID_NAME",
      field: "name",
    });

    const unauthenticated = await profilePost(
      jsonRequest("/api/account/profile", { name: "Nobody" }),
    );
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({
      ok: false,
      error: "UNAUTHENTICATED",
    });
    expect(await userName(email)).toBe("");
  });
});

describe("password change", () => {
  it("rejects a wrong current password without invalidating the session", async () => {
    const email = "password-wrong@example.com";
    const password = "current-password-1";
    const cookie = await createUser(email, password);

    const response = await passwordPost(
      jsonRequest(
        "/api/account/password",
        {
          currentPassword: "not-my-password",
          newPassword: "replacement-password-1",
        },
        cookie,
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "WRONG_CURRENT_PASSWORD",
      field: "currentPassword",
    });

    const stillSignedIn = await auth.api.getSession({ headers: { cookie } });
    expect(stillSignedIn?.user.email).toBe(email);

    const oldPasswordStillWorks = await auth.api.signInEmail({
      body: { email, password },
    });
    expect(oldPasswordStillWorks.user.email).toBe(email);
  });

  it("changes the password, rotates the cookie and revokes every other session", async () => {
    const email = "password-change@example.com";
    const oldPassword = "old-password-1";
    const newPassword = "new-password-1";
    const cookie = await createUser(email, oldPassword);

    const other = await auth.api.signInEmail({
      body: { email, password: oldPassword },
      returnHeaders: true,
    });
    const otherCookie = cookieHeader(other.headers.getSetCookie());
    expect(otherCookie).not.toBe("");

    const response = await passwordPost(
      jsonRequest(
        "/api/account/password",
        { currentPassword: oldPassword, newPassword },
        cookie,
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const rotatedCookies = response.headers.getSetCookie();
    expect(rotatedCookies.length).toBeGreaterThan(0);
    const attributes = setCookieAttributes(rotatedCookies);
    expect(attributes.httponly).toBe("true");
    expect(attributes.samesite).toBe("Lax");
    expect(attributes.secure).toBeUndefined();

    const rotatedCookie = cookieHeader(rotatedCookies);
    expect(rotatedCookie).not.toBe(cookie);

    const rotatedSession = await auth.api.getSession({
      headers: { cookie: rotatedCookie },
    });
    expect(rotatedSession?.user.email).toBe(email);

    const oldSession = await auth.api.getSession({ headers: { cookie } });
    expect(oldSession).toBeNull();
    const otherSession = await auth.api.getSession({
      headers: { cookie: otherCookie },
    });
    expect(otherSession).toBeNull();

    await expect(
      auth.api.signInEmail({ body: { email, password: oldPassword } }),
    ).rejects.toThrow();
    const newLogin = await auth.api.signInEmail({
      body: { email, password: newPassword },
    });
    expect(newLogin.user.email).toBe(email);
  });

  it("rejects malformed password payloads", async () => {
    const email = "password-malformed@example.com";
    const cookie = await createUser(email, "current-password-1");

    const tooShort = await passwordPost(
      jsonRequest(
        "/api/account/password",
        { currentPassword: "current-password-1", newPassword: "short" },
        cookie,
      ),
    );
    expect(tooShort.status).toBe(400);
    expect(await tooShort.json()).toEqual({
      ok: false,
      error: "INVALID_NEW_PASSWORD",
      field: "newPassword",
    });

    const missingCurrent = await passwordPost(
      jsonRequest(
        "/api/account/password",
        { newPassword: "replacement-password-1" },
        cookie,
      ),
    );
    expect(missingCurrent.status).toBe(400);
    expect(await missingCurrent.json()).toEqual({
      ok: false,
      error: "CURRENT_PASSWORD_REQUIRED",
      field: "currentPassword",
    });

    const unauthenticated = await passwordPost(
      jsonRequest("/api/account/password", {
        currentPassword: "current-password-1",
        newPassword: "replacement-password-1",
      }),
    );
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({
      ok: false,
      error: "UNAUTHENTICATED",
    });
  });
});

describe("sign out", () => {
  it("clears the session so the cookie no longer authenticates", async () => {
    const email = "sign-out@example.com";
    const cookie = await createUser(email, "sign-out-password-1");
    expect(await auth.api.getSession({ headers: { cookie } })).not.toBeNull();

    const response = await auth.handler(
      new Request(`${APP}/api/auth/sign-out`, {
        method: "POST",
        headers: { cookie, origin: APP },
      }),
    );
    expect(response.status).toBe(200);

    const cleared = response.headers.getSetCookie();
    expect(cleared.length).toBeGreaterThan(0);
    for (const cookieValue of cleared) {
      expect(cookieValue.split(";")[0].endsWith("=")).toBe(true);
    }
    expect(await auth.api.getSession({ headers: { cookie } })).toBeNull();
  });
});
