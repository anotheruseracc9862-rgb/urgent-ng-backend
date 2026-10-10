/**
 * P7-07: the payment agreement (Backend PRD 16.1). A record of what the parties say they agreed;
 * nothing here processes money. HTTP only, real PostgreSQL.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { acceptedScene, cancelAssignment, selectedScene } from '../test/assignment.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Payment agreement (P7-07)', () => {
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
  const url = (assignmentId: string) => `${API}/assignments/${assignmentId}/payment-agreement`;
  const read = (user: Authed, assignmentId: string) => request(app.getHttpServer()).get(url(assignmentId)).set(...bearer(user.accessToken));
  const write = (user: Authed, assignmentId: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).put(url(assignmentId)).set(...bearer(user.accessToken)).send(body);

  it('exists from acceptance with the selected amount and nothing confirmed', async () => {
    const s = await acceptedScene(app, categoryId);

    for (const user of [s.requester, s.runner]) {
      const res = await read(user, s.assignmentId).expect(200);
      expect(res.body.data).toMatchObject({
        assignmentId: s.assignmentId,
        agreedAmountMinor: 50_000,
        currency: 'NGN',
        paymentMethod: null,
        paymentTiming: null,
        confirmedByRequesterAt: null,
        confirmedByRunnerAt: null,
        fullyConfirmed: false,
      });
    }
  });

  it('has none before acceptance, and is invisible to strangers', async () => {
    const pending = await selectedScene(app, categoryId);
    expect((await read(pending.runner, pending.assignmentId)).status).toBe(404);

    const s = await acceptedScene(app, categoryId);
    const stranger = await signedInUser(app);
    expect((await read(stranger, s.assignmentId)).status).toBe(404);
    expect((await write(stranger, s.assignmentId, { paymentMethod: 'CASH' })).status).toBe(404);
  });

  it('each party confirms their own side once method and timing are set', async () => {
    const s = await acceptedScene(app, categoryId);

    const early = await write(s.requester, s.assignmentId, { confirm: true });
    expect(early.status).toBe(400);

    await write(s.requester, s.assignmentId, { paymentMethod: 'BANK_TRANSFER', paymentTiming: 'AFTER_DELIVERY' }).expect(200);
    const first = await write(s.requester, s.assignmentId, { confirm: true }).expect(200);
    expect(first.body.data.confirmedByRequesterAt).toBeTruthy();
    expect(first.body.data.confirmedByRunnerAt).toBeNull();
    expect(first.body.data.fullyConfirmed).toBe(false);

    const second = await write(s.runner, s.assignmentId, { confirm: true }).expect(200);
    expect(second.body.data.fullyConfirmed).toBe(true);
    expect(second.body.data.confirmedByRequesterAt).toBeTruthy();
  });

  it('changing the method or timing clears both confirmations; an unchanged write clears nothing', async () => {
    const s = await acceptedScene(app, categoryId);
    await write(s.requester, s.assignmentId, { paymentMethod: 'CASH', paymentTiming: 'AT_DELIVERY', confirm: true }).expect(200);
    await write(s.runner, s.assignmentId, { confirm: true }).expect(200);

    const same = await write(s.runner, s.assignmentId, { paymentMethod: 'CASH', paymentTiming: 'AT_DELIVERY' }).expect(200);
    expect(same.body.data.fullyConfirmed).toBe(true);

    const changed = await write(s.runner, s.assignmentId, { paymentTiming: 'AFTER_DELIVERY' }).expect(200);
    expect(changed.body.data).toMatchObject({
      paymentTiming: 'AFTER_DELIVERY',
      confirmedByRequesterAt: null,
      confirmedByRunnerAt: null,
      fullyConfirmed: false,
    });
    const event = await prisma.outboxEvent.findMany({ where: { eventType: 'payment_agreement.updated', aggregateId: s.assignmentId } });
    expect(event.some((e) => (e.payload as { confirmationsCleared?: boolean }).confirmationsCleared === true)).toBe(true);
  });

  it('the amount cannot be written here', async () => {
    const s = await acceptedScene(app, categoryId);
    const res = await write(s.requester, s.assignmentId, { agreedAmountMinor: 1_000_000 });
    expect(res.status).toBe(400);
    expect(Number((await prisma.paymentAgreement.findUniqueOrThrow({ where: { assignmentId: s.assignmentId } })).agreedAmountMinor)).toBe(50_000);
  });

  it('rejects unknown methods and timings', async () => {
    const s = await acceptedScene(app, categoryId);
    expect((await write(s.requester, s.assignmentId, { paymentMethod: 'CRYPTO' })).status).toBe(400);
    expect((await write(s.requester, s.assignmentId, { paymentTiming: 'SOMETIME' })).status).toBe(400);
  });

  it('is read-only once the assignment has ended', async () => {
    const s = await acceptedScene(app, categoryId);
    await write(s.requester, s.assignmentId, { paymentMethod: 'CASH', paymentTiming: 'AT_PICKUP' }).expect(200);
    await cancelAssignment(app, s.requester, s.assignmentId).expect(200);

    const res = await write(s.requester, s.assignmentId, { paymentMethod: 'BANK_TRANSFER' });

    expect(res.status).toBe(409);
    expect((await read(s.requester, s.assignmentId).expect(200)).body.data.paymentMethod).toBe('CASH');
  });

  it('two parties writing at once keep a consistent record', async () => {
    const s = await acceptedScene(app, categoryId);

    await Promise.all([
      write(s.requester, s.assignmentId, { paymentMethod: 'CASH', paymentTiming: 'AT_DELIVERY' }),
      write(s.runner, s.assignmentId, { paymentMethod: 'BANK_TRANSFER', paymentTiming: 'AFTER_DELIVERY' }),
    ]);

    const row = await prisma.paymentAgreement.findUniqueOrThrow({ where: { assignmentId: s.assignmentId } });
    const pair = `${row.paymentMethod}/${row.paymentTiming}`;
    expect(['CASH/AT_DELIVERY', 'BANK_TRANSFER/AFTER_DELIVERY']).toContain(pair);
  });
});
