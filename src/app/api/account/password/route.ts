import { auth } from "@/lib/auth";

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

interface AuthApiError {
  statusCode?: number;
  body?: { code?: string };
}

const API_ERROR_MAP: Record<
  string,
  { status: number; error: string; field?: string }
> = {
  INVALID_PASSWORD: {
    status: 400,
    error: "WRONG_CURRENT_PASSWORD",
    field: "currentPassword",
  },
  PASSWORD_TOO_SHORT: {
    status: 400,
    error: "INVALID_NEW_PASSWORD",
    field: "newPassword",
  },
  PASSWORD_TOO_LONG: {
    status: 400,
    error: "INVALID_NEW_PASSWORD",
    field: "newPassword",
  },
  CREDENTIAL_ACCOUNT_NOT_FOUND: {
    status: 400,
    error: "NO_PASSWORD_SET",
  },
  UNAUTHORIZED: { status: 401, error: "UNAUTHENTICATED" },
};

function apiErrorResponse(error: unknown): Response {
  const code = (error as AuthApiError).body?.code ?? "AUTH_ERROR";
  const mapped = API_ERROR_MAP[code];
  const status =
    mapped?.status ??
    (typeof (error as AuthApiError).statusCode === "number"
      ? (error as AuthApiError).statusCode
      : 400);
  if (status === 401) {
    return Response.json(
      { ok: false, error: "UNAUTHENTICATED" },
      { status: 401 },
    );
  }
  return Response.json(
    {
      ok: false,
      error: mapped?.error ?? code,
      ...(mapped?.field ? { field: mapped.field } : {}),
    },
    { status },
  );
}

export async function POST(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json(
      { ok: false, error: "UNAUTHENTICATED" },
      { status: 401 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    currentPassword?: unknown;
    newPassword?: unknown;
  } | null;

  if (
    typeof body?.currentPassword !== "string" ||
    body.currentPassword.length === 0
  ) {
    return Response.json(
      {
        ok: false,
        error: "CURRENT_PASSWORD_REQUIRED",
        field: "currentPassword",
      },
      { status: 400 },
    );
  }
  if (typeof body?.newPassword !== "string") {
    return Response.json(
      { ok: false, error: "INVALID_NEW_PASSWORD", field: "newPassword" },
      { status: 400 },
    );
  }
  if (
    body.newPassword.length < PASSWORD_MIN_LENGTH ||
    body.newPassword.length > PASSWORD_MAX_LENGTH
  ) {
    return Response.json(
      { ok: false, error: "INVALID_NEW_PASSWORD", field: "newPassword" },
      { status: 400 },
    );
  }

  let headers: Headers;
  try {
    ({ headers } = await auth.api.changePassword({
      body: {
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
        revokeOtherSessions: true,
      },
      headers: request.headers,
      returnHeaders: true,
    }));
  } catch (error) {
    return apiErrorResponse(error);
  }

  const response = Response.json({ ok: true });
  // revokeOtherSessions deletes every session and issues a new cookie; the
  // browser must receive it or the password change signs the user out.
  for (const cookie of headers.getSetCookie()) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}
