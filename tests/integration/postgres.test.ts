import postgres from "postgres";
import { describe, expect, it } from "vitest";

describe("compose Postgres", () => {
  it("connects and runs SELECT 1", async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) {
      throw new Error("TEST_DATABASE_URL is not set");
    }
    const sql = postgres(url, { max: 1 });
    try {
      const rows = await sql<Array<{ one: number }>>`SELECT 1 AS one`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.one).toBe(1);
    } finally {
      await sql.end();
    }
  });
});
