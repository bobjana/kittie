import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { client } from "@/db/client";
import * as schema from "@/db/schema";
import {
  buildJpegBuffer,
  buildPngBuffer,
  JPEG_EXIF_MARKER,
  PNG_EXIF_MARKER,
} from "../fixtures/generate-receipt-fixtures";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error("TEST_DATABASE_URL is not set");
}

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: getSessionMock } },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

const USER_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const USER_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const USER_C = "cccccccc-0000-4000-8000-00000000000c";

function sessionFor(userId: string, email: string) {
  return {
    session: { id: "s", userId, expiresAt: new Date() },
    user: { id: userId, email },
  };
}

let sql: ReturnType<typeof postgres>;
let storageDir: string;
let receiptsRoute: typeof import("../../src/app/api/receipts/route");
let fileRoute: typeof import("../../src/app/api/receipts/[id]/file/route");

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createOrganizedEvent(): Promise<{
  eventId: string;
  organizerMemberId: string;
}> {
  const rows = await sql<Array<{ id: string }>>`
    insert into events (name, organizer_user_id, currency)
    values ('Trip', ${USER_A}, 'EUR') returning id
  `;
  const eventId = rows[0].id;
  const members = await sql<Array<{ id: string }>>`
    insert into event_members (event_id, user_id, email_normalized, role, status, joined_at)
    values (${eventId}, ${USER_A}, 'a@example.com', 'organizer', 'active', now())
    returning id
  `;
  return { eventId, organizerMemberId: members[0].id };
}

function postReceipt(
  eventId: string,
  bytes: Uint8Array,
  filename = "receipt.jpg",
): Promise<Response> {
  const form = new FormData();
  form.set("eventId", eventId);
  form.set("file", new Blob([bytes as unknown as BlobPart]), filename);
  return receiptsRoute.POST(
    new Request("http://localhost/api/receipts", {
      method: "POST",
      body: form,
    }),
  );
}

function getReceiptFile(
  receiptId: string,
  extraHeaders?: HeadersInit,
): Promise<Response> {
  return fileRoute.GET(
    new Request(`http://localhost/api/receipts/${receiptId}/file`, {
      headers: extraHeaders,
    }),
    { params: Promise.resolve({ id: receiptId }) },
  );
}

async function storedBytes(receiptId: string): Promise<Buffer> {
  const rows = await sql<Array<{ object_key: string }>>`
    select object_key from receipts where id = ${receiptId}
  `;
  const key = rows[0].object_key;
  return readFile(path.join(storageDir, key));
}

beforeAll(async () => {
  // src/services/receipts.ts imports @/lib/env which fail-fasts on missing
  // variables at import time; provide dummies before the route imports.
  const REQUIRED_ENV: Record<string, string> = {
    DATABASE_URL: "postgres://unused:unused@localhost:5432/unused",
    BETTER_AUTH_SECRET: "integration-test-secret",
    BETTER_AUTH_URL: "http://localhost:3100",
    APP_URL: "http://localhost:3100",
    EMAIL_FROM: "kittie@test.local",
    SMTP_URL: "smtp://localhost:1025",
  };
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  storageDir = mkdtempSync(path.join(os.tmpdir(), "kittie-receipts-test-"));
  process.env.RECEIPT_STORAGE_DIR = storageDir;
  process.env.RECEIPT_MAX_BYTES = String(10 * 1024 * 1024);

  sql = postgres(url, { max: 1 });
  await sql`drop schema if exists public cascade`;
  // The drizzle schema holds the migrations journal; dropping it forces the
  // migrator to re-apply everything into the recreated public schema.
  await sql`drop schema if exists drizzle cascade`;
  await sql`create schema public`;
  const db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: "drizzle" });

  receiptsRoute = await import("../../src/app/api/receipts/route");
  fileRoute = await import("../../src/app/api/receipts/[id]/file/route");
});

afterAll(async () => {
  rmSync(storageDir, { recursive: true, force: true });
  await sql?.end();
  await client.end();
});

beforeEach(async () => {
  await sql`truncate table events cascade`;
  getSessionMock.mockReset();
});

describe("POST /api/receipts", () => {
  it("returns 401 UNAUTHENTICATED without a session", async () => {
    getSessionMock.mockResolvedValue(null);
    const { eventId } = await createOrganizedEvent();

    const response = await postReceipt(eventId, await buildJpegBuffer());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
  });

  it("returns 404 for a non-member and never reveals receipt storage", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_B, "b@example.com"));
    const { eventId } = await createOrganizedEvent();

    const response = await postReceipt(eventId, await buildJpegBuffer());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("stores an uploaded JPEG rotated, resized and EXIF-stripped", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const { eventId } = await createOrganizedEvent();

    const jpeg = await buildJpegBuffer();
    const response = await postReceipt(eventId, jpeg);
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      receiptId: string;
      ocr: { status: string; jobId: string };
    };
    expect(body.ocr.status).toBe("queued");
    expect(body.ocr.jobId).toMatch(/^[0-9a-f-]{36}$/);

    const stored = await storedBytes(body.receiptId);
    expect(stored.length).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(stored.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(stored.toString("latin1")).not.toContain(JPEG_EXIF_MARKER);
    expect(stored.toString("latin1")).not.toContain("Exif");
  });

  it("caps the stored dimensions at 2000px and applies EXIF rotation", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const { eventId } = await createOrganizedEvent();

    const response = await postReceipt(eventId, await buildJpegBuffer());
    const { receiptId } = (await response.json()) as { receiptId: string };

    const rows = await sql<
      Array<{ width: number; height: number; mime: string }>
    >`
      select width, height, mime from receipts where id = ${receiptId}
    `;
    expect(rows[0].mime).toBe("image/jpeg");
    expect(rows[0].width).toBe(1333);
    expect(rows[0].height).toBe(2000);
  });

  it("records sha256 matching the stored file", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const { eventId } = await createOrganizedEvent();

    const response = await postReceipt(eventId, await buildJpegBuffer());
    const { receiptId } = (await response.json()) as { receiptId: string };

    const rows = await sql<Array<{ sha256: string | null }>>`
      select sha256 from receipts where id = ${receiptId}
    `;
    const stored = await storedBytes(receiptId);
    expect(rows[0].sha256).toBe(sha256(stored));
  });

  it("re-encodes an uploaded PNG to a stripped JPEG", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const { eventId } = await createOrganizedEvent();

    const response = await postReceipt(
      eventId,
      await buildPngBuffer(),
      "receipt.png",
    );
    expect(response.status).toBe(201);
    const { receiptId } = (await response.json()) as { receiptId: string };

    const stored = await storedBytes(receiptId);
    expect(stored.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(stored.toString("latin1")).not.toContain(PNG_EXIF_MARKER);
    const rows = await sql<
      Array<{ width: number; height: number; mime: string }>
    >`
      select width, height, mime from receipts where id = ${receiptId}
    `;
    expect(rows[0].mime).toBe("image/jpeg");
    expect(rows[0].width).toBe(1500);
    expect(rows[0].height).toBe(800);
  });

  it("returns 413 when the upload exceeds RECEIPT_MAX_BYTES", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const { eventId } = await createOrganizedEvent();

    const oversized = new Uint8Array(11 * 1024 * 1024);
    oversized.set([0xff, 0xd8, 0xff, 0xe0]);

    const response = await postReceipt(eventId, oversized);
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("RECEIPT_TOO_LARGE");
  });

  it("returns 415 for a renamed text file regardless of filename", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const { eventId } = await createOrganizedEvent();

    const text = new TextEncoder().encode("this is definitely not an image");
    const response = await postReceipt(eventId, text, "receipt.jpg");
    expect(response.status).toBe(415);
    expect((await response.json()).error).toBe("RECEIPT_UNSUPPORTED_TYPE");
  });

  it("returns 409 EVENT_CLOSED when the event is closed", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const { eventId } = await createOrganizedEvent();
    await sql`update events set status = 'closed' where id = ${eventId}`;

    const response = await postReceipt(eventId, await buildJpegBuffer());
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("EVENT_CLOSED");
  });

  it("tombstones the previous unattached receipt on a new upload", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const { eventId } = await createOrganizedEvent();

    const first = await postReceipt(eventId, await buildJpegBuffer());
    const firstBody = (await first.json()) as { receiptId: string };
    const firstKey = (
      await sql<Array<{ object_key: string }>>`
        select object_key from receipts where id = ${firstBody.receiptId}`
    )[0].object_key;

    const second = await postReceipt(eventId, await buildPngBuffer());
    const secondBody = (await second.json()) as { receiptId: string };
    expect(secondBody.receiptId).not.toBe(firstBody.receiptId);

    const rows = await sql<Array<{ id: string; deleted_at: string | null }>>`
      select id, deleted_at from receipts where event_id = ${eventId} order by created_at
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(firstBody.receiptId);
    expect(rows[0].deleted_at).not.toBeNull();
    expect(rows[1].id).toBe(secondBody.receiptId);
    expect(rows[1].deleted_at).toBeNull();

    expect(existsSync(path.join(storageDir, firstKey))).toBe(false);
  });

  it("never replaces a receipt already attached to an expense", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const { eventId, organizerMemberId } = await createOrganizedEvent();

    const first = await postReceipt(eventId, await buildJpegBuffer());
    const firstBody = (await first.json()) as { receiptId: string };
    const expense = await sql<Array<{ id: string }>>`
      insert into expenses (event_id, created_by, paid_by_member_id, total_minor, spent_on, split_mode)
      values (${eventId}, ${USER_A}, ${organizerMemberId}, 1000, current_date, 'equal')
      returning id
    `;
    await sql`update receipts set expense_id = ${expense[0].id} where id = ${firstBody.receiptId}`;

    const second = await postReceipt(eventId, await buildPngBuffer());
    const secondBody = (await second.json()) as { receiptId: string };
    expect(secondBody.receiptId).not.toBe(firstBody.receiptId);

    const rows = await sql<
      Array<{
        id: string;
        deleted_at: string | null;
        expense_id: string | null;
      }>
    >`
      select id, deleted_at, expense_id from receipts where event_id = ${eventId} order by created_at
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(firstBody.receiptId);
    expect(rows[0].deleted_at).toBeNull();
    expect(rows[0].expense_id).toBe(expense[0].id);
    expect(rows[1].deleted_at).toBeNull();
  });

  it("does not expose a filesystem path in the response", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const { eventId } = await createOrganizedEvent();

    const response = await postReceipt(eventId, await buildJpegBuffer());
    const text = await response.text();
    expect(text).not.toContain("receipts/");
    expect(text).not.toContain(storageDir);
  });
});

describe("GET /api/receipts/[id]/file", () => {
  it("streams the stored JPEG back to a member", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const { eventId } = await createOrganizedEvent();

    const upload = await postReceipt(eventId, await buildPngBuffer());
    const { receiptId } = (await upload.json()) as { receiptId: string };
    const stored = await storedBytes(receiptId);

    const response = await getReceiptFile(receiptId);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    expect(Number(response.headers.get("content-length"))).toBe(stored.length);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array(stored),
    );
  });

  it("serves an ETag and revalidates with 304 on If-None-Match", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const { eventId } = await createOrganizedEvent();

    const upload = await postReceipt(eventId, await buildJpegBuffer());
    const { receiptId } = (await upload.json()) as { receiptId: string };
    const stored = await storedBytes(receiptId);

    const first = await getReceiptFile(receiptId);
    const etag = first.headers.get("etag");
    expect(etag).toBe(`"${sha256(stored)}"`);

    const second = await getReceiptFile(receiptId, {
      "if-none-match": etag ?? "",
    });
    expect(second.status).toBe(304);
  });

  it("returns 404 for a non-member with no existence leak", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const { eventId } = await createOrganizedEvent();

    const upload = await postReceipt(eventId, await buildJpegBuffer());
    const { receiptId } = (await upload.json()) as { receiptId: string };

    getSessionMock.mockResolvedValue(sessionFor(USER_C, "c@example.com"));
    const response = await getReceiptFile(receiptId);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("returns 401 when unauthenticated", async () => {
    getSessionMock.mockResolvedValue(null);
    const response = await getReceiptFile(
      "123e4567-e89b-4000-8000-000000000001",
    );
    expect(response.status).toBe(401);
  });

  it("returns 404 for a tombstoned receipt", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    const { eventId } = await createOrganizedEvent();

    const first = await postReceipt(eventId, await buildJpegBuffer());
    const { receiptId } = (await first.json()) as { receiptId: string };
    await postReceipt(eventId, await buildPngBuffer());

    const response = await getReceiptFile(receiptId);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("returns 404 for an unknown or malformed receipt id", async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_A, "a@example.com"));
    await createOrganizedEvent();

    const unknown = await getReceiptFile(
      "123e4567-e89b-4000-8000-000000000002",
    );
    expect(unknown.status).toBe(404);

    const malformed = await getReceiptFile("../../etc/passwd");
    expect(malformed.status).toBe(404);
  });
});
