import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://unused:unused@localhost:5432/unused",
  TEST_DATABASE_URL: "postgres://unused:unused@localhost:5432/unused",
  BETTER_AUTH_SECRET: "unit-test-secret",
  BETTER_AUTH_URL: "http://localhost:3100",
  APP_URL: "http://localhost:3100",
  EMAIL_FROM: "kittie@test.local",
  SMTP_URL: "smtp://localhost:1025",
};

let storageDir: string;

beforeAll(() => {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
  storageDir = mkdtempSync(path.join(os.tmpdir(), "kittie-storage-test-"));
  process.env.RECEIPT_STORAGE_DIR = storageDir;
});

afterAll(() => {
  rmSync(storageDir, { recursive: true, force: true });
});

const loadStorage = async () => import("@/lib/storage");

describe("receiptObjectKey", () => {
  it("generates an eventId-scoped jpg key", async () => {
    const { receiptObjectKey } = await loadStorage();
    const eventId = "123e4567-e89b-12d3-a456-426614174000";
    const key = receiptObjectKey(eventId);
    expect(key).toMatch(
      /^123e4567-e89b-12d3-a456-426614174000\/[0-9a-f-]{36}\.jpg$/,
    );
  });

  it("rejects a non-uuid event id", async () => {
    const { receiptObjectKey } = await loadStorage();
    expect(() => receiptObjectKey("../evil")).toThrow();
    expect(() => receiptObjectKey("")).toThrow();
  });
});

describe("storage path validation", () => {
  const eventId = "123e4567-e89b-12d3-a456-426614174000";

  it("rejects traversal keys before touching the filesystem", async () => {
    const { saveReceiptFile, readReceiptFile, deleteReceiptFile } =
      await loadStorage();
    const traversalKeys = [
      "../../etc/passwd",
      `${eventId}/../../../etc/passwd.jpg`,
      `/etc/passwd`,
      "not-a-uuid/123.jpg",
      `${eventId}/sub/dir/x.jpg`,
      `${eventId}/x.png`,
    ];
    for (const key of traversalKeys) {
      await expect(
        saveReceiptFile(key, new Uint8Array([1, 2, 3])),
      ).rejects.toThrow(/object key/i);
      await expect(readReceiptFile(key)).rejects.toThrow(/object key/i);
      await expect(deleteReceiptFile(key)).rejects.toThrow(/object key/i);
    }
  });

  it("round-trips bytes under the event directory", async () => {
    const { saveReceiptFile, readReceiptFile, receiptObjectKey } =
      await loadStorage();
    const key = receiptObjectKey(eventId);
    const data = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    await saveReceiptFile(key, data);
    const read = await readReceiptFile(key);
    expect(Buffer.from(read)).toEqual(Buffer.from(data));
    const expectedPath = path.join(
      storageDir,
      eventId,
      key.split("/")[1] ?? "",
    );
    expect(
      path.resolve(expectedPath).startsWith(path.resolve(storageDir)),
    ).toBe(true);
  });

  it("deletes idempotently", async () => {
    const {
      saveReceiptFile,
      readReceiptFile,
      deleteReceiptFile,
      receiptObjectKey,
    } = await loadStorage();
    const key = receiptObjectKey(eventId);
    await saveReceiptFile(key, new Uint8Array([9]));
    await deleteReceiptFile(key);
    await expect(readReceiptFile(key)).rejects.toThrow(/ENOENT/);
    await expect(deleteReceiptFile(key)).resolves.toBeUndefined();
  });
});
