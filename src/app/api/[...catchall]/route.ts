function jsonNotFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

// JSON 404 for unknown /api/* paths instead of the HTML 404 page.
export const GET = jsonNotFound;
export const HEAD = jsonNotFound;
export const POST = jsonNotFound;
export const PUT = jsonNotFound;
export const PATCH = jsonNotFound;
export const DELETE = jsonNotFound;
