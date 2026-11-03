import { migrate } from "drizzle-orm/postgres-js/migrator";
import { client, db } from "./client";

try {
  await migrate(db, { migrationsFolder: "drizzle" });
  console.log("Migrations applied successfully");
} catch (error) {
  console.error("Migration failed:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}
