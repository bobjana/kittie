import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

const env = loadEnv("test", process.cwd(), "");
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is required for integration tests (see .env.example)",
  );
}

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // The services under test import src/lib/env.ts, which fail-fasts on
    // missing variables. Vitest does not load .env into the worker, so the
    // variables are injected here; the explicit TEST_DATABASE_URL wins so a
    // per-row scratch database is honoured. NODE_ENV=test keeps the app's db
    // client on TEST_DATABASE_URL, never DATABASE_URL.
    env: { ...env, TEST_DATABASE_URL: testDatabaseUrl },
  },
});
