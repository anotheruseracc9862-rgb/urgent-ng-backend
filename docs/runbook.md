# Operations runbook

For whoever runs the backend. The code is one NestJS codebase that starts as three processes; they share only PostgreSQL and Redis.

## Processes

| Process | Command | What it does | Scale |
|---|---|---|---|
| API | `npm run start:prod` | HTTP, SSE, webhooks. Stateless. | Any number behind a load balancer. |
| Worker | `npm run start:worker` | Publishes the outbox to BullMQ and runs the event handlers (notifications, realtime, matching, badges, analytics, media). | Any number: jobs are keyed by outbox id, so a repeat is a no-op. |
| Scheduler | `npm run start:scheduler` | Runs the sweepers below. | More than one is safe: every sweeper claims rows with `FOR UPDATE SKIP LOCKED`. One is enough. |

Start order does not matter. A process that cannot reach PostgreSQL or Redis keeps retrying; nothing is lost, because every promise to do work is a row in PostgreSQL first (the outbox, or a due date on a record).

## Sweepers

Every sweeper wakes every 60 seconds, except where noted, claims due rows in small batches and records a heartbeat in `sweeper_runs`. `GET /api/v1/admin/ops/sweepers` shows the last run, how long it took, how many rows it handled and the last error. **A sweeper that has not run for five minutes is marked stale**; start there when something "did not happen".

| Sweeper | What it does | If it stops |
|---|---|---|
| `ErrandExpirySweeper` | Moves OPEN errands past their deadline to EXPIRED. | Stale errands stay in the feed. |
| `AssignmentAcceptanceSweeper` | Times out a selected runner who did not accept in time. | The errand waits on a runner who is gone. |
| `AutoCompletionSweeper` | Completes a delivered errand the requester did not answer. A report or dispute pauses it. | Runners are not credited. |
| `ChangeRequestExpirySweeper` | Expires pending change requests. | Requests stay open. |
| `NoShowSweeper` | Confirms a no-show report the accused did not answer. | Reports stay pending. |
| `RatingRevealSweeper` | Reveals ratings when the window closes. | Ratings stay hidden. |
| `ReminderSweeper` | Sends scheduled reminders. | No reminders. |
| `EnforcementExpirySweeper` | Ends restrictions and suspensions whose period passed. | People stay restricted. |
| `BadgeRecomputeSweeper` | Recomputes badges nightly, repairing a missed event. | Badges drift until the next event. |
| `VerificationSweeper` | Expires old verifications, fails abandoned attempts, deletes staged selfies and ID photos 30 days after the decision. | Sensitive photos stay longer than promised. |
| `AccountDeletionSweeper` | After the 14-day grace, marks the account DELETED; after 30 more days, scrubs its personal data (unless a case is open). | Deletion requests do not complete. |
| `MediaCleanupSweeper` | Removes abandoned uploads, unused errand photos and media of anonymised accounts. | Storage grows. |
| `LocationRetentionSweeper` | Deletes location history older than 30 days. | Positions are kept longer than promised. |
| `IdempotencyCleanupSweeper` | Deletes idempotency keys older than 24 hours. | The table grows. |
| `TrustedLinkExpirySweeper` | Expires trusted-contact links. | Links outlive their window (the read path also checks the time). |
| `BoostExpirySweeper` | Ends boosts whose time ran out. | Boosts keep ranking. |
| `SubscriptionSweeper` | Charges due Runner Pro renewals, ends lapsed subscriptions. | Renewals are late. |
| `ReconciliationSweeper` | Once a day, checks pending payments against the gateway. | A missed webhook is not repaired. |
| `DataRetentionSweeper` (hourly) | Applies the retention rules: notifications 90 days, published outbox rows 7 days, ended sessions 30 days, offer counters 7 days, analytics 13 months, and redaction of chat text 12 months after the errand ended. A report, a dispute or a legal hold on the errand keeps its chat. | Tables grow; promised redaction is late. |

## Retention at a glance

| Data | Rule | Where |
|---|---|---|
| Chat text | Redacted in place 12 months after the errand ended; held while a report or dispute is open, or a legal hold is set. | `RetentionService.redactMessages` |
| Location history | Deleted after 30 days. | `RunnerLocationService.purgeExpired` |
| Staged selfie and ID photo | Deleted 30 days after the decision. | `VerificationExpiryService.deleteStagedSelfies` |
| Notifications and deliveries | Deleted after 90 days. | `RetentionService.purgeNotifications` |
| Analytics events | Deleted after 13 months. | `RetentionService.purgeAnalytics` |
| Idempotency keys | Deleted after 24 hours. | `IdempotencyService.cleanup` |
| Deleted accounts | Personal data scrubbed 30 days after deletion unless a case is open; the row stays as "Deleted User". | `AccountService.anonymiseDue` |

All the periods are business configuration (`MESSAGE_RETENTION_MONTHS`, `NOTIFICATION_RETENTION_DAYS`, ...), changed in the admin console without a deploy.

Rows of soft-deletable and never-deleted tables are never removed. A database trigger refuses a `DELETE` on them; only the transient tables above can lose rows.

## Common tasks

**Check what is running.** `GET /api/v1/health` (the API), `GET /api/v1/admin/ops/sweepers` (the scheduler), `GET /api/v1/admin/ops/queues` (the worker).

**An event is stuck.** `GET /api/v1/admin/ops/outbox?status=DEAD_LETTERED`, read `lastError`, fix the cause, then `POST /api/v1/admin/ops/outbox/{id}/retry`. Handlers are idempotent, so a retry is safe.

**A payment shows pending.** `POST /api/v1/admin/webhooks/{id}/replay` re-asks the gateway and settles through the same idempotent path as a webhook.

**Place a legal hold on an errand.** `POST /api/v1/admin/errands/{id}/legal-hold` with `{ "hold": true, "reasonCode": "...", "reasonText": "..." }`. Lift it with `"hold": false`.

**Stop a feature.** Set the `FEATURE_*` flag in the admin console. A kill switch needs a second admin to approve. A disabled feature answers `503 FEATURE_DISABLED`.

**Roll a secret.** `DATA_ENCRYPTION_KEY` encrypts errand contacts: each value carries its key id, so add the new key, keep the old one until a re-encryption pass has run, then drop it. Rolling `JWT_SECRET` signs everyone out.

## First start in a new environment

```bash
npm ci
npx prisma migrate deploy
npm run prisma:seed                      # policies, categories, prohibited items, admin roles, commercial products, config defaults
npm run admin:create -- --email you@example.com --name "Your Name"   # the first admin (SUPER_ADMIN); MFA is enrolled at first login
npm run start:prod & npm run start:worker & npm run start:scheduler
```

The seed is safe to run again: it only adds what is missing. After upgrading to a version that adds a permission, run it again so the roles pick it up.

## Live provider checklist (before the first real launch)

Run each with the vendor's sandbox keys; the test stand-ins cannot prove these:

- Paystack: initialise, pay, webhook signature, refund, verify by reference.
- KYC (Dojah): selfie match and ID lookup, with the timeout in `KYC_REQUEST_TIMEOUT_SECONDS`.
- SMS (Termii) and email (Mailgun/SMTP): one-time code and receipt delivery.
- Push (FCM): token registration and a push to a real device.
- Google sign-in: a real ID token against `GOOGLE_CLIENT_ID` (checked 2026-10-12 with a real account).
- Google Maps: a server `MAPS_API_KEY`; one geocode, one reverse geocode (the area name must come back for a Lagos point) and one distance call.
- Storage (S3): upload through `PUT /media/{id}/content`, confirm, thumbnail, signed download, delete. The bucket stays private and needs no CORS.
