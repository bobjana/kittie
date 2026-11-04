import { auth } from "@/lib/auth";
import {
  computeRedirectTo,
  isSafeInviteToken,
  isSafeNextPath,
  isValidEmail,
  normalizeEmail,
} from "@/lib/auth-helpers";
import { linkPendingMembersByEmail } from "@/lib/member-linking";

interface AuthApiError {
  statusCode?: number;
  body?: { code?: string; message?: string };
}

function errorResponse(error: unknown): Response {
  const status =
    typeof (error as AuthApiError).statusCode === "number"
      ? (error as AuthApiError).statusCode
      : 400;
  const code = (error as AuthApiError).body?.code ?? "AUTH_ERROR";
  return Response.json({ ok: false, error: code }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    token?: unknown;
    email?: unknown;
    password?: unknown;
    next?: unknown;
    invite?: unknown;
  } | null;

  const token = typeof body?.token === "string" ? body.token : "";
  const email = normalizeEmail(
    typeof body?.email === "string" ? body.email : "",
  );
  const password = typeof body?.password === "string" ? body.password : "";
  const next = typeof body?.next === "string" ? body.next : undefined;
  const invite = typeof body?.invite === "string" ? body.invite : undefined;

  if (!token) {
    return Response.json(
      { ok: false, error: "INVALID_TOKEN" },
      { status: 400 },
    );
  }
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
  if (password.length < 8 || password.length > 128) {
    return Response.json(
      { ok: false, error: "INVALID_PASSWORD" },
      { status: 400 },
    );
  }

  const ctx = await auth.$context;
  const verification = await ctx.internalAdapter.findVerificationValue(
    `reset-password:${token}`,
  );
  if (!verification || verification.expiresAt < new Date()) {
    return Response.json(
      { ok: false, error: "INVALID_TOKEN" },
      { status: 400 },
    );
  }
  const user = await ctx.internalAdapter.findUserById(verification.value);
  if (!user) {
    return Response.json(
      { ok: false, error: "INVALID_TOKEN" },
      { status: 400 },
    );
  }
  if (user.email.toLowerCase() !== email) {
    return Response.json(
      { ok: false, error: "EMAIL_MISMATCH" },
      { status: 400 },
    );
  }

  try {
    await auth.api.resetPassword({
      body: { newPassword: password, token },
      headers: request.headers,
    });
  } catch (error) {
    return errorResponse(error);
  }

  let headers: Headers;
  try {
    ({ headers } = await auth.api.signInEmail({
      body: { email: user.email, password, rememberMe: true },
      headers: request.headers,
      returnHeaders: true,
    }));
  } catch (error) {
    return errorResponse(error);
  }

  await linkPendingMembersByEmail(email);

  const response = Response.json({
    ok: true,
    redirectTo: computeRedirectTo(next, invite),
  });
  for (const cookie of headers.getSetCookie()) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}
