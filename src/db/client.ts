import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function databaseUrl(): string {
  const url =
    process.env.NODE_ENV === "test"
      ? process.env.TEST_DATABASE_URL
      : process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      process.env.NODE_ENV === "test"
        ? "TEST_DATABASE_URL is not set"
        : "DATABASE_URL is not set",
    );
  }
  return url;
}

const client = postgres(databaseUrl(), { max: 1 });

export const db = drizzle(client, { schema });

export { client };
