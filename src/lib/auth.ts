import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import * as authSchema from "@/db/auth-schema";
import { client } from "@/db/client";
import { emailDriver } from "@/lib/email/service";
import { setPasswordEmail } from "@/lib/email/templates/set-password";
import { env } from "@/lib/env";

const SESSION_EXPIRES_IN = 30 * 24 * 60 * 60;
const SESSION_UPDATE_AGE = 24 * 60 * 60;
const RESET_TOKEN_TTL = 60 * 60;
const SET_PASSWORD_PATH = "/welcome/password";

function extractRedirectTo(url: string): string {
  try {
    const callbackURL = new URL(url).searchParams.get("callbackURL");
    return callbackURL ? decodeURIComponent(callbackURL) : SET_PASSWORD_PATH;
  } catch {
    return SET_PASSWORD_PATH;
  }
}

const authDb = drizzle(client, { schema: authSchema.authSchema });

export function createAuth(options: { cookieSecure: boolean }) {
  return betterAuth({
    appName: "Kittie",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    advanced: {
      useSecureCookies: options.cookieSecure,
      database: {
        generateId: "uuid",
      },
    },
    database: drizzleAdapter(authDb, {
      provider: "pg",
      schema: authSchema.authSchema,
      transaction: true,
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: RESET_TOKEN_TTL,
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: async ({ user }) => {
        await authDb
          .update(authSchema.user)
          .set({ emailVerified: true })
          .where(eq(authSchema.user.id, user.id));
      },
      sendResetPassword: async ({ user, url, token }) => {
        const redirect = new URL(extractRedirectTo(url), env.APP_URL);
        const link = new URL(SET_PASSWORD_PATH, env.APP_URL);
        link.searchParams.set("token", token);
        link.searchParams.set("email", user.email);
        const next = redirect.searchParams.get("next");
        const invite = redirect.searchParams.get("invite");
        if (next) {
          link.searchParams.set("next", next);
        }
        if (invite) {
          link.searchParams.set("invite", invite);
        }
        const email = setPasswordEmail({ link: link.toString() });
        await emailDriver().send({
          to: user.email,
          subject: email.subject,
          html: email.html,
          text: email.text,
        });
      },
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN,
      updateAge: SESSION_UPDATE_AGE,
    },
  });
}

export const auth = createAuth({ cookieSecure: env.COOKIE_SECURE });
