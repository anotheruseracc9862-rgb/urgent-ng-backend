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
  mode that follows `NODE_ENV`: `fake` in development and test (no vendor account
  needed), `real` in production, where `fake` is refused at boot. To try one live
  vendor in development, set its variable (`STORAGE_PROVIDER=real`, `KYC_PROVIDER=real`,
  and so on); leave it unset otherwise.

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

**Which tests to run, and when.** The integration suite is the slow one (real database, real Redis, hundreds of HTTP flows), so do not run all of it after every edit:

| When | Command | Takes |
|---|---|---|
| While writing code | `npm test` (unit tests, no database) | seconds |
| After changing one area | `npx vitest run --config ./vitest.config.int.ts src/errands` (any folder or file) | under a minute |
| Before moving on | `npm run test:int:changed` (only the files your uncommitted changes can affect) | one to a few minutes |
| End of a phase, before a commit or release | `npm run check:full` (lint, types, build, unit, all integration, e2e) | the full run |

Integration tests hash passwords at the cheapest Argon2 setting (only when `NODE_ENV=test`), and long suites create their users once instead of once per test. The 50,000-errand feed check is opt-in and not part of the full run (see "Errands and marketplace").

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
- **Storage.** `STORAGE_PROVIDER=fake` (default, in memory) or `real` (AWS S3; set `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`). Keep the bucket private. The IAM user needs `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on `arn:aws:s3:::BUCKET/*` **and `s3:ListBucket` on `arn:aws:s3:::BUCKET`**; without ListBucket, S3 answers 403 instead of 404 for an object that was never uploaded, and confirming such an upload fails with an error instead of `MEDIA_INVALID`. Add the bucket's CORS rule for the web origins (PUT, GET, HEAD).
- **Profile photo.** `PUT /me/photo` with a `READY` `PROFILE_PHOTO`, `DELETE /me/photo`.
- **Tests.** `src/test/media.helper.ts` builds real images (with GPS EXIF if asked) and walks the upload flow against the fake storage.

## Runner profile and verification

- **Routes.** `GET|PUT /runner/profile`, `PUT /runner/availability`, `GET /runner/eligibility`, `GET /verification`, `POST /verification/attempts` (with an `Idempotency-Key`), `GET /verification/attempts/:id`.
- **Verification flow.** Upload a selfie as media with purpose `VERIFICATION_INPUT` and wait for `READY`. Then `POST /verification/attempts` with the 11-digit `nin` and the `selfieMediaId`. The answer is the finished attempt (`VERIFIED` or `FAILED` with a `failureReason`). The NIN is never stored, logged or returned.
- **Check eligibility** with `RunnerEligibilityService` (`canOffer`, `canBrowseFeed`, `assertCanOffer`). Never re-implement these checks in another module.
- **Providers.** `KYC_PROVIDER=fake` (default) is deterministic by the last four digits of the NIN: `0000` selfie mismatch, `1111` NIN not found, `8888` timeout, `9999` provider error, anything else verified. `KYC_PROVIDER=real` needs `DOJAH_APP_ID`, `DOJAH_SECRET_KEY` and `DOJAH_BASE_URL`, and has not yet been run against the live sandbox.
- **Config** (editable by an admin): `VERIFICATION_ATTEMPTS_PER_FEE`, `VERIFICATION_RETRY_COOLDOWN_HOURS`, `VERIFICATION_VALIDITY_DAYS` (0 = never expires), `KYC_SELFIE_MATCH_THRESHOLD`, `KYC_REQUEST_TIMEOUT_SECONDS`, `STAGED_SELFIE_RETENTION_DAYS`, `RUNNER_AREA_MIN_KM`, `RUNNER_AREA_MAX_KM`. The scheduler (`npm run start:scheduler`) expires verifications and deletes staged selfies.

## Errands and marketplace

- **Requester routes.** `POST /errands` (a draft, may be incomplete), `PATCH /errands/:id`, `POST /errands/:id/publish` (needs an `Idempotency-Key`), `/cancel`, `/extend`, `/duplicate`, `GET /errands/mine?tab=DRAFT|OPEN|ACTIVE|PAST`, `GET /errands/:id` (the requester's full view, with exact locations and contacts).
- **Runner routes.** `GET /marketplace/errands` (feed: `sort=nearest|newest`, `category`, `budgetMin`, `budgetMax`, `timeMode`, `radiusKm`, `q`, cursor paging), `GET /marketplace/errands/map`, `GET /marketplace/errands/:id` (approximate view), `POST|DELETE /saved-errands/:errandId`, `GET /saved-errands`. Only an eligible runner gets in (`RunnerEligibilityService.assertCanBrowseFeed`).
- **Changing an errand's status.** Only `ErrandStateService.transition(tx, ...)` does it. It follows the table in `errand.state.ts`, locks the row, checks who and from which status, and writes the history, audit and outbox rows in the caller's transaction. Offers, assignments, execution and disputes call it inside their own transaction; they never update `errands.status` themselves.
- **Location privacy.** Exact points are stored in `errand_locations.exact_point` and leave the API only to the requester (and, later, the assigned runner). Every errand has a stable approximate point (500 m grid cell plus a private offset of up to 250 m, derived from `HMAC(secret, errand id + type)`); all feed distances come from it and are put in buckets. The response types of the marketplace have no field for an exact point, an address, a landmark or a contact. `errands.feed_point` is the approximate point of the pickup (else the destination) and carries the feed's spatial index.
- **Contacts** are AES-256-GCM ciphertext bound to the errand and the field; the database refuses plain text (`errand_contacts_encrypted_only`).
- **Deadlines.** `expires_at` is set at publishing (`ERRAND_EXPIRY_HOURS`, or 30 minutes before a scheduled start, never more than `SCHEDULED_ERRAND_MAX_OPEN_DAYS`). The scheduler's `ErrandExpirySweeper` and a check on reads move overdue OPEN errands to EXPIRED (database clock).
- **Hooks for later phases.** `OFFER_RECONFIRMATION_HOOK` (Phase 6 flags offers on a material edit) and `FEED_BOOST_SOURCE` (Phase 10 supplies active boosts to pin). Both have no-op defaults today. `errands.offer_count` is kept by the offer module.
- **Tests.** `src/test/errand.helper.ts` seeds categories and prohibited items, inserts an errand in any status, and has HTTP helpers. The 50,000-errand feed check is opt-in: `RUN_PERF=1 npx vitest run --config ./vitest.config.int.ts src/marketplace/feed.performance.int-spec.ts`.

## Ratings

- **Routes.** `POST /assignments/:id/ratings` (with an `Idempotency-Key`), `GET /assignments/:id/ratings`, `PATCH /ratings/:id`, `GET /users/:id/ratings`. `GET /users/:id` also returns `stats`.
- **Rules.** Only the two parties of a `COMPLETED` assignment, once each, within `RATING_WINDOW_DAYS` (7). `scores.overall` is required; reliability, communication, timeliness and payment conduct are optional (1 to 5). A rating is hidden from the other side and counts in no figure until both have rated or the window closes (blind reveal). It can be edited until the reveal or `RATING_EDIT_HOURS` (24) after submission.
- **Figures.** Read a user's record with `UserStatsService` (`get`, `getMany`). An average is shown only from `RATING_MIN_COUNT_FOR_AVERAGE` (3) published ratings. After changing a rating's status, call `UserStatsService.recompute`.
- **Scheduler.** `RatingRevealSweeper` reveals ratings whose window has closed.

## Reliability and no-shows

- **Routes.** `GET /me/reliability` (your points and every event behind them), `GET|POST /assignments/:id/no-show`, `POST /assignments/:id/no-show/respond`.
- **Facts, not a score.** `reliability_events` is append-only. Points are the sum of `severity` over `RELIABILITY_WINDOW_DAYS` (90). Weights are `RELIABILITY_POINTS_LOW|MEDIUM|HIGH`. Write a new fact with `ReliabilityService.record(tx, { ..., points, dedupeKey })` (get `points` from `pointsTable()` before opening the transaction).
- **Consumers.** `ReliabilityEventHandler` runs in the worker. A fact with points raises `reliability.recorded` for the enforcement ladder.
- **Scheduler.** `NoShowSweeper` confirms no-show reports left unanswered.

## Reports and disputes

- **Routes.** `POST /reports`, `GET /reports`, `GET /reports/:id`, `POST /ratings/:id/report`, `POST /assignments/:id/disputes`, `GET /disputes/:id`, `POST /disputes/:id/evidence`. All writes take an `Idempotency-Key` except evidence.
- **Report or dispute.** A report is a complaint about conduct or content and never changes an errand's status. A dispute is a case about an errand: opening one moves it to `DISPUTED` through `ErrandStateService`, and an admin decision (`DisputeService.adminResolve`) moves it on. Urgent.ng does not settle money; there is no payment evidence.
- **Holds auto-completion.** An open dispute, or an open report filed by a party of the errand, clears `auto_complete_at`. Deciding the case restarts a fresh window. Use `ErrandStateService.pauseAutoCompletion` and `resumeAutoCompletion`; never write the column from another module.
- **Evidence.** Add it with `EvidenceService.add(tx, { disputeId } | { reportId }, userId, item, scope)`. It checks the source belongs to the errand (message, checkpoint, execution event) or to the user (a `DISPUTE_EVIDENCE` photo, used once).
- **Admin decisions.** `DisputeService` and `ReportService` expose `adminStartReview`, `adminResolve` and (reports) `adminSetStatus`, `adminLinkToDispute`. Their controllers come with the admin API.

## Enforcement

- **Routes.** `GET /me/enforcement` (what was done to your account and why), `POST /enforcement/:id/appeal`.
- **Ladder.** Points in the rolling window decide: warning at 4, 7-day offering and posting restriction at 8, 30-day suspension at 12, an admin review at 16. Thresholds and durations are config. Each level is applied once per window.
- **No status change without an action.** Change a user's restrictions or status only through `EnforcementService` (`adminApply`, `adminRevoke`, `adminDecideAppeal`). Severe events (`flagSevere`) go to an admin review, not the ladder.
- **Suspended users.** Mark a route `@ConsumerAuth({ continueWhenSuspended: true })` if a user should still be able to finish work they already have; a safety-critical suspension still stops it.
- **Scheduler.** `EnforcementExpirySweeper` ends actions and lifts suspensions.

## Badges

- **Routes.** `GET /runner/performance`. Badges also appear as `badges` on `GET /users/:id`, `runnerBadges` on the requester's offer list and `requester.badges` on feed items.
- **Display only.** A badge never gates the feed or offering and never changes ordering. Read them with `BadgeService.visibleFor(userIds)`, which hides runner badges while the runner is not verified.
- **Derived.** `user_badges` is a cache. `BadgeService.recompute(userId)` evaluates `badge.rules.ts` against source rows and writes only the difference. It runs from events and nightly (`BadgeRecomputeSweeper`). Windows and thresholds are config keys (`BADGE_*`, `TRUSTED_CANCELLATION_WINDOW`, `FAST_RESPONDER_WINDOW`), never columns.
- **Adding a trigger.** If a new event changes an input of a rule, add its type to `BadgeEventHandler` with the user id it concerns.

## Location sharing and trusted contacts

- **Runner routes.** `POST /assignments/:id/location` (needs the `LOCATION_SHARING` consent), `PUT /assignments/:id/location/sharing`, `GET /assignments/:id/location` (the rounded live view).
- **Trusted contact routes.** `POST|GET /errands/:id/trusted-contact`, `DELETE /trusted-contact/:id`, and the public `GET /shared/:token` and `POST /shared/:token/concern`.
- **Privacy.** The exact position never leaves `location_records`: readers get a point rounded to about 250 m, labelled FRESH, STALE or EXPIRED, and nothing once expired. The shared link's response has a fixed list of fields (no address, phone, chat, exact GPS, payment or verification detail) and is the same 404 for an unknown, revoked or expired token. Only a keyed hash of the token is stored.
- **Scheduler.** `LocationRetentionSweeper` (30 days) and `TrustedLinkExpirySweeper`.

## Risk signals

- **What it is.** A `risk_flags` row says something looked unusual (`OTP_ABUSE`, `OFFER_SPAM`, `FEED_PROBING`, `RATING_ANOMALY`, `SELF_DEALING`, `LOCATION_ANOMALY`). It never blocks or restricts anyone; a human decides what follows, through enforcement.
- **Raise one** with `RiskFlagService.raiseQuietly({ signal, userId?, errandId?, subjectKey?, details })` from a code path that must not fail because of it. One open flag exists per signal and subject; a repeat raises `occurrences`. Keep `details` free of phone numbers, emails, addresses, message text and coordinates.
- **Review.** `RiskFlagService.list` and `review` are the queue; the admin API for them comes with the admin console. Thresholds are `RISK_*` config keys.

## Billing (Urgent.ng's own products)

- **Routes.** `GET /billing/products`, `POST /billing/orders` (Runner Pro, verification fee), `POST /boosts`, `GET /billing/orders[/:id]`, `POST /billing/orders/:id/verify`, `GET /subscriptions/pro`, `POST /subscriptions/pro/cancel`, and the gateway's `POST /webhooks/paystack`. Writes take an `Idempotency-Key`.
- **Never the errand payment.** Money between requester and runner never touches this code (INV-008). Only Runner Pro, boosts and the verification fee are sold here.
- **A payment is believed only after the gateway confirms it.** `PaymentSettlementService.settle(reference)` asks `verifyTransaction`; webhook, "check my payment" and reconciliation all end there, and it is idempotent. Grants are entitlements (`entitlements` table); ask `OfferLimitService.isPro` or read the table, never infer from an order.
- **Prices** come from `price_versions`; an order keeps the version it was made at. Prices are VAT-inclusive at `VAT_RATE`.
- **Providers.** `PAYMENTS_PROVIDER=fake` in development and test (`FakePaymentProvider.markPaid(reference)` stands in for the customer paying). `real` needs `PAYSTACK_SECRET_KEY`; point Paystack's webhook at `/api/v1/webhooks/paystack`.
- **Scheduler.** `SubscriptionSweeper` (renewals, expiry), `BoostExpirySweeper`, `ReconciliationSweeper` (daily).


## Account security, profile extras and Google sign-in

- **Routes.** `POST /me/password`, `POST /me/contact` and `POST /me/contact/verify` (add or change a phone or email), `GET|PUT /me/quiet-hours`, and `POST /auth/google`. `PATCH /me` also takes `bio` and `homeArea`; `POST /auth/register` takes `homeArea`.
- **Proof for a sensitive change.** Changing the password or the contact asks for the current password. A Google-only account has none: it sends a fresh `googleIdToken` for the linked Google account instead. Changing the password ends every other session.
- **Contact change** is two steps: the code goes to the NEW value, and nothing changes until it is confirmed. A value held by another account answers `IDENTIFIER_TAKEN`.
- **Quiet hours** are kept on every preference row of the user (Lagos time) and hold back marketplace push only. `null` for both times goes back to the 22:00 to 06:00 default.
- **Google sign-in.** The ID token is verified by `IGoogleIdentityProvider` and never stored. A linked account signs in; a verified email that matches an account links to it; otherwise the first sign-in needs `consents` (without them: 409 `GOOGLE_SIGNUP_REQUIRED` with the email and name). Fake provider in tests: `FakeGoogleIdentityProvider.token(subject, email, name)`. Real: `GOOGLE_AUTH_PROVIDER=real` and `GOOGLE_CLIENT_ID`; with no client id the route answers 503 and nothing else is affected.

## Verification details

- `POST /verification/attempts` also takes `identity` (name, date of birth, address, LGA), `idDocument` (type and an optional photo) and `guarantor`. All are optional for the API and stored in `verification_submissions` for manual review; none of them decides the automatic result. The date of birth must be 18 or more years ago.
- `VerificationService.getSubmission(attemptId)` is what the admin review screen reads. The ID photo is deleted with the selfie after `STAGED_SELFIE_RETENTION_DAYS`; the details are scrubbed when the account is anonymised.

## Execution: arrived at pickup

- `POST /assignments/:id/arrived` is an optional, once-only confirmation after `start` and before `pickup`. It writes an `ARRIVED` execution event (and a private checkpoint if a point is sent), tells the requester, and does not change the errand status.

## Lists the demo screens need

- `GET /errands/mine` takes `q` (title, description, runner name) and `sort` (`RECENT`, `NEEDS_ATTENTION`, `HIGHEST_AMOUNT`).
- `GET /marketplace/errands` sorts also by `budget_desc` and `recommended` (nearest 2 km ring first, newest within it). `GET /errands/:id/offers?sort=recommended` blends rating, price and time.
- `GET /notifications` and `/notifications/unread-count` take `category`. `GET /conversations` takes `filter` (`ALL`, `ACTIVE`, `OFFERS`, `CLOSED`) and `q`.
- `GET /me/ratings?direction=RECEIVED|GIVEN&minStars&maxStars` is the reviews page. `GET /users/:id/ratings` takes the star filters too.
- `GET /runner/assignments` takes `q`, `from` and `to`; `GET /runner/assignments/summary?months=` gives counts per month; `GET /runner/assignments/export.csv` is the history as a file.
- `GET /me/summary` has the dashboard figures and the latest activity. `GET /billing/products/public` is the price list without signing in.


## Admin API (Phase 11)

- **Where.** Everything under `/api/v1/admin/*` lives in `src/admin-api/` (one file per area) plus the framework in `src/admin/framework/`. Controllers are thin: they check a permission, take a reason, and call the same domain service a user action would.
- **Every write has a reason.** The body extends `AdminActionDto`: `reasonCode` (a closed list, `GET /admin/reason-codes`) and `reasonText` (required for `OTHER`). `AdminActionService.run` audits the admin, the reason, a hash of the state before and after, and the request id; a failed attempt is audited as `<action>.failed`.
- **No raw status writes.** Errand and assignment changes go through `ErrandStateService` with `actor = ADMIN`; a test scans `src/admin-api` for `UPDATE errands` and `UPDATE assignments`. The state table gained three admin-only rows: force expire (`OPEN` to `EXPIRED`), and reopen (`EXPIRED` or `CANCELLED` to `OPEN`).
- **Four eyes.** `ApprovalService` holds a request until a different admin with the approving permission decides; the action then runs through its executor (`approval-executors.ts`). Kinds: permanent suspension, admin role or permission change, price change, kill switch, high-impact config (ladder thresholds, offer limits, refund threshold). A refund keeps its own two-step flow on the refund row. A request expires after `APPROVAL_EXPIRY_HOURS`.
- **Sensitive reads** (exact locations, full contact, identity details, chat) need their own permission, a reason where it makes sense, and are audited before the data is returned (`SensitiveAccessService`).
- **Permissions apply on the next request.** They are read live from the database: no cache to expire.
- **Added permission.** `AUDIT_EXPORT`, so exporting the audit log is separate from reading it. Re-run the seed to add it to an existing database.
- **Sweeper heartbeat.** Every sweeper writes its last run to `sweeper_runs`; `GET /admin/ops/sweepers` marks one stale after five minutes.
- **Invitations.** `POST /admin/admins/invite` creates an account with no roles; the invitee sets a password at `POST /admin/auth/accept-invite`. Roles are a separate, approved change. `ADMIN_APP_URL` (optional) builds the link in the email.
