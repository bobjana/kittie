import { AuthorizationError } from "@/lib/authorization";
import {
  createEvent,
  EventValidationError,
  listEventsForUser,
} from "@/services/events";

export async function GET(): Promise<Response> {
  try {
    const events = await listEventsForUser();
    return Response.json({ events });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
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
    const { event } = await createEvent(body);
    return Response.json({ event }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

function toErrorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  if (error instanceof EventValidationError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: 400 },
    );
  }
  console.error("Unhandled error in /api/events", error);
  return Response.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 500 });
}
