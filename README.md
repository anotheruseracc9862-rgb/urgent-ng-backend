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
- `npm run prisma:seed` runs `prisma/seed.ts` (through `tsx`). Safe to run again: it loads config defaults, products and prices, admin permissions and roles, categories, prohibited-item rules and policy version 1.0, and never overwrites an admin change.
- `npm run admin:create -- --email you@urgent.ng --name "Your Name"` creates the first super-admin (run the seed first). The password comes from `ADMIN_PASSWORD` (12+ characters) or is generated and printed once. The admin sets up an authenticator app at the first login.
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

## Deleting data

One database login (`DATABASE_URL`) is used everywhere.

- Soft-deletable tables have `deleted_at`. `prisma.client` (the soft-delete extension) turns `delete` into an update and hides deleted rows; use `withDeleted()` to see them.
- The database backs this up with triggers: a raw `DELETE` on a soft-deletable or never-deleted table (audit log, price versions, config, products) is rejected. `audit_logs` and `price_versions` also reject `UPDATE`.
- Transient tables (outbox events, idempotency keys, later sessions and location history) are deleted for real by cleanup jobs.
- Time rule: compare against the **database clock** (`NOW()`, `clock_timestamp()`), never a JavaScript `Date`, whenever the value is later compared in SQL. The outbox and config store follow this.

## Identity and access

- **Routes** follow Backend PRD 30.1: `/auth/*` (register, OTP, login, refresh, logout, password reset), `/me/*` (profile, sessions, preferences, consents, devices, deactivate and delete request), `/users/:id` and `/users/:id/block`, `/reference/*` (public categories, prohibited items and policies), `/admin/auth/*` (admin login).
- **Tokens.** Web clients get the access token (`ung_at`) and refresh token (`ung_rt`) as HTTP-only, SameSite=Strict cookies, and no token appears in the body. Mobile and other clients send `X-Client: mobile` and get the tokens in the body. The refresh token rotates on every use; replaying an old one ends that login.
- **Protect a route** with `@ConsumerAuth()` (ACTIVE accounts only) or `@ConsumerAuth({ allow: ['DEACTIVATED'] })`. Add `@RequireNoRestriction('POSTING')` and `@RequiresPolicyAcceptance()` where needed. Admin routes use `@AdminAuth('USERS_VIEW')`. The module that owns the controller imports `AuthModule` or `AdminModule`.
- **Admins** are a separate trust boundary: another signing key, audience `urgent-admin`, cookies `ung_admin_at` / `ung_admin_rt`, and mandatory TOTP. Login is two steps (`/admin/auth/login`, then `/admin/auth/mfa/verify`; `/admin/auth/mfa/enrol` on the first login).
- **Errors** use the standard envelope with codes such as `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`, `OTP_INVALID`, `OTP_EXPIRED`, `OTP_RATE_LIMITED`, `IDENTIFIER_TAKEN`, `POLICY_ACCEPTANCE_REQUIRED`.
- **Limits** (OTP attempts and caps, login lockout, token lifetimes, deletion grace period, admin session length) are config keys editable by an admin, not constants.
- **Tests.** HTTP tests set `RATE_LIMIT_DISABLED=true` (honoured only when `NODE_ENV=test`) so one test can log in many times. The rate limiter itself is tested separately.
- **Account deletion** finishes in the scheduler: after the grace period an account becomes `DELETED` (sessions and devices ended), and after `ANONYMISATION_DAYS` its personal data is scrubbed. Both steps wait while a registered `DELETION_BLOCKERS` entry reports an open case.
- **OpenAPI.** `npm run build && npm run openapi` writes `openapi.json` (the same document Swagger shows at `/api/docs` outside production). Request schemas come from the class-validator decorators on `*.dto.ts` files (Swagger compiler plugin, active in `nest build`). For responses, add a response class to a `*.dto.ts` file and annotate the route with `@ApiEnveloped(ThatClass)` and `@ApiErrors(...)`; protected routes add `@ApiConsumerAuth()` or `@ApiAdminAuth()`. `openapi.int-spec.ts` fails if a route lacks a documented success response or if a real response differs from its documented shape. The frontend generates its client with `npx openapi-typescript openapi.json -o api.d.ts`.
- **Not built yet:** quiet hours in notification preferences (needs the notification module).

## Media and storage

- **Flow.** `POST /media/uploads` (with an `Idempotency-Key` header) returns a presigned PUT; the client uploads the file straight to storage; `POST /media/:id/confirm`; then poll `GET /media/:id` until `status` is `READY` or `REJECTED`. Downloads use `GET /media/:id/url`, which returns a short-lived signed URL only if the caller may see that file. File bytes never pass through the API.
- **Limits.** JPEG, PNG and WebP only, `MAX_UPLOAD_BYTES` (5 MB) per file, hard cap `SERVER_HARD_UPLOAD_BYTES` (8 MB). Config keys `MEDIA_UPLOAD_URL_SECONDS`, `MEDIA_DOWNLOAD_URL_SECONDS`, `MEDIA_ORPHAN_HOURS`, `MEDIA_MAX_DIMENSION` are editable by an admin.
- **Processing** runs in the worker process (`npm run start:worker`): real type from the file bytes, EXIF and GPS removed, scaled to 1600 px, 320 px thumbnail, moderation hook. Start the scheduler (`npm run start:scheduler`) to delete abandoned uploads.
- **Attach media from another module** with `MediaService.requireReadyOwned(userId, mediaId, purpose)`. **Let other users see a purpose** by registering a `MediaAccessPolicy` on `MediaAccessService` in `onModuleInit`; a purpose with no policy is visible to its owner only.
- **Storage.** `STORAGE_PROVIDER=fake` (default, in memory) or `real` (AWS S3; set `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`). Keep the bucket private.
- **Profile photo.** `PUT /me/photo` with a `READY` `PROFILE_PHOTO`, `DELETE /me/photo`.
- **Tests.** `src/test/media.helper.ts` builds real images (with GPS EXIF if asked) and walks the upload flow against the fake storage.
