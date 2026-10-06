# Urgent.ng Backend

NestJS modular monolith for the Urgent.ng errand marketplace. The authoritative
specification lives in `../doc/`:

- `Urgent.ng — Backend PRD.md` is the single backend specification (architecture, domain rules, data contracts, and the data dictionary)
- `Urgent.ng — Backend Build Plan.md` is the phased task list (start here when building)

## Stack

- NestJS 12 (ESM, TypeScript), modular monolith
- PostgreSQL 17 with PostGIS 3.5, Prisma ORM 6
- Redis + BullMQ for queues and background processing
- Pino (nestjs-pino) logging, Terminus health checks, Swagger docs
- vitest for unit and e2e tests, oxlint for linting

## Getting started

```bash
npm install
cp .env.example .env   # local defaults match docker-compose.yml
npm run db:up          # PostGIS (host port 5544) + Redis (host port 6399)
npm run prisma:generate
npx prisma migrate deploy   # applies committed migrations (enums, PostGIS)
npm run start:dev      # http://localhost:4000/api/v1
```

- Health check: `GET /api/v1/health`
- Swagger docs (non-production only): `http://localhost:4000/api/docs`
- Config is validated at boot. A missing or malformed required variable stops
  the app with a message naming it. In production, `JWT_SECRET`,
  `JWT_REFRESH_SECRET`, `DATA_ENCRYPTION_KEY` and `HMAC_SECRET` must each be at
  least 32 characters.
- Every external provider (KYC, maps, SMS, email, push, storage, payments) has a
  mode variable (`KYC_PROVIDER=fake|real`, and so on). The default is `fake`, so
  no vendor account is needed for development.

## Process types

Three entry points share one codebase (Backend PRD section 5.2):

| Command | Entry | Purpose |
|---|---|---|
| `npm run start:dev` / `start:prod` | `src/main.ts` | HTTP API |
| `npm run start:worker` | `src/workers/main.ts` | BullMQ processors and background jobs |
| `npm run start:scheduler` | `src/scheduler/main.ts` | Cron and timer-sweeper jobs (never run in the API process) |

## Scripts

- `npm run check` runs lint, build and unit tests (no database needed). Run it before every commit.
- `npm run check:full` also runs the integration and e2e tests (needs `npm run db:up`).
- `npm test` unit tests: pure and fast (`src/**/*.spec.ts`).
- `npm run test:int` integration tests against real PostgreSQL and Redis (`src/**/*.int-spec.ts`).
- `npm run test:e2e` end-to-end tests over HTTP (`test/**/*.e2e-spec.ts`).
- `npm run test:all` runs all three levels.
- `npm run prisma:migrate` creates a new migration during development.
- `npm run prisma:seed` runs `prisma/seed.ts` (through `tsx`).
- `npm run db:reset` drops and recreates the **development** database from the migrations. It is destructive.
- `npm run openapi` writes `openapi.json` with the real `/api/v1` paths.

## Testing safely

Integration and e2e tests never touch your development data. They run against
`<database>_test` (created automatically on the same server) and Redis
database 15. Override with `DATABASE_URL_TEST` and `REDIS_URL_TEST` if needed.
Every destructive test helper refuses to run unless the database name ends in
`_test` and Redis is not database 0.

## Structure

`src/` has one folder per domain module (auth, users, errands, offers,
assignments, execution, messaging, notifications, billing, entitlements, admin,
...), plus `common/` (guards, filters, interceptors, ...), `config/`,
`database/`, `health/`, `scheduler/` and `workers/`. Domain module folders
currently hold a placeholder module file that gets filled in during the build
(see the Build Plan).

`src/app.setup.ts` holds the HTTP configuration (prefix, versioning, CORS,
helmet, validation) shared by `main.ts` and the e2e tests.

## Database notes

- Prisma cannot express PostGIS geography columns, partial unique indexes or
  CHECK constraints. Add those as hand-written SQL inside a Prisma migration
  (`prisma migrate dev --create-only`, then edit the SQL) and keep raw SQL inside repository classes (Backend PRD section 26.1).
- The `enable_postgis` migration enables the extension.
