import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error("TEST_DATABASE_URL is not set");
}

const eventId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const organizerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const memberId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const expenseId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const otherUserId = "11111111-1111-4111-8111-111111111111";

let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  sql = postgres(url, { max: 1 });
  await sql`drop schema if exists public cascade`;
  await sql`drop schema if exists drizzle cascade`;
  await sql`create schema public`;
  const db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: "drizzle" });

  await sql`insert into events (id, name, organizer_user_id) values (${eventId}, 'Test event', ${otherUserId})`;
  await sql`insert into event_members (id, event_id, email_normalized, role, status) values (${organizerId}, ${eventId}, 'organizer@example.com', 'organizer', 'active')`;
  await sql`insert into event_members (id, event_id, email_normalized, role, status) values (${memberId}, ${eventId}, 'friend@example.com', 'member', 'active')`;
  await sql`insert into expenses (id, event_id, paid_by_member_id, total_minor, spent_on) values (${expenseId}, ${eventId}, ${organizerId}, 3000, '2026-11-03')`;
  await sql`insert into expense_participants (expense_id, member_id) values (${expenseId}, ${organizerId})`;
  await sql`insert into expense_participants (expense_id, member_id) values (${expenseId}, ${memberId})`;
});

afterAll(async () => {
  await sql?.end();
});

describe("schema constraints", () => {
  it("rejects a negative expense total", async () => {
    await expect(
      sql`insert into expenses (event_id, total_minor, spent_on) values (${eventId}, -1, '2026-11-03')`,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a duplicate (expense_id, member_id) participant", async () => {
    await expect(
      sql`insert into expense_participants (expense_id, member_id) values (${expenseId}, ${organizerId})`,
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects a duplicate active member email per event", async () => {
    await expect(
      sql`insert into event_members (event_id, email_normalized, status) values (${eventId}, 'organizer@example.com', 'active')`,
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects an expense with a missing event foreign key", async () => {
    await expect(
      sql`insert into expenses (event_id, total_minor, spent_on) values ('99999999-9999-4999-8999-999999999999', 100, '2026-11-03')`,
    ).rejects.toMatchObject({ code: "23503" });
  });
});
