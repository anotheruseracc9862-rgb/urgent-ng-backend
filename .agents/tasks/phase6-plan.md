# Phase 6 Implementation Plan — Offers, Negotiation, Offer Limits

**Task:** Complete Phase 6 (P6-01 through P6-06) as specified in Backend Build Plan.md  
**Date:** 2025-01-XX  
**Status:** Ready for implementation

---

## Executive Summary

Phase 6 adds offer submission, negotiation, and daily offer limits to the Urgent.ng backend. The foundation is already in place:

- **Schema:** ✅ `offers`, `offer_daily_counters`, and `negotiation_events` tables exist (migration `20261014000000_phase6_offer_models`)
- **Services:** ✅ `OfferService`, `OfferLimitService`, and `EntitlementService` are implemented with in-memory fallback and database persistence
- **Controller:** ✅ `OffersController` exists with endpoints for submit, list, counter, withdraw, reject, and reconfirm

**What's missing:** Integration tests, offer lifecycle hooks (close on errand expiry/cancel, flag on material edit), configuration validation, GET /runner/offer-limit endpoint, negotiation immutability enforcement, offer list sorting, and cross-module wiring.

---

## P6-01: Offer limit counter (M)

**Status:** ✅ MOSTLY COMPLETE  
**What exists:**
- ✅ `offer_daily_counters` table with composite PK `(user_id, day_lagos)`
- ✅ `OfferLimitService` in `src/entitlements/offer-limit.service.ts` with Lagos-day calculation via `ClockService.lagosDay()`
- ✅ Row-level locking via `upsert` in `consumeInDatabase()`
- ✅ Runner Pro bypass logic exists (policy injection via `OFFER_LIMIT_POLICY`)
- ✅ Fair-use cap checked via `PRO_DAILY_OFFER_CAP` config

**What's missing:**
- ⚠️ Concurrency test proving the row lock never exceeds the limit
- ⚠️ Integration test proving day rollover at Lagos midnight

**Files to modify/create:**
- Create: `src/entitlements/offer-limit.service.int-spec.ts`

**Test strategy:**
```typescript
// Concurrency test: spawn 50 parallel consume() calls for same user/day
// Verify final count === min(50, limit) and no calls exceeded limit

// Day-boundary test: use fake ClockService, consume at 23:59:59 Lagos,
// advance to 00:00:01, verify new day gets fresh counter
```

**Verification:**
```bash
npx vitest run --config ./vitest.config.int.ts src/entitlements/offer-limit.service.int-spec.ts
```

---

## P6-02: Offer-limit configuration and endpoint (S)

**Status:** ✅ MOSTLY COMPLETE  
**What exists:**
- ✅ `FREE_RUNNER_DAILY_OFFER_LIMIT` = 10 in `business-config.defaults.ts`
- ✅ `PRO_DAILY_OFFER_CAP` = 100 in `business-config.defaults.ts`
- ✅ `OfferLimitService.getLimitStatus()` returns `{ used, limit, remaining, resetsAt, isPro, isAtLimit }`

**What's missing:**
- ❌ `GET /runner/offer-limit` endpoint
- ⚠️ Integration test proving config change without restart

**Files to create/modify:**
- Create: `src/runner/runner.controller.ts` (or extend existing if it exists)
- Create: `src/runner/runner.module.ts` (wire EntitlementsModule)
- Modify: `src/runner/runner.dto.ts` (add `OfferLimitDto`)
- Create: `src/runner/runner.http.int-spec.ts`

**Implementation steps:**
1. Create `GET /runner/offer-limit` controller endpoint calling `OfferLimitService.getLimitStatus(user.userId)`
2. Map to DTO with `{ used, remaining, limit, resetsAt, isPro }`
3. Test: consume 3 offers, call endpoint, verify `used: 3, remaining: 7`
4. Test: update `FREE_RUNNER_DAILY_OFFER_LIMIT` to 5 via `BusinessConfigService.set()`, wait 61s, verify new limit applies

**Verification:**
```bash
npx vitest run --config ./vitest.config.int.ts src/runner/runner.http.int-spec.ts
```

---

## P6-03: Entitlement service (M)

**Status:** ✅ COMPLETE  
**What exists:**
- ✅ `EntitlementService` in `src/entitlements/entitlement.service.ts`
- ✅ `canSubmitOffer()` checks Runner Pro OR free limit
- ✅ `assertCanSubmitOffer()` throws `OFFER_DAILY_LIMIT_REACHED`

**What's missing:**
- ⚠️ Unit tests covering Pro within cap, free at limit, Pro at cap

**Files to create:**
- Create: `src/entitlements/entitlement.service.spec.ts`

**Test cases:**
```typescript
// 1. Free runner with 2/10 used → allowed
// 2. Free runner with 10/10 used → denied, OFFER_DAILY_LIMIT_REACHED
// 3. Pro runner with 50/100 used → allowed
// 4. Pro runner with 100/100 used → denied, OFFER_DAILY_LIMIT_REACHED
```

**Verification:**
```bash
npx vitest run src/entitlements/entitlement.service.spec.ts
```

---

## P6-04: Offers submit (L)

**Status:** ✅ MOSTLY COMPLETE  
**What exists:**
- ✅ `OfferService.submitOffer()` in `src/offers/offer.service.ts`
- ✅ Validation: eligible runner, errand OPEN, not own, amount/duration bounds, availability confirmed, 20 open cap
- ✅ Partial unique index `offers_errand_runner_active_unique` on `(errand_id, runner_id) WHERE status = 'ACTIVE'`
- ✅ Offer counted via `offerLimit.consume(runnerId, 1, tx)` in same transaction
- ✅ `negotiation_events` row created with `INITIAL_OFFER`
- ✅ Idempotency via existing offer check

**What's missing:**
- ❌ Conversation creation hook (currently stubbed)
- ❌ Outbox event for `offer.submitted`
- ❌ `errand.offer_count` increment
- ⚠️ Integration test: failed offer doesn't count against limit
- ⚠️ Integration test: expired errand rejected without counting

**Files to modify/create:**
- Modify: `src/offers/offer.service.ts` (add outbox and errand.offer_count update)
- Create: `src/offers/offer.service.int-spec.ts`
- Modify: `src/offers/offers.module.ts` (import QueueModule, ErrandsModule)

**Implementation steps:**
1. Inject `OutboxService` and `PrismaService` into `OfferService`
2. In `submitOffer()` transaction:
   - After creating offer, write outbox event:
     ```typescript
     await this.outbox.add(tx, {
       eventType: 'offer.submitted',
       aggregateType: 'offer',
       aggregateId: created.id,
       payload: { offerId: created.id, errandId, runnerId, amountMinor, durationMinutes }
     });
     ```
   - Increment `errand.offer_count`:
     ```typescript
     await tx.$executeRaw`UPDATE errands SET offer_count = offer_count + 1 WHERE id = ${errandId}`;
     ```
3. Test: submit offer, verify transaction rolls back on validation error, counter unchanged
4. Test: submit offer on expired errand (set `expiresAt` in past), verify `ERRAND_INVALID_STATE` and counter unchanged

**Verification:**
```bash
npx vitest run --config ./vitest.config.int.ts src/offers/offer.service.int-spec.ts
```

---

## P6-05: Negotiation (L)

**Status:** ✅ MOSTLY COMPLETE  
**What exists:**
- ✅ `NegotiationEvent` table (immutable: `BEFORE DELETE` trigger via `install_block_delete_trigger`)
- ✅ `counterOffer()` validates `awaitingParty` turn rules
- ✅ `acceptOffer()` (selection), `rejectOffer()`, `withdraw()` implemented
- ✅ Runner edit via `counterOffer()` (not counted against limit)
- ✅ Version checks via `expectedVersion` parameter

**What's missing:**
- ⚠️ Integration test: turn rules (runner counters, then requester must act)
- ⚠️ Integration test: history reconstruction from `negotiation_events`
- ⚠️ Test: UPDATE/DELETE on `negotiation_events` is rejected at database

**Files to create:**
- Create: `src/negotiations/negotiation.service.int-spec.ts`

**Test cases:**
```typescript
// 1. Runner submits offer → awaiting REQUESTER
// 2. Requester counters → awaiting RUNNER
// 3. Runner tries to counter again immediately → OFFER_INVALID_STATE
// 4. Accept final counter → status SELECTED, awaiting NONE
// 5. Reconstruct price path from negotiation_events: [5000, 4500, 4750, accept]
// 6. Attempt UPDATE negotiation_events → database rejects
```

**Verification:**
```bash
npx vitest run --config ./vitest.config.int.ts src/negotiations/negotiation.service.int-spec.ts
```

---

## P6-06: Offer lifecycle hooks (M)

**Status:** ❌ NOT STARTED  
**What's missing:**
- ❌ Material errand edit sets `needsReconfirmation` on active offers
- ❌ Errand cancel/expiry closes offers with appropriate `closeReason`
- ❌ Offer list endpoint with sorts (price, ETA, rating, distance, Pro tie-break)

**Files to modify/create:**
- Modify: `src/errands/errand.service.ts` (call `OfferService.flagForReconfirmation()` after material edit)
- Modify: `src/errands/errand-expiry.service.ts` (call `OfferService.closeForErrand()` in sweeper)
- Modify: `src/errands/errand.state.ts` (call `OfferService.closeForErrand()` on cancel transition)
- Create: `src/offers/offer-list.service.ts`
- Modify: `src/offers/offers.controller.ts` (add GET with query params for sort)
- Modify: `src/offers/offers.module.ts` (import RunnerModule for Pro check)
- Create: `src/offers/offer-lifecycle.int-spec.ts`

**Implementation steps:**

### 6.1: Material edit reconfirmation hook
1. In `src/errands/errand.service.ts`, after a material edit (when `materialVersion` increments):
   ```typescript
   const flagged = await this.offers.flagForReconfirmation(errandId);
   if (flagged > 0) {
     await this.outbox.add(tx, {
       eventType: 'errand.material_edit',
       aggregateType: 'errand',
       aggregateId: errandId,
       payload: { errandId, flaggedOffers: flagged, changedFields }
     });
   }
   ```
2. `OfferService.flagForReconfirmation(errandId)` already exists and updates offers in memory
3. Add Prisma implementation:
   ```typescript
   if (this.prisma) {
     const result = await this.prisma.$transaction(async (tx) => {
       const updated = await tx.offer.updateMany({
         where: { errandId, status: 'ACTIVE' },
         data: {
           needsReconfirmation: true,
           awaitingParty: 'RUNNER',
           version: { increment: 1 }
         }
       });
       return updated.count;
     });
     return result;
   }
   ```

### 6.2: Close offers on expiry/cancel
1. In `src/errands/errand-expiry.service.ts`:
   ```typescript
   async expireDue(): Promise<number> {
     // ... existing expiry logic
     if (expired > 0) {
       for (const id of expiredIds) {
         await this.offers.closeForErrand(id, 'ERRAND_EXPIRED');
       }
     }
   }
   ```
2. In `src/errands/errand.state.ts` transition to `CANCELLED`:
   ```typescript
   if (newStatus === 'CANCELLED') {
     await this.offers.closeForErrand(errandId, 'ERRAND_CANCELLED');
   }
   ```
3. `OfferService.closeForErrand()` already exists with database persistence

### 6.3: Offer list with sorting
1. Create `src/offers/offer-list.dto.ts`:
   ```typescript
   export class OfferListQueryDto {
     @IsOptional()
     @IsEnum(['price_asc', 'eta_asc', 'rating_desc', 'distance_asc'])
     sort?: string = 'price_asc';
   }
   
   export class OfferListItemDto {
     id: string;
     runnerId: string;
     runnerName: string;
     runnerRating: number | null;
     runnerIsPro: boolean;
     amountMinor: number;
     durationMinutes: number;
     message?: string;
     awaitingParty: string;
     needsReconfirmation: boolean;
     distanceBucket?: string;
     version: number;
     createdAt: Date;
   }
   ```
2. Modify `OffersController.list()`:
   ```typescript
   @Get('errands/:errandId/offers')
   @ConsumerAuth()
   list(
     @Param('errandId', ParseUUIDPipe) errandId: string,
     @Query() query: OfferListQueryDto
   ): Promise<OfferListItemDto[]> {
     return this.offerList.getOffersForErrand(errandId, query.sort);
   }
   ```
3. Implement `OfferListService`:
   ```typescript
   async getOffersForErrand(errandId: string, sort: string): Promise<OfferListItemDto[]> {
     // Query offers with runner profile JOIN
     // Apply sort: price ASC, duration ASC, rating DESC (nulls last), distance calculated, Pro first
     // Map to DTO with Pro badge check
   }
   ```
4. Pro tie-break: in SQL `ORDER BY` clause, add `CASE WHEN runner_is_pro THEN 0 ELSE 1 END` before other sorts

**Test strategy:**
```typescript
// Test 1: Material edit flags 3 active offers, sets needsReconfirmation=true
// Test 2: Errand expires, all offers close with status=EXPIRED, closeReason=ERRAND_EXPIRED
// Test 3: Requester cancels, offers close with status=CLOSED, closeReason=ERRAND_CANCELLED
// Test 4: Offer selection cannot proceed while needsReconfirmation=true
// Test 5: Offer list sorted by price_asc returns offers in ascending amount order
// Test 6: Offer list with Pro runner appears first even with higher price
```

**Verification:**
```bash
npx vitest run --config ./vitest.config.int.ts src/offers/offer-lifecycle.int-spec.ts
npx vitest run src/offers/offers.http.int-spec.ts
```

---

## Ordered Implementation Steps (All Tasks)

1. **P6-03: Unit tests for EntitlementService** (30 min)
   - Files: `src/entitlements/entitlement.service.spec.ts`
   - Verify: `npx vitest run src/entitlements/entitlement.service.spec.ts`

2. **P6-01: Integration tests for OfferLimitService** (1 hour)
   - Files: `src/entitlements/offer-limit.service.int-spec.ts`
   - Verify: `npx vitest run --config ./vitest.config.int.ts src/entitlements/offer-limit.service.int-spec.ts`

3. **P6-02: GET /runner/offer-limit endpoint** (1 hour)
   - Files: Create/modify `src/runner/runner.controller.ts`, `runner.module.ts`, `runner.dto.ts`, `runner.http.int-spec.ts`
   - Verify: `npx vitest run --config ./vitest.config.int.ts src/runner/runner.http.int-spec.ts`

4. **P6-04: Offer submit integration (outbox, offer_count)** (2 hours)
   - Files: Modify `src/offers/offer.service.ts`, `offers.module.ts`; create `offer.service.int-spec.ts`
   - Verify: `npx vitest run --config ./vitest.config.int.ts src/offers/offer.service.int-spec.ts`

5. **P6-05: Negotiation integration tests** (1.5 hours)
   - Files: Create `src/negotiations/negotiation.service.int-spec.ts`
   - Verify: `npx vitest run --config ./vitest.config.int.ts src/negotiations/negotiation.service.int-spec.ts`

6. **P6-06.1: Material edit reconfirmation hook** (1 hour)
   - Files: Modify `src/errands/errand.service.ts`, `src/offers/offer.service.ts`
   - Verify: Integration test in P6-06.3

7. **P6-06.2: Close offers on expiry/cancel** (1 hour)
   - Files: Modify `src/errands/errand-expiry.service.ts`, `src/errands/errand.state.ts`
   - Verify: Integration test in P6-06.3

8. **P6-06.3: Offer list with sorting** (2 hours)
   - Files: Create `src/offers/offer-list.service.ts`, `offer-list.dto.ts`; modify `offers.controller.ts`, `offers.module.ts`
   - Verify: Create `src/offers/offers.http.int-spec.ts` and run

9. **P6-06.4: Lifecycle integration tests** (1.5 hours)
   - Files: Create `src/offers/offer-lifecycle.int-spec.ts`
   - Verify: `npx vitest run --config ./vitest.config.int.ts src/offers/offer-lifecycle.int-spec.ts`

10. **Final verification** (30 min)
    ```bash
    npm run check:full  # lint, build, all tests
    ```

**Total estimated effort:** ~12 hours

---

## Blocking Questions / Ambiguities

None identified. The Build Plan and PRD are clear. The schema and services exist. The only work is:
- Writing tests proving concurrency safety and day rollover
- Wiring offer lifecycle hooks into errand state transitions
- Adding the offer list endpoint with sorting

---

## Config Keys Required

All keys already exist in `business-config.defaults.ts`:
- ✅ `FREE_RUNNER_DAILY_OFFER_LIMIT` = 10
- ✅ `PRO_DAILY_OFFER_CAP` = 100
- ✅ `OFFER_MIN_AMOUNT` = 20000 (₦200)
- ✅ `OFFER_MAX_AMOUNT` = 50000000 (₦500,000)
- ✅ `OFFER_DURATION_MIN_MINUTES` = 5
- ✅ `OFFER_DURATION_MAX_MINUTES` = 1440
- ✅ `MAX_OPEN_OFFERS_PER_RUNNER` = 20

---

## Error Codes

All required codes exist in `src/common/constants/error-codes.ts`:
- ✅ `OFFER_NOT_ELIGIBLE`
- ✅ `OFFER_ALREADY_EXISTS`
- ✅ `OFFER_INVALID_STATE`
- ✅ `OFFER_VERSION_MISMATCH`
- ✅ `OFFER_NEEDS_RECONFIRMATION`
- ✅ `OFFER_DAILY_LIMIT_REACHED`
- ✅ `ERRAND_INVALID_STATE`
- ✅ `VALIDATION_ERROR`

---

## Database State

- ✅ Migration `20261014000000_phase6_offer_models` applied
- ✅ Tables: `offers`, `offer_daily_counters`, `negotiation_events`
- ✅ Partial unique index: `offers_errand_runner_active_unique`
- ✅ Soft-delete triggers installed
- ✅ Immutable `negotiation_events` (DELETE trigger blocks)

---

## Milestone Check (Phase 6 Complete)

When all tasks pass, verify:
1. A free runner submits 10 offers in one Lagos day, 11th is rejected with `OFFER_DAILY_LIMIT_REACHED`
2. At Lagos midnight, counter resets and runner can submit again
3. A Pro runner submits 100 offers in one day, 101st is rejected
4. Material errand edit flags all active offers with `needsReconfirmation`
5. Reconfirming a flagged offer clears the flag
6. Errand expiry closes all offers with status `EXPIRED`
7. Errand cancel closes all offers with status `CLOSED`, reason `ERRAND_CANCELLED`
8. Negotiation events are immutable (UPDATE/DELETE rejected)
9. Offer list sorted by price returns offers in correct order with Pro runners first
10. Failed offer submission (validation error) does not count against daily limit
11. Offer on expired errand is rejected without counting

```bash
# Run all Phase 6 tests
npx vitest run --config ./vitest.config.int.ts src/entitlements src/offers src/negotiations src/runner
```

---

**End of Phase 6 Plan**
