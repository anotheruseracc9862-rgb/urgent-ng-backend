/**
 * P12-07 (milestone M8): the critical flows of Backend PRD 34.2.
 *
 * One journey runs from an empty database through the HTTP API alone, from registration to rating
 * and on to deleting the account. The other flows are proven in the suites named in `FLOWS`; the
 * register below fails when a suite is renamed or its proof removed, so the list cannot rot.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { openErrand, seedCategories } from '../test/errand.helper.js';
import { readyRunner } from '../test/verification.helper.js';
import { listOffers, offerAction, submitOffer } from '../test/offer.helper.js';
import { acceptAssignment, completeErrand, executionStep, selectRunner, uniqueNin } from '../test/assignment.helper.js';
import { AccountService } from '../auth/account.service.js';
import { UserStatsService } from '../ratings/user-stats.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Critical flows (P12-07, milestone M8)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let categoryId: string;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    categoryId = (await seedCategories()).delivery;
  });
  afterAll(async () => {
    await app.close();
  });

  type Authed = { accessToken: string };
  const call = (method: 'get' | 'post', user: Authed, path: string, body: Record<string, unknown> = {}) => {
    const req = request(app.getHttpServer())[method](`${API}${path}`).set(...bearer(user.accessToken));
    return method === 'get' ? req : req.set('Idempotency-Key', randomUUID()).send(body);
  };

  it('register, verify, post, discover, offer, counter, select, accept, execute, complete, rate, delete the account', async () => {
    // Register and sign in (OTP-verified), and a runner who is verified and available.
    const requester = await signedInUser(app);
    const runner = await readyRunner(app, uniqueNin(1));

    // Post, discover, negotiate, select, accept.
    const errandId = await openErrand(app, requester, categoryId);
    const feed = (await call('get', runner, '/marketplace/errands').expect(200)).body.data as Array<{ id: string }>;
    expect(feed.map((e) => e.id)).toContain(errandId);
    const offer = (await submitOffer(app, runner, errandId, { amountMinor: 60_000 }).expect(201)).body.data;
    expect((await listOffers(app, requester, errandId).expect(200)).body.data).toHaveLength(1);
    const countered = await offerAction(app, requester, 'post', offer.id, 'counter', { amountMinor: 50_000, durationMinutes: 40 }).expect(200);
    const agreed = await offerAction(app, runner, 'post', offer.id, 'accept-counter', { expectedVersion: countered.body.data.version }).expect(200);
    const selected = await selectRunner(app, requester, errandId, offer.id, agreed.body.data.version).expect(201);
    const assignmentId = selected.body.data.id as string;
    await acceptAssignment(app, runner, assignmentId).expect(201);

    // Execute and complete.
    for (const step of ['start', 'pickup', 'deliver'] as const) {
      await executionStep(app, runner, assignmentId, step).expect(201);
    }
    await completeErrand(app, requester, errandId).expect(201);
    expect((await prisma.errand.findUniqueOrThrow({ where: { id: errandId } })).status).toBe('COMPLETED');

    // Rate each other. Ratings reveal together.
    await call('post', requester, `/assignments/${assignmentId}/ratings`, { scores: { overall: 5, reliability: 5 }, review: 'Careful and quick' }).expect(201);
    await call('post', runner, `/assignments/${assignmentId}/ratings`, { scores: { overall: 4 } }).expect(201);
    const seen = (await call('get', requester, `/assignments/${assignmentId}/ratings`).expect(200)).body.data;
    expect(seen.theirs).not.toBeNull();
    expect((await app.get(UserStatsService).get(runner.userId)).runner.count).toBe(1);

    // The requester asks to delete the account; after the grace period and the scrub the person is
    // gone from the other side's view, and the errand and both ratings stay.
    await call('post', requester, '/me/delete-request').expect(200);
    await prisma.$executeRaw`UPDATE users SET deletion_scheduled_at = now() - interval '1 minute' WHERE id = ${requester.userId}::uuid`;
    const accounts = app.get(AccountService);
    expect(await accounts.finalizeDueDeletions()).toBe(1);
    await prisma.$executeRaw`UPDATE users SET deleted_at = now() - interval '31 days' WHERE id = ${requester.userId}::uuid`;
    expect(await accounts.anonymiseDue()).toBe(1);

    expect(await prisma.rating.count({ where: { assignmentId } })).toBe(2);
    expect((await prisma.errand.findUniqueOrThrow({ where: { id: errandId } })).status).toBe('COMPLETED');
    expect(await prisma.user.findUniqueOrThrow({ where: { id: requester.userId }, select: { name: true, phoneE164: true } })).toEqual({
      name: 'Deleted User',
      phoneE164: null,
    });
    await call('get', runner, `/assignments/${assignmentId}`).expect(200);
    await call('get', requester, '/me').expect(401);
  });

  /** Each flow of Backend PRD 34.2 that has its own suite, the file, and a phrase that must still be in it. */
  const FLOWS: Array<[flow: string, file: string, proof: RegExp]> = [
    ['verification', 'src/verification/verification.http.int-spec.ts', /verification/i],
    ['cancellation at each stage', 'src/assignments/cancellation-matrix.int-spec.ts', /PICKED_UP: no plain cancel/],
    ['report pauses auto-completion', 'src/reports/reports.int-spec.ts', /a report by a party holds a delivered errand/],
    ['dispute pauses auto-completion', 'src/disputes/disputes.int-spec.ts', /DISMISS returns the errand to where it was/],
    ['offer-limit enforcement, concurrent', 'src/entitlements/offer-limit.service.int-spec.ts', /parallel submits never create more offers than the limit/],
    ['acceptance timeout', 'src/assignments/accept-decline-timeout.int-spec.ts', /refuses after the deadline and settles the timer at once/],
    ['errand expiry', 'src/assignments/core-flow.int-spec.ts', /an expired errand never accepts a selection/],
    ['auto-completion', 'src/execution/execution.int-spec.ts', /auto-complete/i],
    ['boost purchase', 'src/billing/billing.int-spec.ts', /allows one boost per errand/],
    ['Runner Pro purchase', 'src/billing/billing.int-spec.ts', /lifts the offer limit while it lasts/],
    ['duplicate webhooks', 'src/billing/billing.int-spec.ts', /acknowledges a duplicate without a second grant/],
    ['refund', 'src/billing/billing.int-spec.ts', /refunds an admin-approved purchase once/],
    ['account deletion and anonymisation', 'src/auth/account-deletion-privacy.int-spec.ts', /Account deletion leaves no personal data behind/],
    ['kill switch', 'src/errands/errands.http.int-spec.ts', /is closed by the posting kill switch/],
    ['retention and holds', 'src/retention/retention.int-spec.ts', /keeps the chat while a report, a dispute or a legal hold is open/],
    ['authorisation matrix', 'src/auth/authorization-matrix.http.int-spec.ts', /Authorisation matrix/],
    ['every route has an access decision', 'src/common/api/route-walker.int-spec.ts', /gives every route an authentication decision/],
  ];

  it.each(FLOWS)('has its proof in place: %s', (_flow, file, proof) => {
    expect(existsSync(file), `${file} is missing`).toBe(true);
    expect(readFileSync(file, 'utf8')).toMatch(proof);
  });
});
