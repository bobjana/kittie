import {
  inviteErrorToResponse,
  inviteMember,
  listInvites,
} from "@/services/invites";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  try {
    const invites = await listInvites(id);
    return Response.json({ invites });
  } catch (error) {
    const response = inviteErrorToResponse(error);
    if (response) return response;
    console.error("Unhandled error in GET /api/events/[id]/invites", error);
    return Response.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "INVALID_JSON", message: "request body must be valid JSON" },
      { status: 400 },
    );
  }

  const email =
    typeof body === "object" && body !== null
      ? (body as { email?: unknown }).email
      : undefined;

  try {
    const result = await inviteMember(id, email);
    return Response.json(result, { status: 201 });
  } catch (error) {
    const response = inviteErrorToResponse(error);
    if (response) return response;
    console.error("Unhandled error in POST /api/events/[id]/invites", error);
    return Response.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 500 });
  }
}
