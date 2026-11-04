import { auth } from "@/lib/auth";

export const NAME_MIN_LENGTH = 1;
export const NAME_MAX_LENGTH = 80;

interface AuthApiError {
  statusCode?: number;
  body?: { code?: string };
}

function errorResponse(error: unknown): Response {
  const status =
    typeof (error as AuthApiError).statusCode === "number"
      ? (error as AuthApiError).statusCode
      : 400;
  const code = (error as AuthApiError).body?.code ?? "AUTH_ERROR";
  if (status === 401) {
    return Response.json(
      { ok: false, error: "UNAUTHENTICATED" },
      { status: 401 },
    );
  }
  return Response.json({ ok: false, error: code }, { status });
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
    name?: unknown;
  } | null;
  if (typeof body?.name !== "string") {
    return Response.json(
      { ok: false, error: "INVALID_NAME", field: "name" },
      { status: 400 },
    );
  }

  const name = body.name.trim();
  if (name.length < NAME_MIN_LENGTH) {
    return Response.json(
      { ok: false, error: "NAME_REQUIRED", field: "name" },
      { status: 400 },
    );
  }
  if (name.length > NAME_MAX_LENGTH) {
    return Response.json(
      { ok: false, error: "NAME_TOO_LONG", field: "name" },
      { status: 400 },
    );
  }

  let headers: Headers;
  try {
    ({ headers } = await auth.api.updateUser({
      body: { name },
      headers: request.headers,
      returnHeaders: true,
    }));
  } catch (error) {
    return errorResponse(error);
  }

  const response = Response.json({ ok: true, user: { name } });
  // updateUser refreshes the session cookie with the new user data.
  for (const cookie of headers.getSetCookie()) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}
