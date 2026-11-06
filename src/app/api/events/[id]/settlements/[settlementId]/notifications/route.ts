import {
  listSettlementNotifications,
  notificationErrorToResponse,
} from "@/services/notifications";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; settlementId: string }> },
): Promise<Response> {
  const { id, settlementId } = await params;

  try {
    const result = await listSettlementNotifications(id, settlementId);
    return Response.json(result, { status: 200 });
  } catch (error) {
    const response = notificationErrorToResponse(error);
    if (response) return response;
    console.error(
      "Unhandled error in GET /api/events/[id]/settlements/[settlementId]/notifications",
      error,
    );
    return Response.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 500 });
  }
}
