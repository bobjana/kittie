import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { eventMembers, receipts } from "@/db/schema";
import { AuthorizationError, requireSession } from "@/lib/authorization";
import { getOcrJob } from "@/services/ocr";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireSession();
    const { id } = await context.params;
    if (!UUID_PATTERN.test(id)) {
      throw new AuthorizationError(404, "NOT_FOUND", "OCR job not found");
    }

    const job = await getOcrJob(id);
    if (!job) {
      throw new AuthorizationError(404, "NOT_FOUND", "OCR job not found");
    }

    const receipt = await db.query.receipts.findFirst({
      where: eq(receipts.id, job.receiptId),
    });
    if (!receipt || receipt.deletedAt !== null) {
      throw new AuthorizationError(404, "NOT_FOUND", "OCR job not found");
    }

    const isUploader =
      receipt.uploadedBy !== null && receipt.uploadedBy === session.user.id;
    if (!isUploader) {
      const membership = await db.query.eventMembers.findFirst({
        where: and(
          eq(eventMembers.eventId, receipt.eventId),
          eq(eventMembers.userId, session.user.id),
          eq(eventMembers.status, "active"),
        ),
      });
      if (!membership) {
        throw new AuthorizationError(404, "NOT_FOUND", "OCR job not found");
      }
    }

    return Response.json({
      id: job.id,
      status: job.status,
      attempts: job.attempts,
      result: job.result,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
    });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return Response.json({ error: error.code }, { status: error.status });
    }
    console.error("Unhandled error in GET /api/ocr-jobs/[id]", error);
    return Response.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 500 });
  }
}
