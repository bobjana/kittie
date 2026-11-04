import { inviteErrorToResponse, revokeInvite } from "@/services/invites";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; memberId: string }> },
): Promise<Response> {
  const { id, memberId } = await params;
  try {
    await revokeInvite(id, memberId);
    return Response.json({ ok: true });
  } catch (error) {
    const response = inviteErrorToResponse(error);
    if (response) return response;
    console.error(
      "Unhandled error in DELETE /api/events/[id]/invites/[memberId]",
      error,
    );
    return Response.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 500 });
  }
}
