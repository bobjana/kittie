import { expenseErrorToResponse, voidExpense } from "@/services/expenses";

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

  try {
    const result = await voidExpense(id, body);
    return Response.json(result, { status: 200 });
  } catch (error) {
    const response = expenseErrorToResponse(error);
    if (response) {
      return response;
    }
    console.error("Unhandled error in POST /api/expenses/[id]/void", error);
    return Response.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 500 });
  }
}
