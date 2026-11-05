import {
  getReceiptFile,
  receiptErrorToResponse,
} from "@/services/receipts";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  try {
    const file = await getReceiptFile(id);
    const etag = file.sha256 ? `"${file.sha256}"` : null;
    if (etag && request.headers.get("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          "Cache-Control": "private, max-age=300",
          ETag: etag,
        },
      });
    }
    const body = new Uint8Array(file.bytes);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(body.byteLength),
        "Cache-Control": "private, max-age=300",
        ...(etag ? { ETag: etag } : {}),
      },
    });
  } catch (error) {
    const response = receiptErrorToResponse(error);
    if (response) {
      return response;
    }
    console.error("Unhandled error in GET /api/receipts/[id]/file", error);
    return Response.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 500 });
  }
}
