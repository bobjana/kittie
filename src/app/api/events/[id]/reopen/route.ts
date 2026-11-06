import { reopenEvent, settlementErrorToResponse } from "@/services/settlements";

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

  const confirm =
    typeof body === "object" && body !== null && "confirm" in body
      ? (body as { confirm: unknown }).confirm
      : undefined;

  try {
    const result = await reopenEvent(id, confirm);
    return Response.json(result, { status: 200 });
  } catch (error) {
    const response = settlementErrorToResponse(error);
    if (response) return response;
    console.error("Unhandled error in POST /api/events/[id]/reopen", error);
    return Response.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 500 });
  }
}
