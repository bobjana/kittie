# Kittie

Mobile-first shared-expense splitter: split bills with friends, exactly to the cent.

This is the bootstrap of the app (work plan todo 1). Only the app shell, local
Docker stack, environment validation, health endpoint and the quality gate exist
so far; auth, events, expenses and reports land in later todos.

## Prerequisites

- [Bun](https://bun.sh) 1.4+
- Docker with Compose v2 (Postgres 17 and Mailpit run in containers)

## Setup

```bash
bun install --frozen-lockfile
cp .env.example .env   # already provided locally; adjust secrets for anything shared
docker compose up -d postgres mailpit
```

The app runs on http://localhost:3100. Postgres publishes on host port 5433 and
Mailpit on SMTP 1025 / UI 8025.

## Scripts

| Command                 | Purpose                                          |
| ----------------------- | ------------------------------------------------ |
| `bun run dev`           | Dev server on :3100                              |
| `bun run build`         | Production build                                 |
| `bun run start`         | Production server on :3100                       |
| `bun run typecheck`     | `next typegen` + `tsc --noEmit`                  |
| `bun run lint`          | Biome check                                      |
| `bun run format`        | Biome format (write)                             |
| `bun run test`          | Vitest unit tests                                |
| `bun run test:integration` | Vitest integration tests (needs Postgres up)  |
| `bun run test:e2e`      | Playwright (boots the dev server automatically)  |
| `bun run verify`        | typecheck → lint → test → integration → build → e2e |
| `bun run db:*`          | Pending stubs (completed in todo 2)              |
| `bun run worker`        | Pending stub (completed in todo 16)              |

## Health check

```bash
curl -fsS http://localhost:3100/api/health
# {"status":"ok"}
```
