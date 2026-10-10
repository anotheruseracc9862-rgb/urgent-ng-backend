# Phase 7 notes: assignment and execution (P7-01 to P7-10)

Prepared 2026-10-10 after the Phase 6 fixes. Sources: Backend PRD (§7, 9.4, 11.5-11.7, 13.4-13.5, 14, 15, 16, 17.1, 17.4, 18.1, 21.1, 21.4, 25, 26.3-26.4, 30.4-30.6, 31, 32.1, 34, 36, A.7), Domain Rules PRD §8-12 and §44-46, the Build Plan, and the current code. Where the PRD is silent or the documents disagree, the item is under "Decisions to make" so it is made once, on purpose.

## 1. What Phase 7 has to deliver

The path from a selected offer to a finished errand, through HTTP only:

1. Requester selects a runner (errand `OPEN` to `RUNNER_SELECTED`, assignment `PENDING_ACCEPTANCE`).
2. Runner accepts within 30 minutes, declines, or times out (sweeper).
3. Runner starts, picks up, delivers (`ACCEPTED`, `IN_PROGRESS`, `PICKED_UP`, `DELIVERED`).
4. Requester completes, or a sweeper auto-completes after 24 hours.
5. Cancellation by stage, payment agreement, problems, delay notices, receipt photo, change requests.
6. Exact location and contacts released only to the owner and the accepted runner.

Milestone M3: the whole happy path plus the listed failure paths through the HTTP API only.

## 2. State of the code you start from

What exists and is useful:

- `ErrandStateService.transition(tx, input)` is the only writer of `errands.status`. It locks the errand row, checks `expectedFrom`, `expectedVersion`, the actor against the table in `errand.state.ts`, writes `errand_status_history`, audit and outbox, handles reopening (`expiry: 'KEEP' | 'RECOMPUTE'`), and calls `OfferService.closeForErrand(tx, ...)` on `CANCELLED` and `EXPIRED`. It has an `apply(tx, errand)` callback that runs after the checks and before the status write.
- The transition table already contains every row Phase 7 needs, including `RUNNER_SELECTED -> EXPIRED` and the dispute rows. Do not add rows without a PRD reason.
- `OfferService` (Phase 6) is DB-only. Offer `version`, `awaitingParty`, `needsReconfirmation`, `closeReason` and the `negotiation_events` log are the inputs to selection.
- `ErrandContactService.read(client, errandId)` decrypts contacts. `ErrandViewService.owner(client, errandId)` builds the owner's full view. `LocationPrivacyService.toParticipant(...)` is the exact-location mapper.
- `BaseSweeper` plus `SweeperRegistry` and `SchedulerModule` run due-row jobs every 60 seconds in the scheduler process. `ErrandExpirySweeper` is the template.
- `OutboxService.add(tx, event)`; the input accepts `delayMs` (the `DelayedJobHelper` uses it) for accelerator jobs.
- Config keys already seeded: `ASSIGNMENT_ACCEPTANCE_MINUTES` (30), `DELIVERY_AUTO_COMPLETION_HOURS` (24), `MAX_CONCURRENT_ASSIGNMENTS_PER_RUNNER` (3), `CHANGE_REQUEST_EXPIRY_HOURS` (2), `MAX_DELAY_NOTICES_PER_ASSIGNMENT` (3), `NO_SHOW_PROMPT_MINUTES`, `NO_SHOW_EARLIEST_REPORT_MINUTES`.
- Error codes already in the catalogue: `ASSIGNMENT_INVALID_STATE`, `ASSIGNMENT_ACCEPTANCE_EXPIRED`, `ASSIGNMENT_CONFLICT`, `CHANGE_REQUEST_PENDING`, `CHANGE_REQUEST_NOT_ALLOWED`, `OFFER_AWAITING_RUNNER`, `OFFER_NEEDS_RECONFIRMATION`, `OFFER_VERSION_MISMATCH`.
- Prisma enums already present: `AssignmentStatus`, `ExecutionEventType`, `CheckpointType`, `ChangeRequestType`, `ChangeRequestStatus`, `ExecutionProblemType`, `DelayReason`, `PaymentMethod`, `PaymentTiming`, `ErrandCancellationReason`, `AuditActorType`.

What does not exist:

- No Prisma models or tables for `assignments`, `payment_agreements`, `execution_events`, `checkpoints`, `change_requests`, `execution_problems`. P7-01 creates them (and `location_records` is Phase 9, P9-07).
- `src/assignments/assignment.service.ts` is an in-memory stub with `Map`s (the same anti-pattern removed from offers in Phase 6). It is not wired into `AppModule`. Delete it, its spec and `AssignmentsModule`, and write the real one.
- No `POST /errands/:id/complete`, no `GET /runner/assignments`, no `GET /runner/offers` (PRD 30.2 lists both; `GET /runner/offers` was not built in Phase 6 and fits naturally here).
- No consumers for any BullMQ queue except media. Outbox events are published to queues that nobody processes. Sweepers, not jobs, are the authority for every timer. Do not add queue processors in Phase 7.

## 3. Rules that must hold (read these twice)

Invariants: INV-004 (one non-terminal assignment per errand), INV-007 and INV-017 (transactional, idempotent), INV-010 (exact data protected until accept), INV-012 (completed is terminal), INV-013 (open dispute or report blocks auto-completion), INV-015 (kobo), INV-016 (UTC, Lagos calendar day), INV-018 (outbox in the same transaction), INV-019 (inactive users cannot start new marketplace activity).

Authorisation matrix (PRD 9.4): select is the requester only; accept is the selected runner only; start, pickup, deliver are the assigned runner only; confirm completion is the requester only; exact location and contacts are the owner, and the runner once the assignment is `ACCEPTED`.

Selection transaction (PRD 14.2 and 26.4), in this order:

1. Lock the errand (`FOR UPDATE`) and verify `OPEN` and not past `expires_at` (database clock).
2. Verify the offer: `status = ACTIVE`, `needsReconfirmation = false`, `awaitingParty <> RUNNER` (use `OFFER_AWAITING_RUNNER`), `version = expectedOfferVersion` (`OFFER_VERSION_MISMATCH`), and that it belongs to this errand.
3. Verify the runner: concurrent-assignment cap (config, 3) and still eligible (`RunnerEligibilityService.assertCanOffer`; read it before the transaction, see section 5).
4. Insert the assignment `PENDING_ACCEPTANCE` with `agreed_amount_minor` snapshotted from the offer and `acceptance_deadline = clock_timestamp() + ASSIGNMENT_ACCEPTANCE_MINUTES`.
5. Errand to `RUNNER_SELECTED` through `ErrandStateService.transition` (`ownerId` = requester, `expectedFrom: OPEN`).
6. Offer to `SELECTED` (`selected_at` set).
7. Close every other `ACTIVE` offer on the errand with close reason `RUNNER_SELECTED` (status `CLOSED`).
8. Outbox `assignment.selected`, audit, negotiation event `ACCEPT` on the selected offer.

At this point the runner sees only the approximate area and non-sensitive details.

Acceptance (PRD 14.3): lock assignment and errand, assignment `PENDING_ACCEPTANCE`, deadline not passed (database clock), then assignment and errand `ACCEPTED`, create the `payment_agreements` row with the snapshotted amount, outbox `assignment.accepted`. From now on exact data is readable by the runner.

Decline and timeout (PRD 14.4): assignment `DECLINED` or `TIMED_OUT`, selected offer `CLOSED` with `ASSIGNMENT_DECLINED` or `ASSIGNMENT_ACCEPTANCE_TIMEOUT`, errand back to `OPEN` (the state service returns `EXPIRED` if the deadline already passed), reliability fields in the event payload. The offer is never silently restored.

Cancellation matrix (PRD 11.7):

| Stage | Requester | Runner |
|---|---|---|
| `RUNNER_SELECTED` | cancels, errand `CANCELLED`, assignment `CANCELLED` | declines (assignment `DECLINED`, errand `OPEN`) |
| `ACCEPTED` | cancels with reason, errand `CANCELLED`, reliability by stage | cancels with reason, errand back to `OPEN` with recomputed expiry, assignment `CANCELLED` |
| `IN_PROGRESS` | restricted, reason required, reliability event | errand `CANCELLED`, high severity, requester prompted to report or dispute |
| `PICKED_UP` | becomes the dispute and safety workflow, no plain cancel | same |
| `DELIVERED`, `COMPLETED` | not a cancellation path | n/a |

Every cancellation stores actor, actor type, reason, free text, stage, timestamp, assignment id and whether a rule or a human triggered it.

Execution (PRD 15): start, pickup (optional photo, note, checkpoint), deliver (optional photo, recipient note, checkpoint; sets `auto_complete_at = delivered_at + 24h`). Every step writes an `execution_events` row. Errand status and execution status never contradict.

Completion (PRD 15.2): requester confirms from `DELIVERED`; or a sweeper completes at `auto_complete_at`, re-reading state under lock and doing nothing if a dispute or report appeared.

Payment agreement (PRD 16): one row per assignment; amount is the runner's service fee only; no payment processing, evidence or disputes anywhere.

## 4. Schema (P7-01)

Follow A.7 exactly. Naming: snake_case tables, `uuid_generate_v7()` ids, `timestamptz(3)`, `ON DELETE RESTRICT`, soft-delete columns only on the soft-deletable class (A.1 and §26.8; check the class of each new table before choosing `deleted_at` and `install_block_delete_trigger`).

Tables and the constraints that matter:

- `assignments`: `requester_id <> runner_id`; amount `> 0`; partial unique `(errand_id) WHERE status IN ('PENDING_ACCEPTANCE','ACCEPTED') AND deleted_at IS NULL`; index `(runner_id, status)`; partial index on `acceptance_deadline WHERE status = 'PENDING_ACCEPTANCE'` (sweeper); status-dependent CHECK (accepted_at for `ACCEPTED`, declined_at for `DECLINED`, timed_out_at for `TIMED_OUT`, cancelled_at plus reason for `CANCELLED`, completed_at for `COMPLETED`).
- Trigger like Phase 6's `offers_enforce_parties`: `requester_id` equals the errand's requester, `runner_id` equals the selected offer's runner, the offer belongs to the errand. The service checks it; the database is the last line.
- `payment_agreements`: PK `assignment_id`; `agreed_amount_minor`; method and timing nullable until set; the two confirmation timestamps.
- `execution_events`: append-only. Reuse the Phase 6 pattern: BEFORE UPDATE trigger that raises, plus the delete-block trigger. Columns per A.7, `metadata jsonb` for delay reason and estimate.
- `checkpoints`: `point geography(Point,4326)` (private, raw SQL only), `captured_at`, `media_id`.
- `change_requests`: partial unique `(assignment_id) WHERE status = 'PENDING'`; partial index on `expires_at WHERE status = 'PENDING'`.
- `execution_problems`: status `OPEN`/`RESOLVED`.
- The `Prisma` schema cannot express the PostGIS column, the partial uniques or the triggers: add them to the migration SQL and keep the model fields in step (the drift list in the Build Plan is the precedent).

Remember after the migration: stop every running Node process for the backend (dev server, worker, scheduler), otherwise `prisma generate` fails with `EPERM ... query_engine-windows.dll.node`, then restart the editor's TS server.

## 5. Locking, ordering and the pool

Lock order everywhere: errand row, then the runner-level advisory lock (cap), then assignment row, then offer rows. Never the reverse.

- Offer operations (Phase 6) lock only the offer row and read the errand without a lock. That is safe against select because select updates offers under the errand lock and the offer operation re-checks `status = ACTIVE` under its own lock. Keep it that way.
- Concurrent-assignment cap across different errands needs one serialisation point per runner: `pg_advisory_xact_lock(hashtextextended('runner-assign:' || runnerId, 0))` after the errand lock. The verification service already uses a per-user advisory lock; copy that pattern.
- Anything that needs a pool connection (config reads, `RunnerEligibilityService`, Pro policy) must be read before `$transaction`. Phase 6 hit a pool deadlock: parallel transactions held every connection while waiting on a lock and the lock holder needed one more. Selection and acceptance are exactly the endpoints that will be raced in tests.
- Interactive transaction default timeout is 5 seconds; keep transactions short and do not call providers inside them.

## 6. Where each change lives

- New `AssignmentService` (selection, accept, decline, timeout, cancel by assignment) and `ExecutionService` (start, pickup, deliver, complete, problems, delay notices, receipt), `PaymentAgreementService`, `ChangeRequestService`. Keep controllers thin: identify the caller, call the service.
- **Module cycle.** `ErrandsModule` imports `OffersModule`. `AssignmentsModule` must import `ErrandsModule` (for `ErrandStateService`) and `OffersModule`. `ErrandsModule` must never import `AssignmentsModule`.
- **The assignment must follow the errand.** `ErrandStateService` changes only the errand. Requester cancel (`ErrandLifecycleService.cancel`) and later admin force-transitions (P11-03) and dispute outcomes (P9-03) all move an errand that has an assignment. If each caller updates the assignment by hand, one will forget. Recommended: add a token-injected hook, same pattern as `OFFER_RECONFIRMATION_HOOK`: `AssignmentTransitionHook.onErrandTransition(tx, { errandId, from, to, actor, cancellation })`, called at the end of `ErrandStateService.transition` (next to `closeForErrand`). The implementation lives in the assignments module and sets assignment status, timestamps and reason in the same transaction. Add an invariant test: after every transition in the table, errand and assignment statuses agree.
- `ErrandStateService` does not check that a runner actor is the assignment's runner (`ownerId` only matches the requester). Every runner action must verify `assignments.runner_id = caller` under the lock itself, and answer `RESOURCE_NOT_FOUND` for anyone else (same answer as a missing id).
- `closeForErrand` closes only `ACTIVE` offers. Two follow-ups: (a) when an errand is cancelled while the assignment is pending, the `SELECTED` offer must become `CLOSED` with `ERRAND_CANCELLED`; (b) add `closeOthersOnSelection(tx, errandId, selectedOfferId)` with reason `RUNNER_SELECTED`. The `offers_closed_fields` check needs close reason and `closed_at` on every closed row.
- Close reasons: `RUNNER_SELECTED` belongs to the other offers closed at selection (PRD 14.2 step 7). The selected offer itself stays `SELECTED` (optionally `ASSIGNMENT_ACCEPTED` as its reason once accepted). Phase 6 old code wrongly put `RUNNER_SELECTED` on the selected offer.

## 7. Exact data access (P7-04)

- A dedicated read: `GET /assignments/:id` with a DTO per access level: requester (participant view with exact locations and contacts), runner while `PENDING_ACCEPTANCE` (approximate area only, no contacts), runner from `ACCEPTED` (exact and contacts), anyone else `RESOURCE_NOT_FOUND`. Do not extend `GET /errands/:id` (owner only) and do not touch the marketplace detail (its visibility rule requires `OPEN`, so a selected runner cannot see a `RUNNER_SELECTED` errand through it; that is correct, use the assignment route).
- Media: a purpose has exactly one policy, so extend `MarketplaceMediaAccess` (for `ERRAND_PHOTO`, add "assigned runner of a live assignment on that errand") rather than registering a second one. New policies to register for the execution purposes: `PICKUP_EVIDENCE`, `DELIVERY_EVIDENCE`, `PURCHASE_RECEIPT` (both parties of the assignment). `CHAT_IMAGE` is Phase 8, `DISPUTE_EVIDENCE` Phase 9.
- Evidence media: must be `READY`, owned by the runner, purpose matching, and attached once. Check the media cleanup sweeper only removes unattached `ERRAND_PHOTO` rows, so READY evidence waiting to be attached is not deleted.
- Admin exact view needs `LOCATION_EXACT_VIEW` and an audit row (`media.admin_viewed` style). P11 builds the controller; P7 can add the service method.
- Test matrix required by P7-04: {owner, pending runner, accepted runner, other runner with a closed offer, stranger} by {approximate, exact, contacts, photos, receipt}.

## 8. Timers and sweepers

Every timer is a database column; sweepers are the authority; delayed jobs are optional accelerators.

| Timer | Column | Sweeper | Transition |
|---|---|---|---|
| Acceptance window | `assignments.acceptance_deadline` | new `AssignmentAcceptanceSweeper` | timeout, offer closed, errand to `OPEN` or `EXPIRED` |
| Auto-completion | `errands.auto_complete_at` (partial index exists) | new `AutoCompletionSweeper` | `DELIVERED -> COMPLETED`, actor `SYSTEM` |
| Change request expiry | `change_requests.expires_at` | new `ChangeRequestExpirySweeper` | `EXPIRED` |

Rules:

- Query shape `WHERE deadline <= clock_timestamp() AND status = X ... FOR UPDATE SKIP LOCKED LIMIT 100`, then re-read under lock in the per-row transaction and do nothing if the row has moved on (copy `ErrandExpiryService.expireDue/expireIfDue`).
- Compare with the database clock only. For the deadline edge, use the same convention as errand expiry: `deadline <= now` means timed out, so accept requires `now < deadline`. State the choice in a test (accept at 1 ms before, at the deadline, after).
- Lazy enforcement: accept, decline and select call the same `expireIfDue` path first, so a late sweeper never lets an expired action succeed.
- Register each sweeper in `SweeperRegistry` and `SchedulerModule`.
- Auto-completion pause: a dispute sets the errand to `DISPUTED` and clears `auto_complete_at`; an open report clears `auto_complete_at` too (Phase 9 writes both). So the sweeper condition `status = 'DELIVERED' AND auto_complete_at <= now` is already correct. Still re-check `status` under lock, and leave a small `OpenCaseChecker` seam that Phase 9 fills in. P7-05's "open dispute or report is never auto-completed" test can set `auto_complete_at = NULL` and `status = 'DISPUTED'` directly.
- Time travel in tests: deadlines are database facts, so a JavaScript fake clock does nothing. Rewind columns (`UPDATE assignments SET acceptance_deadline = now() - interval '1 minute'`), as `errand-expiry.int-spec.ts` does. The Build Plan's "using a fake clock" for P7-10 means this.

## 9. Endpoints (PRD 30.4 to 30.6, 30.2)

```
POST /errands/:errandId/select-runner   idempotent   body { offerId, expectedOfferVersion }
POST /assignments/:id/accept            idempotent
POST /assignments/:id/decline
POST /assignments/:id/cancel            body { reason, note }  (requester or runner, matrix above)
GET  /assignments/:id
GET  /runner/assignments                cursor pagination, status filter
GET  /runner/offers                     (Phase 6 leftover, PRD 30.2)
POST /assignments/:id/start | /pickup | /deliver
POST /errands/:id/complete
POST /assignments/:id/problems | /problems/:problemId/resolve
POST /assignments/:id/delay-notices | /receipt | /no-show
GET|PUT /assignments/:id/payment-agreement
POST /assignments/:id/change-requests ; POST /change-requests/:id/accept | /reject | /cancel
```

Every route: `@ConsumerAuth()` (ACTIVE only; decide on suspended runners, section 11), `@ApiConsumerAuth`, `@ApiEnveloped`, `@ApiErrors`. `@RequiresFlag` does not apply (no kill switch is defined for assignments; offers and posting have one). Add `@Idempotent` on select and accept (PRD marks them) and on complete, start, pickup, deliver (client retries after connectivity loss, PRD 36.9).

Body validation: the Phase 6 lesson. `forbidNonWhitelisted` returns 400 for unknown fields; never accept status, requester id, runner id or amounts the server can read itself. Money is integer kobo.

Regenerate OpenAPI at the end (`npm run openapi`); the contract test compares real responses with the spec.

## 10. Events and audit

Add every new event type to `EVENT_TO_QUEUE_MAP` in `queue.registry.ts` in the same change. An unregistered type makes the publisher throw and the row dead-letters after 10 attempts (this is exactly what broke `offer.submitted` in Phase 6). Currently registered for this phase: `assignment.selected`, `.accepted`, `.declined`, `.timed_out`, `execution.started`, `.picked_up`, `.delivered`, `.delay_notified`, `change_request.created`, `.accepted`, `errand.completed`.

Likely new: `assignment.cancelled`, `execution.completed` or reuse `errand.completed`, `execution.problem_reported`, `execution.problem_resolved`, `execution.receipt_added`, `payment_agreement.updated`, `change_request.rejected`, `.cancelled`, `.expired`, `execution.no_show_reported`. Add a unit test that scans `src/**/*.ts` for `eventType: '...'` literals and asserts each is in the map.

Each state change writes, in the same transaction: the row change, an `execution_events` row where the PRD lists one, an audit row, and an outbox event. Event payloads must carry what Phase 9 reliability and Phase 8 notifications will need and cannot reconstruct later: `assignmentId`, `errandId`, `requesterId`, `runnerId`, `stage` (errand status before the change), `actorType`, `actorId`, `reason`, `late` (cancel after scheduled time minus 1 hour, `LATE_CANCELLATION`), `agreedAmountMinor`, `estimatedDurationMinutes`, `acceptedAt`.

## 11. Decisions to make before coding

1. **Loser of a select race.** `ErrandStateService` throws `ERRAND_INVALID_STATE`. The error catalogue also has `ASSIGNMENT_CONFLICT` ("Another action was completed first"). Recommended: select maps "errand no longer `OPEN` because of a concurrent selection" to `ASSIGNMENT_CONFLICT`, everything else keeps `ERRAND_INVALID_STATE`. Either way, pick one and test it.
2. **Cancel at `PICKED_UP`.** The table has no `PICKED_UP -> CANCELLED` row. The endpoint should answer `ERRAND_INVALID_STATE` with `details: { suggestedAction: 'OPEN_DISPUTE' }`. Disputes exist only in Phase 9, so P7 can only point at it.
3. **Suspended or deactivated users with a live assignment.** PRD 21.4 and 36.7: a safety-critical suspension restricts execution immediately, lower restrictions may allow finishing. `@ConsumerAuth()` default blocks everyone who is not `ACTIVE`, and `UserRestrictionType.RUNNING` exists. For P7, keep ACTIVE-only and note it; the enforcement policy arrives in P9-04. Do not let a deactivated requester be stuck unable to confirm completion without a decision (INV-019 says no new activity, completion is existing activity).
4. **Offer after selection.** On an accepted `AMOUNT` change request the PRD says "write a negotiation event" and update the assignment's agreed amount. The offer is `SELECTED`. Recommended: write a `COUNTER_OFFER` by the requester plus `ACCEPT` by the runner (or the reverse by who asked) on the selected offer and also update `offers.amount_minor`, so history and the current value agree. The offers table has no "frozen when selected" rule today.
5. **Payment agreement confirmations.** PRD: the amount changes only through a change request and that resets both confirmations. Open question: when one party changes method or timing after the other confirmed, does that reset the other's confirmation? Recommended yes (confirm applies to the terms as they were).
6. **Receipt photo count.** PRD says "a receipt photo", optional. Allow more than one? Recommended a small cap (3) in config, or exactly one replaceable. Decide.
7. **`POST /assignments/:id/no-show`.** Listed in PRD 30.6 but its consequences are reliability (P9-02: raised when the other party fails to respond to a prompt within 15 minutes or an admin confirms; reportable from 30 minutes after the agreed time). Recommended: in P7 only record the `NO_SHOW_REPORTED` execution event and outbox event with the timing rule enforced; leave the confirmation and reliability to P9.
8. **`TIME` change requests.** The PRD allows type `TIME`. State what changes: `scheduled_at` on the errand only (errand is past `OPEN`, so `expires_at` no longer matters), version bump, `errand_versions` snapshot.
9. **Runner re-eligibility at accept.** PRD says verification expiry affects new offers only and must not cancel assignments. So accept should not re-run full eligibility (a verification expired during the 30 minutes must not block). Recommended: at accept check only account status and the `RUNNING`/`ALL_MARKETPLACE` restriction (restriction types exist; enforcement is P9).
10. **Deadline when an errand reopens.** The 30-minute acceptance deadline is independent of the scheduled time. A scheduled errand reopened after a decline or timeout keeps its original `expires_at` (`KEEP`); after a runner cancel it gets a fresh one (`RECOMPUTE`); if that deadline has already passed it ends `EXPIRED`. Already implemented; test all three.

Proposed answers for all ten are in 11.1 below.

### 11.1 Recommended answers (proposed 2026-10-10, not yet approved)

Treat these as the defaults to implement. If one is overruled, change it here first so the notes stay the record.

| # | Decision | Recommended answer | Reason |
|---|---|---|---|
| 1 | Loser of a select race | `ASSIGNMENT_CONFLICT` (409). Only the "errand no longer `OPEN` because of a concurrent selection" case maps to it; every other wrong-state case stays `ERRAND_INVALID_STATE`. | The client can tell "someone else got there first, refetch" from "wrong state". The catalogue message already reads "Another action was completed first". |
| 2 | Cancel at `PICKED_UP` | Refuse with `ERRAND_INVALID_STATE` and `details.suggestedAction: 'OPEN_DISPUTE'`. | PRD 11.7 has no `PICKED_UP -> CANCELLED` row. Disputes arrive in Phase 9, so Phase 7 can only point at them. |
| 3 | Suspended or deactivated user with a live assignment | Keep the default ACTIVE-only guard, but allow `DEACTIVATED` on requester `complete` and on the runner execution routes. Leave a TODO to replace the `allow` lists with the enforcement policy in P9-04. | PRD 21.4 and 36.7 give the real policy to enforcement. A deactivated user may finish what they already started, and a requester must not be stuck unable to confirm completion. |
| 4 | Amount change after selection | On an accepted `AMOUNT` change request write negotiation events (requester `COUNTER_OFFER`, runner `ACCEPT`) on the selected offer, and update both `offers.amount_minor` and `assignments.agreed_amount_minor`. Reset both payment confirmations. | One current value everywhere and a reconstructable history. The offer-update part is an addition to the PRD; skipping it makes the offer and assignment disagree. |
| 5 | Method or timing changed after the other party confirmed | Reset the other party's confirmation. Tell the frontend the reset happens. | A confirmation covers the terms as they were. Without the reset one party can change terms silently. |
| 6 | Receipt photo count | Up to 3 per assignment, new config key `MAX_RECEIPTS_PER_ASSIGNMENT` (default 3). Still optional, never blocks progress. | PRD says "a receipt photo" but multi-store shopping is real. A cap prevents abuse. |
| 7 | `POST /assignments/:id/no-show` | Record only: a `NO_SHOW_REPORTED` execution event and an outbox event, with the timing rule enforced (not before `NO_SHOW_EARLIEST_REPORT_MINUTES` after the agreed time; ASAP errands count from acceptance). Prompting the other party, confirmation and reliability points belong to P9-02. | Keeps Phase 7 free of reliability logic that has no table yet. |
| 8 | `TIME` change request | Update `errands.scheduled_at` only, bump `errands.version` and `material_version`, write an `errand_versions` snapshot. Do not touch `expires_at`. | The errand is past `OPEN`, so expiry no longer applies. |
| 9 | Runner re-eligibility at accept | Re-check only that the account is `ACTIVE` and there is no `RUNNING` or `ALL_MARKETPLACE` restriction. Do not re-check verification or availability. | PRD 10.2: verification expiry blocks new offers only. Availability is a feed setting, not a commitment gate. A runner must not lose a job they were legitimately selected for. |
| 10 | Deadline when an errand reopens | Keep what is implemented: decline or acceptance timeout keeps the original `expires_at`; runner cancel at `ACCEPTED` recomputes it from now; if the deadline has already passed the errand ends `EXPIRED`. Add tests for all three. | It already matches PRD 11.4. No code change. |

Consequences to carry into the tasks:

- P7-02 and P7-03: error mapping for decision 1; accept path uses the light check of decision 9.
- P7-05, P7-06: `DEACTIVATED` allow lists (decision 3) and the `PICKED_UP` refusal (decision 2).
- P7-07: confirmation reset rules (decision 5).
- P7-08: receipt cap and the config key with its seed default (decision 6); no-show endpoint as record-only (decision 7).
- P7-09: amount and time change behaviour (decisions 4 and 8).
- P7-10: the three reopen cases (decision 10).

## 12. Existing gaps that Phase 7 should close or knowingly leave

- **Account deletion is not blocked by anything.** `AccountService` takes `DELETION_BLOCKERS` as an optional injected list, and no module registers a blocker. A user with an `OPEN` errand, an `ACTIVE` offer or a live assignment can request deletion today. Register a blocker from errands (own non-terminal errands) and assignments (live assignment as runner) in this phase; reports and disputes follow in Phase 9. Test: `DELETION_BLOCKED` with the reasons (P2-05).
- Account deactivation: decide whether live offers are withdrawn or closed (`RUNNER_RESTRICTED` / `ADMIN_CLOSED` close reasons exist). Not in the PRD text; low risk to leave.
- `GET /runner/offers` missing (see section 2).
- Runner and requester "completed errands" counts and rating are `null`/absent in the Phase 6 offer list; completion is the data source (Phase 9 `user_stats`). Keep completed-count updates out of P7 but write the completion event with enough fields.

## 13. Task by task

**P7-01 schema.** Section 4. Done when migrations and constraint tests pass: one non-terminal assignment per errand (two inserts, second rejected), requester equals errand requester, runner equals offer runner, execution events immutable, one pending change request per assignment, CK fields per status.

**P7-02 select runner.** Sections 3 and 5. Tests: happy path (assignment, errand `RUNNER_SELECTED`, offer `SELECTED`, others `CLOSED / RUNNER_SELECTED`, outbox, history, audit rows); flagged offer refused; `awaitingParty = RUNNER` refused; stale `expectedOfferVersion`; not the owner (`RESOURCE_NOT_FOUND`); errand expired or cancelled; runner at cap 3 (race across three errands in parallel); runner loses eligibility between offer and select; two simultaneous selects on one errand (one assignment); select racing cancel (consistent end state: either cancelled with all offers closed, or selected, never both); idempotent replay.

**P7-03 accept, decline, timeout.** Sections 3 and 8. Tests: accept before, at, after the deadline; sweeper timeout with Redis flushed; decline reopens with deadline kept; timeout after errand expiry ends in `EXPIRED`; a second accept (replay and non-replay); accept by the wrong runner; offer ends `CLOSED` with the right reason and is not restored; requester can select another offer afterwards; the runner's `RUNNER_SELECTED` conflict with the cap while pending (pending counts toward the cap).

**P7-04 exact data.** Section 7. Test matrix.

**P7-05 execution transitions.** `expectedFrom` per step; runner must own the assignment; pickup and deliver accept optional evidence media (READY, own, right purpose, attach once) and an optional checkpoint (validated point, `captured_at`, stored private); deliver sets `auto_complete_at`; requester `complete` from `DELIVERED` only; auto-completion sweeper per section 8. Both `COMPLETED` paths set assignment `COMPLETED` and `completed_at`, write `COMPLETED` or `AUTO_COMPLETED`, outbox `errand.completed`.

**P7-06 cancellation matrix.** One endpoint per actor, one test per cell of the table in section 3, plus: reason must be from the right list (`REQUESTER_REASONS` exists in `ErrandLifecycleService`; add runner reasons `RUNNER_CANCELLED`, `SAFETY_CONCERN`, `OTHER`), runner cancel at `ACCEPTED` reopens with `RECOMPUTE`, runner cancel at `IN_PROGRESS` cancels with a high severity flag in the event, cancel at `PICKED_UP` refused with the dispute hint, `ErrandLifecycleService.cancel` stays correct for statuses before `RUNNER_SELECTED` and delegates (or relies on the hook) after.

**P7-07 payment agreement.** `GET|PUT`, party-only, status `ACCEPTED` through `DELIVERED` (decide whether it stays editable after delivery; recommended read-only after `COMPLETED`), amount is read-only here, method and timing writable, each party confirms its own side, confirmations reset per decision 5 and always on an accepted amount change. No payment evidence or processing anywhere (INV-008).

**P7-08 problems, delay notices, receipt.** Problems: five types, optional note and media, open or resolved, runner resolves (PRD), two unresolved sets `suggestDispute: true` in the response, does not change errand status. Delay notices: status `ACCEPTED`, `IN_PROGRESS`, `PICKED_UP`; max 3 (config); body reason, new estimate in minutes, note; stored in `execution_events.metadata` as `{ reason, newEstimateMinutes }` because trusted-contact expected delivery time (P9-06) reads the newest one. Receipt: category key `shopping_purchase` only, `ACCEPTED` through `DELIVERED`, purpose `PURCHASE_RECEIPT`, never blocks progress.

**P7-09 change requests.** Types and payloads: `AMOUNT { amountMinor }`, `PICKUP` and `DESTINATION { point, addressText?, landmark? }`, `TIME { scheduledAt }`, `OTHER { note }`. One pending per assignment (`CHANGE_REQUEST_PENDING`), only while `ACCEPTED` or `IN_PROGRESS` (`CHANGE_REQUEST_NOT_ALLOWED`), location and time blocked after `PICKED_UP`, the other party accepts or rejects, requester can cancel their own, expiry is `min(now + 2h, pickup)`: expire pending requests inside the pickup transaction as well as in the sweeper. Accepted location change goes through `ErrandLocationRepository` (recompute approximate point and `feed_point`), bumps `errands.version` and `material_version`, writes an `errand_versions` snapshot (no contacts). Accepted amount change per decision 4.

**P7-10 core flow suite.** One file, HTTP only: register, verify, post, offer, counter, accept-counter, select, accept, start, pickup, deliver, complete. Then: each cancel cell, acceptance timeout then re-select, decline, expiry, auto-completion with column rewind, race tests from P7-02. Also an "event catalogue" test and the errand/assignment status agreement test.

## 14. Test helpers to add

- `insertAssignment(...)` in `src/test/` (status, deadline, accepted offer) for state-seeded tests, like `insertErrand`.
- `selectRunner`, `acceptAssignment` and friends in `src/test/assignment.helper.ts` (mirror `offer.helper.ts`).
- A `fullPath(app)` helper that takes an errand and a runner to `ACCEPTED` over HTTP, since most P7 tests start there.
- Remember `readyRunner(app, nin)` needs a distinct fake NIN per extra runner (`NIN.ok`, `NIN.other`; the fake provider has few; add more deterministic ones if a test needs 4 runners).
- Write Phase 7 integration tests against the HTTP API. The Phase 6 broken tests were direct service calls with hand-made fixtures that violated check constraints.

## 15. Lessons from Phase 6 to apply here

1. Trust nothing from the client that the server can read: ids of parties, statuses, amounts, timestamps.
2. No in-memory state. If a class has a `Map` for domain state, it is wrong.
3. Test the concurrency claim with real parallel requests and assert on the database, not on the response (the old limit test passed while the counter was lost).
4. A limit or invariant checked outside the transaction is not enforced.
5. Register event types in the queue map in the same commit.
6. Do not catch and swallow errors inside a transaction (the old reconfirmation hook did).
7. Read anything that needs the pool before opening the transaction.
8. Run the whole integration suite (`npm run test:int`) at the end of each task; the errand and marketplace suites exercise code the new modules touch.
9. Update the Build Plan with an implementation-notes section when the phase is done, as for Phases 1 to 6.
