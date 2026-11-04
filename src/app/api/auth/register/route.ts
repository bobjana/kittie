import { randomBytes } from "node:crypto";
import { auth } from "@/lib/auth";
import {
  buildResetRedirectTo,
  isSafeInviteToken,
  isSafeNextPath,
  isValidEmail,
  normalizeEmail,
} from "@/lib/auth-helpers";
import {
  incrementThrottle,
  REGISTER_EMAIL_LIMIT,
  REGISTER_EMAIL_WINDOW_SECONDS,
  REGISTER_IP_LIMIT,
  REGISTER_IP_WINDOW_SECONDS,
} from "@/lib/rate-limit";

function randomUnusablePassword(): string {
  return randomBytes(24).toString("base64url");
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    email?: unknown;
    next?: unknown;
    invite?: unknown;
  } | null;

  const email = normalizeEmail(
    typeof body?.email === "string" ? body.email : "",
  );
  const next = typeof body?.next === "string" ? body.next : undefined;
  const invite = typeof body?.invite === "string" ? body.invite : undefined;

  if (!isValidEmail(email)) {
    return Response.json(
      { ok: false, error: "INVALID_EMAIL" },
      { status: 400 },
    );
  }
  if (!isSafeNextPath(next)) {
    return Response.json(
      { ok: false, error: "INVALID_REDIRECT" },
      { status: 400 },
    );
  }
  if (!isSafeInviteToken(invite)) {
    return Response.json(
      { ok: false, error: "INVALID_INVITE" },
      { status: 400 },
    );
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const emailThrottled = await incrementThrottle(
    `register:${email}`,
    REGISTER_EMAIL_LIMIT,
    REGISTER_EMAIL_WINDOW_SECONDS,
  );
  const ipThrottled = await incrementThrottle(
    `register:ip:${ip}`,
    REGISTER_IP_LIMIT,
    REGISTER_IP_WINDOW_SECONDS,
  );
  if (emailThrottled || ipThrottled) {
    return Response.json({ ok: true });
  }

  try {
    await auth.api.signUpEmail({
      body: { email, password: randomUnusablePassword(), name: "" },
      headers: request.headers,
    });
  } catch {
    // A concurrent duplicate or an existing account: requestPasswordReset
    // below sends the same link for existing emails, so proceed regardless.
  }

  await auth.api.requestPasswordReset({
    body: { email, redirectTo: buildResetRedirectTo(next, invite) },
    headers: request.headers,
  });

  return Response.json({ ok: true });
}
