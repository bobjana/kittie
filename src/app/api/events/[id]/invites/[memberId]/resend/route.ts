import { inviteErrorToResponse, resendInvite } from "@/services/invites";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; memberId: string }> },
): Promise<Response> {
  const { id, memberId } = await params;
  try {
    const invite = await resendInvite(id, memberId);
    return Response.json({ invite });
  } catch (error) {
    const response = inviteErrorToResponse(error);
    if (response) return response;
    console.error(
      "Unhandled error in POST /api/events/[id]/invites/[memberId]/resend",
      error,
    );
    return Response.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 500 });
  }
}
