import {
  notificationErrorToResponse,
  resendNotification,
} from "@/services/notifications";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; settlementId: string }> },
): Promise<Response> {
  const { id, settlementId } = await params;
  const body = (await request.json().catch(() => null)) as {
    jobId?: unknown;
  } | null;

  if (typeof body?.jobId !== "string" || body.jobId === "") {
    return Response.json({ error: "INVALID_JOB" }, { status: 400 });
  }

  try {
    const job = await resendNotification(id, settlementId, body.jobId);
    return Response.json({ notification: job }, { status: 200 });
  } catch (error) {
    const response = notificationErrorToResponse(error);
    if (response) return response;
    console.error(
      "Unhandled error in POST /api/events/[id]/settlements/[settlementId]/notifications/resend",
      error,
    );
    return Response.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 500 });
  }
}
