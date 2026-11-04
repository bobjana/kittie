import { auth } from "@/lib/auth";
import { linkPendingMembersByEmail } from "@/lib/member-linking";

async function handle(request: Request): Promise<Response> {
  return auth.handler(request);
}

export const GET = handle;

export const POST = async (request: Request): Promise<Response> => {
  const isSignIn = new URL(request.url).pathname.endsWith("/sign-in/email");
  if (!isSignIn) {
    return auth.handler(request);
  }

  const clone = request.clone();
  const response = await auth.handler(request);
  if (response.status !== 200) {
    return response;
  }

  const body = (await clone.json().catch(() => null)) as {
    email?: unknown;
  } | null;
  const email = typeof body?.email === "string" ? body.email : null;
  if (email) {
    await linkPendingMembersByEmail(email.trim().toLowerCase());
  }
  return response;
};

export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
