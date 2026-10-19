/**
 * P8-01: conversations and messages (Backend PRD 18). HTTP only, real PostgreSQL and Redis.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma, getTestRedis } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { readyMedia } from '../test/media.helper.js';
import { offerAction } from '../test/offer.helper.js';
import { acceptedScene, cancelAssignment, completeErrand, executionStep, offerScene, selectedScene } from '../test/assignment.helper.js';
import { dispatchOutbox } from '../test/events.helper.js';
import { streamKey } from '../realtime/realtime.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Messaging (P8-01)', () => {
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

  type Authed = { accessToken: string; userId: string };
  const get = (user: Authed, path: string) => request(app.getHttpServer()).get(`${API}${path}`).set(...bearer(user.accessToken));
  const post = (user: Authed, path: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).post(`${API}${path}`).set(...bearer(user.accessToken)).send(body);
  const send = (user: Authed, conversationId: string, body: Record<string, unknown>) => post(user, `/conversations/${conversationId}/messages`, body);
  const text = (user: Authed, conversationId: string, body: string, clientMessageId?: string) =>
    send(user, conversationId, { type: 'TEXT', body, ...(clientMessageId ? { clientMessageId } : {}) });

  async function conversationOf(user: Authed) {
    const res = await get(user, '/conversations').expect(200);
    return res.body.data as Array<{ id: string; errandId: string; unreadCount: number; canSend: boolean; readOnlyReason: string | null; muted: boolean; counterpart: { userId: string } }>;
  }
  /** Chat opens only once the runner has accepted the errand. */
  async function chat() {
    const s = await acceptedScene(app, categoryId);
    const [conversation] = await conversationOf(s.requester);
    return { ...s, conversationId: conversation.id };
  }
  /** The conversation row exists from the first offer, but nobody can see or use it before acceptance. */
  const rowFor = (s: { errandId: string; runner: Authed }) => prisma.conversation.findFirstOrThrow({ where: { errandId: s.errandId, runnerId: s.runner.userId } });

  describe('conversations', () => {
    it('stay closed and hidden until the runner accepts, then open for both parties and link from the offer', async () => {
      const offered = await offerScene(app, categoryId);
      expect(await conversationOf(offered.requester)).toHaveLength(0);
      expect(await conversationOf(offered.runner)).toHaveLength(0);
      const row = await rowFor(offered);
      expect((await text(offered.runner, row.id, 'Hello')).body.error.details.reason).toBe('NOT_ASSIGNED');
      expect((await text(offered.requester, row.id, 'Hello')).body.error.code).toBe('CONVERSATION_READ_ONLY');
      expect(await prisma.message.count()).toBe(0);

      const s = await acceptedScene(app, categoryId);
      const requesterSide = await conversationOf(s.requester);
      const runnerSide = await conversationOf(s.runner);

      expect(requesterSide).toHaveLength(1);
      expect(runnerSide).toHaveLength(1);
      expect(requesterSide[0].id).toBe(runnerSide[0].id);
      expect(requesterSide[0]).toMatchObject({ errandId: s.errandId, canSend: true, readOnlyReason: null, unreadCount: 0, muted: false });
      expect(requesterSide[0].counterpart.userId).toBe(s.runner.userId);
      const offer = await prisma.offer.findUniqueOrThrow({ where: { id: s.offerId } });
      expect(offer.conversationId).toBe(requesterSide[0].id);
    });

    it('stay closed while several runners offer, so a requester is never messaged by more than the chosen one', async () => {
      const first = await offerScene(app, categoryId);
      const { addOffer } = await import('../test/assignment.helper.js');
      const second = await addOffer(app, first.errandId);

      expect(await conversationOf(first.requester)).toHaveLength(0);
      expect(await prisma.conversation.count({ where: { errandId: first.errandId } })).toBe(2);
      for (const runner of [first.runner, second.runner]) {
        const row = await prisma.conversation.findFirstOrThrow({ where: { errandId: first.errandId, runnerId: runner.userId } });
        expect((await text(runner, row.id, 'Hi')).body.error.details.reason).toBe('NOT_ASSIGNED');
      }
      expect(await prisma.message.count()).toBe(0);
    });

    it('a runner who withdraws and offers again keeps the same conversation', async () => {
      const s = await offerScene(app, categoryId);
      const first = await rowFor(s);
      await offerAction(app, s.runner, 'post', s.offerId, 'withdraw').expect(200);
      const { submitOffer } = await import('../test/offer.helper.js');
      await submitOffer(app, s.runner, s.errandId).expect(201);

      expect(await prisma.conversation.count({ where: { errandId: s.errandId } })).toBe(1);
      expect((await rowFor(s)).id).toBe(first.id);
    });

    it('carry what a list row and a detail pane need: preview, role, errand status and the offer amount', async () => {
      const s = await chat();
      await text(s.runner, s.conversationId, 'I can do it today').expect(201);

      const [row] = await conversationOf(s.requester) as unknown as Array<Record<string, any>>;

      expect(row.lastMessagePreview).toBe('I can do it today');
      expect(row.errandStatus).toBe('ACCEPTED');
      expect(row.counterpart).toMatchObject({ userId: s.runner.userId, role: 'RUNNER' });
      expect(row.counterpart.firstName).toEqual(expect.any(String));
      expect(row.amountKind).toBe('AGREED');
      expect(row.amountMinor).toBeGreaterThan(0);
      expect(row).toHaveProperty('pickupArea');
      expect(row.assignmentId).toEqual(expect.any(String));

      const [runnerRow] = await conversationOf(s.runner) as unknown as Array<Record<string, any>>;
      expect(runnerRow.counterpart.role).toBe('REQUESTER');
    });

    it('are invisible to everyone else', async () => {
      const s = await chat();
      const stranger = await signedInUser(app);

      expect(await conversationOf(stranger)).toHaveLength(0);
      expect((await get(stranger, `/conversations/${s.conversationId}`)).status).toBe(404);
      expect((await get(stranger, `/conversations/${s.conversationId}/messages`)).status).toBe(404);
      expect((await text(stranger, s.conversationId, 'hello')).status).toBe(404);
      expect((await post(stranger, `/conversations/${s.conversationId}/read`)).status).toBe(404);
    });
  });

  describe('messages', () => {
    it('are sent, listed newest first, delivered on read, and read on mark-read', async () => {
      const s = await chat();

      const first = await text(s.runner, s.conversationId, 'Can I pick it up at 4?').expect(201);
      await text(s.runner, s.conversationId, 'Please confirm').expect(201);
      expect(first.body.data).toMatchObject({ type: 'TEXT', status: 'SENT', senderId: s.runner.userId, body: 'Can I pick it up at 4?' });

      const requesterView = await conversationOf(s.requester);
      expect(requesterView[0].unreadCount).toBe(2);
      const list = (await get(s.requester, `/conversations/${s.conversationId}/messages`).expect(200)).body.data as Array<{ body: string; status: string; deliveredAt: string | null }>;
      expect(list.map((m) => m.body)).toEqual(['Please confirm', 'Can I pick it up at 4?']);
      expect(list.every((m) => m.deliveredAt !== null)).toBe(true);

      const marked = await post(s.requester, `/conversations/${s.conversationId}/read`).expect(200);
      expect(marked.body.data.marked).toBe(2);
      expect((await conversationOf(s.requester))[0].unreadCount).toBe(0);
      const afterRead = (await get(s.runner, `/conversations/${s.conversationId}/messages`).expect(200)).body.data as Array<{ status: string; readAt: string | null }>;
      expect(afterRead.every((m) => m.status === 'READ' && m.readAt !== null)).toBe(true);
      expect((await post(s.requester, `/conversations/${s.conversationId}/read`).expect(200)).body.data.marked).toBe(0);
    });

    it('a retried send with the same client id returns the first message', async () => {
      const s = await chat();
      const id = `client-${randomUUID()}`;

      const one = await text(s.runner, s.conversationId, 'Hello', id).expect(201);
      const two = await text(s.runner, s.conversationId, 'Hello', id).expect(201);

      expect(two.body.data.id).toBe(one.body.data.id);
      expect(await prisma.message.count({ where: { conversationId: s.conversationId } })).toBe(1);
    });

    it('parallel sends with one client id still make one message', async () => {
      const s = await chat();
      const id = `client-${randomUUID()}`;
      const results = await Promise.all(Array.from({ length: 5 }, () => text(s.runner, s.conversationId, 'Same', id)));
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(await prisma.message.count({ where: { conversationId: s.conversationId } })).toBe(1);
    });

    it('validates the content', async () => {
      const s = await chat();
      expect((await text(s.runner, s.conversationId, '')).status).toBe(400);
      expect((await text(s.runner, s.conversationId, 'x'.repeat(2001))).status).toBe(400);
      expect((await send(s.runner, s.conversationId, { type: 'IMAGE' })).status).toBe(400);
      expect((await send(s.runner, s.conversationId, { type: 'SYSTEM', body: 'x' })).status).toBe(400);
      expect(await prisma.message.count()).toBe(0);
    });

    it('carries one image that only the two parties may fetch', async () => {
      const s = await chat();
      const stranger = await signedInUser(app);
      const photo = await readyMedia(app, s.runner.accessToken, 'CHAT_IMAGE');

      const res = await send(s.runner, s.conversationId, { type: 'IMAGE', mediaId: photo }).expect(201);

      expect(res.body.data).toMatchObject({ type: 'IMAGE', mediaId: photo, body: null });
      await get(s.requester, `/media/${photo}/url`).expect(200);
      await get(s.runner, `/media/${photo}/url`).expect(200);
      expect((await get(stranger, `/media/${photo}/url`)).status).toBe(404);
      expect((await send(s.runner, s.conversationId, { type: 'IMAGE', mediaId: photo })).body.error.code).toBe('MEDIA_INVALID');
      const wrong = await readyMedia(app, s.runner.accessToken, 'PICKUP_EVIDENCE');
      expect((await send(s.runner, s.conversationId, { type: 'IMAGE', mediaId: wrong })).body.error.code).toBe('MEDIA_INVALID');
      const theirs = await readyMedia(app, s.requester.accessToken, 'CHAT_IMAGE');
      expect((await send(s.runner, s.conversationId, { type: 'IMAGE', mediaId: theirs })).body.error.code).toBe('MEDIA_INVALID');
    });

    it('the sender removes their own message: a tombstone for both, never a deleted row', async () => {
      const s = await chat();
      const sent = (await text(s.runner, s.conversationId, 'Wrong chat, sorry').expect(201)).body.data;

      expect((await request(app.getHttpServer()).delete(`${API}/messages/${sent.id}`).set(...bearer(s.requester.accessToken))).status).toBe(404);
      const removed = await request(app.getHttpServer()).delete(`${API}/messages/${sent.id}`).set(...bearer(s.runner.accessToken)).expect(200);

      expect(removed.body.data).toMatchObject({ status: 'REMOVED', body: null, mediaId: null });
      const theirView = (await get(s.requester, `/conversations/${s.conversationId}/messages`).expect(200)).body.data;
      expect(theirView[0]).toMatchObject({ id: sent.id, status: 'REMOVED', body: null });
      const row = await prisma.message.findUniqueOrThrow({ where: { id: sent.id } });
      expect(row.body).toBe('Wrong chat, sorry'); // kept for audit and disputes
      expect(row.removalReason).toBe('SENDER_DELETED');
      await request(app.getHttpServer()).delete(`${API}/messages/${sent.id}`).set(...bearer(s.runner.accessToken)).expect(200);
    });
  });

  describe('read-only rules (PRD 18.1)', () => {
    it('before acceptance sending is closed with NOT_ASSIGNED, whatever the offer is doing', async () => {
      const s = await offerScene(app, categoryId);
      const row = await rowFor(s);

      const res = await text(s.requester, row.id, 'Price ok?');

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONVERSATION_READ_ONLY');
      expect(res.body.error.details.reason).toBe('NOT_ASSIGNED');

      await offerAction(app, s.runner, 'post', s.offerId, 'withdraw').expect(200);
      expect((await text(s.requester, row.id, 'Hello?')).body.error.details.reason).toBe('NO_ACTIVE_OFFER');
    });

    it('a cancelled errand closes it', async () => {
      const s = await offerScene(app, categoryId);
      const row = await rowFor(s);
      await request(app.getHttpServer())
        .post(`${API}/errands/${s.errandId}/cancel`)
        .set(...bearer(s.requester.accessToken))
        .send({ reason: 'REQUESTER_CANCELLED' })
        .expect(200);

      const res = await text(s.runner, row.id, 'Still there?');

      expect(res.body.error.code).toBe('CONVERSATION_READ_ONLY');
      expect(res.body.error.details.reason).toBe('ERRAND_ENDED');
    });

    it('stays open through acceptance and execution, and for 7 days after completion', async () => {
      const s = await acceptedScene(app, categoryId);
      const [conversation] = await conversationOf(s.requester);
      await text(s.requester, conversation.id, 'Gate code is 4410').expect(201);
      for (const name of ['start', 'pickup', 'deliver'] as const) {
        await executionStep(app, s.runner, s.assignmentId, name).expect(201);
      }
      await completeErrand(app, s.requester, s.errandId).expect(201);
      await text(s.runner, conversation.id, 'Thanks!').expect(201);

      await prisma.$executeRaw`UPDATE assignments SET completed_at = now() - interval '8 days' WHERE id = ${s.assignmentId}::uuid`;
      const late = await text(s.runner, conversation.id, 'One more thing');

      expect(late.body.error.code).toBe('CONVERSATION_READ_ONLY');
      expect(late.body.error.details.reason).toBe('COMPLETION_WINDOW_ENDED');
    });

    it('a pending selection keeps it closed; a declined selection keeps it closed', async () => {
      const s = await selectedScene(app, categoryId);
      const row = await rowFor(s);
      expect((await text(s.runner, row.id, 'On my way to accept')).body.error.details.reason).toBe('NOT_ASSIGNED');

      await request(app.getHttpServer()).post(`${API}/assignments/${s.assignmentId}/decline`).set(...bearer(s.runner.accessToken)).send({}).expect(200);

      expect((await text(s.runner, row.id, 'Sorry')).body.error.code).toBe('CONVERSATION_READ_ONLY');
      expect(await conversationOf(s.requester)).toHaveLength(0);
    });

    it('an accepted assignment cancelled by the runner closes it until they offer again', async () => {
      const s = await acceptedScene(app, categoryId);
      const [conversation] = await conversationOf(s.requester);
      await cancelAssignment(app, s.runner, s.assignmentId, { reason: 'RUNNER_CANCELLED' }).expect(200);
      expect((await text(s.requester, conversation.id, 'Why?')).body.error.code).toBe('CONVERSATION_READ_ONLY');
    });

    it('a block in either direction stops sending but not reading', async () => {
      const s = await chat();
      await text(s.runner, s.conversationId, 'Before the block').expect(201);
      await request(app.getHttpServer()).post(`${API}/users/${s.runner.userId}/block`).set(...bearer(s.requester.accessToken)).expect(204);

      for (const sender of [s.requester, s.runner]) {
        const res = await text(sender, s.conversationId, 'After the block');
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('MESSAGE_BLOCKED');
      }
      expect((await get(s.requester, `/conversations/${s.conversationId}/messages`).expect(200)).body.data).toHaveLength(1);
    });
  });

  describe('notifications and realtime', () => {
    it('a message notifies the other person, without its text, and a muted conversation does not', async () => {
      const s = await chat();
      await text(s.runner, s.conversationId, 'My secret quote is 12345').expect(201);
      await dispatchOutbox(app, { eventType: 'message.created' });

      const notices = (await get(s.requester, '/notifications').expect(200)).body.data as Array<{ type: string; body: string; category: string; data: Record<string, unknown> }>;
      const message = notices.filter((n) => n.type === 'message.new');
      expect(message).toHaveLength(1);
      expect(message[0].category).toBe('MESSAGING');
      expect(JSON.stringify(message[0])).not.toContain('12345');
      expect(message[0].data).toMatchObject({ conversationId: s.conversationId });

      await post(s.requester, `/conversations/${s.conversationId}/mute`).expect(200);
      expect((await conversationOf(s.requester))[0].muted).toBe(true);
      await text(s.runner, s.conversationId, 'Another one').expect(201);
      await dispatchOutbox(app, { eventType: 'message.created' });
      const afterMute = (await get(s.requester, '/notifications').expect(200)).body.data as Array<{ type: string }>;
      expect(afterMute.filter((n) => n.type === 'message.new')).toHaveLength(1);

      await post(s.requester, `/conversations/${s.conversationId}/unmute`).expect(200);
      await text(s.runner, s.conversationId, 'Third').expect(201);
      await dispatchOutbox(app, { eventType: 'message.created' });
      const afterUnmute = (await get(s.requester, '/notifications').expect(200)).body.data as Array<{ type: string }>;
      expect(afterUnmute.filter((n) => n.type === 'message.new')).toHaveLength(2);
    });

    it('both parties get a realtime event without the message text', async () => {
      const s = await chat();
      await text(s.runner, s.conversationId, 'Quote 98765').expect(201);
      await dispatchOutbox(app, { eventType: 'message.created' });

      for (const user of [s.requester, s.runner]) {
        const entries = await getTestRedis().xrange(streamKey(user.userId), '-', '+');
        const created = entries.filter(([, fields]) => fields[1] === 'message.created');
        expect(created, user.userId).toHaveLength(1);
        expect(created[0][1][5]).not.toContain('98765');
        expect(JSON.parse(created[0][1][5])).toMatchObject({ conversationId: s.conversationId, type: 'TEXT' });
      }
    });
  });
});
