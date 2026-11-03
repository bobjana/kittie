import { client, databaseUrl } from "../src/db/client";

const url = databaseUrl();
const target = `${new URL(url).host}${new URL(url).pathname}`;
console.log(`Resetting database schema on ${target}`);

try {
  await client`drop schema if exists public cascade`;
  await client`drop schema if exists drizzle cascade`;
  await client`create schema public`;
  console.log("Database reset complete");
} finally {
  await client.end();
}
