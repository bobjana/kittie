import { env } from "@/lib/env";
import { getOcrJob, processOcrJob } from "@/services/ocr";
import {
  createReceipt,
  receiptErrorToResponse,
} from "@/services/receipts";

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      {
        error: "INVALID_FORM",
        message: "the upload must be multipart/form-data with eventId and file",
      },
      { status: 400 },
    );
  }

  const eventId = form.get("eventId");
  const file = form.get("file");
  if (typeof eventId !== "string" || eventId === "") {
    return Response.json(
      { error: "MISSING_EVENT", message: "the eventId field is required" },
      { status: 400 },
    );
  }
  if (!(file instanceof File)) {
    return Response.json(
      { error: "MISSING_FILE", message: "the file field is required" },
      { status: 400 },
    );
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await createReceipt(eventId, bytes);
    if (env.OCR_INLINE && result.ocr.jobId) {
      await processOcrJob(result.ocr.jobId);
      const job = await getOcrJob(result.ocr.jobId);
      const ocr = {
        status: job?.status ?? "queued",
        jobId: result.ocr.jobId,
        ...(job?.errorCode ? { errorCode: job.errorCode } : {}),
      };
      return Response.json({ receiptId: result.receiptId, ocr }, { status: 201 });
    }
    return Response.json(result, { status: 201 });
  } catch (error) {
    const response = receiptErrorToResponse(error);
    if (response) {
      return response;
    }
    console.error("Unhandled error in POST /api/receipts", error);
    return Response.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 500 });
  }
}
