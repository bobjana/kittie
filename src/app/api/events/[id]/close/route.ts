import { closeEvent, settlementErrorToResponse } from "@/services/settlements";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  try {
    const result = await closeEvent(id);
    return Response.json(result, { status: 200 });
  } catch (error) {
    const response = settlementErrorToResponse(error);
    if (response) return response;
    console.error("Unhandled error in POST /api/events/[id]/close", error);
    return Response.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 500 });
  }
}
