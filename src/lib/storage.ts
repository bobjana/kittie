import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { env } from "@/lib/env";

const UUID_CHARS =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const UUID_PATTERN = new RegExp(`^${UUID_CHARS}$`);

const OBJECT_KEY_PATTERN = new RegExp(
  `^(${UUID_CHARS})/(${UUID_CHARS})\\.jpg$`,
);

/** Thrown when an object key is malformed or would escape the storage root. */
export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

/**
 * Builds the private object key for a new receipt: `<eventId>/<uuid>.jpg`.
 * The event id must be a UUID; the file name is generated server-side, so a
 * client can never influence the storage path.
 */
export function receiptObjectKey(eventId: string): string {
  if (!UUID_PATTERN.test(eventId)) {
    throw new StorageError("eventId must be a UUID");
  }
  return `${eventId}/${randomUUID()}.jpg`;
}

/**
 * True only for keys this module ever produced. Anything else - including
 * keys with `..`, absolute paths, or unexpected extensions - is rejected
 * before any filesystem operation touches it.
 */
export function isValidReceiptObjectKey(objectKey: string): boolean {
  return OBJECT_KEY_PATTERN.test(objectKey);
}

function receiptFilePath(objectKey: string): string {
  if (!isValidReceiptObjectKey(objectKey)) {
    throw new StorageError("object key is not a receipt key");
  }
  const base = path.resolve(env.RECEIPT_STORAGE_DIR);
  const full = path.resolve(base, objectKey);
  if (!full.startsWith(base + path.sep)) {
    throw new StorageError("object key escapes the storage directory");
  }
  return full;
}

export async function saveReceiptFile(
  objectKey: string,
  data: Uint8Array,
): Promise<void> {
  const full = receiptFilePath(objectKey);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, data);
}

export async function readReceiptFile(objectKey: string): Promise<Buffer> {
  return readFile(receiptFilePath(objectKey));
}

export async function deleteReceiptFile(objectKey: string): Promise<void> {
  try {
    await unlink(receiptFilePath(objectKey));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
}
