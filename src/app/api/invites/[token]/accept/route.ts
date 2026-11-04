import { acceptInvite, inviteErrorToResponse } from "@/services/invites";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  try {
    const { eventId } = await acceptInvite(token);
    return Response.json({ ok: true, eventId });
  } catch (error) {
    const response = inviteErrorToResponse(error);
    if (response) return response;
    console.error("Unhandled error in POST /api/invites/[token]/accept", error);
    return Response.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 500 });
  }
}
