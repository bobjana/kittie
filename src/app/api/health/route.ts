export function GET(): Response {
  // Liveness only; the real database check is todo 24.
  return Response.json({ status: "ok" });
}
