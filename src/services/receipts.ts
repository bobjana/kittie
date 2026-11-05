import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";

import sharp from "sharp";

import { db } from "@/db/client";
import { ocrJobs, receipts } from "@/db/schema";
import {
  AuthorizationError,
  requireEventMember,
  requireSession,
} from "@/lib/authorization";
import { env } from "@/lib/env";
import {
  deleteReceiptFile,
  readReceiptFile,
  receiptObjectKey,
  saveReceiptFile,
} from "@/lib/storage";

export const RECEIPT_CODES = {
  RECEIPT_TOO_LARGE: "RECEIPT_TOO_LARGE",
  RECEIPT_UNSUPPORTED_TYPE: "RECEIPT_UNSUPPORTED_TYPE",
  RECEIPT_UNPROCESSABLE: "RECEIPT_UNPROCESSABLE",
  RECEIPT_FILE_MISSING: "RECEIPT_FILE_MISSING",
  EVENT_CLOSED: "EVENT_CLOSED",
} as const;

export type ReceiptCode = (typeof RECEIPT_CODES)[keyof typeof RECEIPT_CODES];

export class ReceiptError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = "ReceiptError";
    this.status = status;
    this.code = code;
  }
}

export function receiptErrorToResponse(error: unknown): Response | null {
  if (error instanceof AuthorizationError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  if (error instanceof ReceiptError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }
  return null;
}

const MAX_EDGE_PX = 2000;
const JPEG_QUALITY = 82;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type DetectedImageType = "jpeg" | "png" | "webp";

/**
 * Detects the image type from magic bytes only; the client-supplied MIME type
 * and filename are never trusted.
 */
function detectImageType(bytes: Uint8Array): DetectedImageType | null {
  if (bytes.length < 12) {
    return null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  const riff = String.fromCharCode(...bytes.subarray(0, 4));
  const webp = String.fromCharCode(...bytes.subarray(8, 12));
  if (riff === "RIFF" && webp === "WEBP") {
    return "webp";
  }
  return null;
}

export interface UploadedReceipt {
  receiptId: string;
  ocr: { status: string; jobId?: string };
}

export interface ReceiptFile {
  bytes: Buffer;
  sha256: string | null;
}

/**
 * Security contract: uploads are validated by magic bytes (never the client
 * MIME or filename), re-encoded to a clean JPEG that strips all EXIF
 * metadata, and written under a server-generated object key. Replaces the
 * uploader's previous unattached receipt for the event.
 */
export async function createReceipt(
  eventId: string,
  bytes: Uint8Array,
): Promise<UploadedReceipt> {
  if (!UUID_PATTERN.test(eventId)) {
    throw new AuthorizationError(404, "NOT_FOUND", "event not found");
  }

  const { event, member } = await requireEventMember(eventId);
  if (event.status !== "open") {
    throw new ReceiptError(
      409,
      RECEIPT_CODES.EVENT_CLOSED,
      "the event is closed and read-only",
    );
  }

  if (bytes.length > env.RECEIPT_MAX_BYTES) {
    throw new ReceiptError(
      413,
      RECEIPT_CODES.RECEIPT_TOO_LARGE,
      "the photo exceeds the maximum size",
    );
  }

  const detected = detectImageType(bytes);
  if (!detected) {
    throw new ReceiptError(
      415,
      RECEIPT_CODES.RECEIPT_UNSUPPORTED_TYPE,
      "the upload is not a JPEG, PNG or WebP image",
    );
  }

  let encoded: Buffer;
  let width: number;
  let height: number;
  try {
    const output = await sharp(Buffer.from(bytes))
      .rotate()
      .resize({
        width: MAX_EDGE_PX,
        height: MAX_EDGE_PX,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    encoded = output.data;
    width = output.info.width;
    height = output.info.height;
  } catch {
    throw new ReceiptError(
      415,
      RECEIPT_CODES.RECEIPT_UNPROCESSABLE,
      "the image could not be decoded",
    );
  }

  const sha256 = createHash("sha256").update(encoded).digest("hex");
  const objectKey = receiptObjectKey(eventId);
  await saveReceiptFile(objectKey, encoded);

  const uploaderUserId = member.userId;
  if (uploaderUserId === null) {
    throw new AuthorizationError(404, "NOT_FOUND", "event not found");
  }

  const lockKey = `${eventId}:${uploaderUserId}`;
  const { receiptId, jobId, tombstoned } = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );

    const stale = await tx
      .select({ id: receipts.id, objectKey: receipts.objectKey })
      .from(receipts)
      .where(
        and(
          eq(receipts.eventId, eventId),
          eq(receipts.uploadedBy, uploaderUserId),
          isNull(receipts.expenseId),
          isNull(receipts.deletedAt),
        ),
      )
      .for("update");

    const [receipt] = await tx
      .insert(receipts)
      .values({
        eventId,
        uploadedBy: uploaderUserId,
        objectKey,
        mime: "image/jpeg",
        sizeBytes: encoded.length,
        width,
        height,
        sha256,
      })
      .returning();

    const [job] = await tx
      .insert(ocrJobs)
      .values({ receiptId: receipt.id, status: "queued" })
      .returning();

    for (const old of stale) {
      await tx
        .update(receipts)
        .set({ deletedAt: new Date() })
        .where(eq(receipts.id, old.id));
    }

    return { receiptId: receipt.id, jobId: job.id, tombstoned: stale };
  });

  for (const old of tombstoned) {
    try {
      await deleteReceiptFile(old.objectKey);
    } catch {
      // Best effort cleanup: the DB tombstone already hides the old file.
    }
  }

  return { receiptId, ocr: { status: "queued", jobId } };
}

/**
 * Security contract: non-members, tombstoned and missing receipts all get
 * the same 404 (no existence leak) and the storage path never leaves the
 * server.
 */
export async function getReceiptFile(receiptId: string): Promise<ReceiptFile> {
  // Authentication must be established before any receipt lookup so an
  // unauthenticated caller always receives 401, never a leaky 404.
  await requireSession();
  if (!UUID_PATTERN.test(receiptId)) {
    throw new AuthorizationError(404, "NOT_FOUND", "receipt not found");
  }

  const receipt = await db.query.receipts.findFirst({
    where: eq(receipts.id, receiptId),
  });
  if (!receipt || receipt.deletedAt !== null) {
    throw new AuthorizationError(404, "NOT_FOUND", "receipt not found");
  }

  await requireEventMember(receipt.eventId);

  let bytes: Buffer;
  try {
    bytes = await readReceiptFile(receipt.objectKey);
  } catch {
    throw new ReceiptError(
      404,
      RECEIPT_CODES.RECEIPT_FILE_MISSING,
      "receipt file is unavailable",
    );
  }
  return { bytes, sha256: receipt.sha256 };
}
