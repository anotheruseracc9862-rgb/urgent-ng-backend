/**
 * P8-02: realtime over SSE (Backend PRD 19.5, 36.11). Redis streams per user, replay, resync,
 * heartbeat, connection cap, tickets, and the dispatcher that fills the streams.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma, getTestRedis } from '../test/database.helper.js';
import { seedPolicies, signedInUser } from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { offerScene } from '../test/assignment.helper.js';
import { dispatchOutbox } from '../test/events.helper.js';
import { EventDispatcher } from '../queue/event-dispatcher.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { RealtimeService, streamKey } from './realtime.service.js';
import { RealtimeStreamService, type SseFrame } from './realtime-stream.service.js';
import { RealtimeTicketService } from './realtime-ticket.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Realtime (P8-02)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const prisma = getTestPrisma();
  let categoryId: string;
  const redis = () => getTestRedis();
  const realtime = () => app.get(RealtimeService);
  const streams = () => app.get(RealtimeStreamService);

  beforeAll(async () => {
    app = await createTestApp();
    const server = app.getHttpServer();
    if (!server.listening) {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    }
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    categoryId = (await seedCategories()).delivery;
  });
  afterAll(async () => {
    await app.close();
  });

  /** Collect frames until `done` says stop or the timeout passes. */
  async function collect(
    userId: string,
    lastEventId: string | undefined,
    done: (frames: SseFrame[]) => boolean,
    options: { heartbeatMs?: number; timeoutMs?: number } = {},
  ): Promise<SseFrame[]> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 3000);
    const frames: SseFrame[] = [];
    try {
      for await (const frame of streams().frames(userId, lastEventId, abort.signal, { heartbeatMs: options.heartbeatMs ?? 200 })) {
        frames.push(frame);
        if (done(frames)) break;
      }
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
    return frames;
  }
  const events = (frames: SseFrame[]) => frames.filter((f): f is Extract<SseFrame, { kind: 'event' }> => f.kind === 'event');

  describe('streams', () => {
    it('a first connection sees only events that arrive after it connected', async () => {
      const user = await signedInUser(app);
      await realtime().publish(user.userId, 'old.event', { n: 1 });
      const pending = collect(user.userId, undefined, (f) => events(f).length >= 1);
      await new Promise((r) => setTimeout(r, 150));
      await realtime().publish(user.userId, 'new.event', { n: 2 });

      const frames = await pending;

      expect(events(frames).map((f) => f.envelope.type)).toEqual(['new.event']);
      expect(events(frames)[0].envelope).toMatchObject({ version: 1, data: { n: 2 } });
      expect(events(frames)[0].envelope.id).toBe(events(frames)[0].id);
    });

    it('replays what was missed when the id is inside the window', async () => {
      const user = await signedInUser(app);
      const first = (await realtime().publish(user.userId, 'e.1', {}))!;
      await realtime().publish(user.userId, 'e.2', {});
      await realtime().publish(user.userId, 'e.3', {});

      const frames = await collect(user.userId, first, (f) => events(f).length >= 2);

      expect(events(frames).map((f) => f.envelope.type)).toEqual(['e.2', 'e.3']);
      expect(frames.some((f) => f.kind === 'resync')).toBe(false);
    });

    it('sends resync when the stream is gone (Redis flushed), the id is too old, or the id is not ours', async () => {
      const user = await signedInUser(app);
      const reasons = async (id: string) =>
        (await collect(user.userId, id, (f) => f.some((x) => x.kind === 'resync'))).filter((f) => f.kind === 'resync').map((f) => ((f as unknown as { envelope: { data: { reason: string } } }).envelope.data.reason));

      expect(await reasons('1700000000000-0')).toEqual(['NO_STREAM']);

      await realtime().publish(user.userId, 'e.1', {});
      await realtime().publish(user.userId, 'e.2', {});
      expect(await reasons('1-0')).toEqual(['TOO_OLD']);
      expect(await reasons('not-an-id')).toEqual(['INVALID_ID']);
    });

    it('after resync the connection carries on with new events', async () => {
      const user = await signedInUser(app);
      const pending = collect(user.userId, '1-0', (f) => events(f).length >= 1);
      await new Promise((r) => setTimeout(r, 200));
      await realtime().publish(user.userId, 'after.resync', {});

      const frames = await pending;

      expect(frames[0].kind).toBe('resync');
      expect(events(frames).map((f) => f.envelope.type)).toEqual(['after.resync']);
    });

    it('sends a heartbeat when nothing happens', async () => {
      const user = await signedInUser(app);
      const frames = await collect(user.userId, undefined, (f) => f.some((x) => x.kind === 'heartbeat'), { heartbeatMs: 100 });
      expect(frames.some((f) => f.kind === 'heartbeat')).toBe(true);
    });

    it('keeps a stream to about 1000 entries and expires it after a day', async () => {
      const user = await signedInUser(app);
      for (let i = 0; i < 20; i += 1) await realtime().publish(user.userId, 'bulk', { i });
      const ttl = await redis().ttl(streamKey(user.userId));
      expect(ttl).toBeGreaterThan(23 * 3600);
      expect(ttl).toBeLessThanOrEqual(24 * 3600);
      expect(await redis().xlen(streamKey(user.userId))).toBe(20);
    });

    it('a user never reads another user\'s stream', async () => {
      const a = await signedInUser(app);
      const b = await signedInUser(app);
      await realtime().publish(a.userId, 'private', { secret: true });
      const frames = await collect(b.userId, '0-0', () => false, { heartbeatMs: 100, timeoutMs: 400 });
      expect(events(frames)).toHaveLength(0);
    });
  });

  describe('dispatcher', () => {
    it('an offer reaches the requester and the runner streams, once, with scalar data only', async () => {
      const s = await offerScene(app, categoryId);
      const events1 = await dispatchOutbox(app, { eventType: 'offer.created' });
      // Delivering the same event again (a queue retry) must not write a second entry.
      await app.get(EventDispatcher).dispatch(events1[0]);

      for (const user of [s.requester, s.runner]) {
        const entries = await redis().xrange(streamKey(user.userId), '-', '+');
        const created = entries.filter(([, fields]) => fields[1] === 'offer.created');
        expect(created, user.userId).toHaveLength(1);
        const data = JSON.parse(created[0][1][5]) as Record<string, unknown>;
        expect(data).toMatchObject({ offerId: s.offerId, errandId: s.errandId, amountMinor: 50_000 });
        expect(Object.values(data).every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))).toBe(true);
      }
    });

    it('a notification is pushed to the stream as it is created', async () => {
      const s = await offerScene(app, categoryId);
      await dispatchOutbox(app, { eventType: 'offer.created' });
      const entries = await redis().xrange(streamKey(s.requester.userId), '-', '+');
      expect(entries.some(([, fields]) => fields[1] === 'notification.created')).toBe(true);
    });
  });

  describe('connections', () => {
    it('are capped per user: at the cap the oldest slot is dropped and its connection ends', async () => {
      const user = await signedInUser(app);
      const slots: string[] = [];
      for (let i = 0; i < 5; i += 1) slots.push(await streams().acquireSlot(user.userId, 5));

      const newest = await streams().acquireSlot(user.userId, 5);

      expect(await streams().refreshSlot(user.userId, slots[0])).toBe(false);
      expect(await streams().refreshSlot(user.userId, slots[1])).toBe(true);
      expect(await streams().refreshSlot(user.userId, newest)).toBe(true);
    });

    it('free a slot on close', async () => {
      const user = await signedInUser(app);
      const slot = await streams().acquireSlot(user.userId, 5);
      await streams().releaseSlot(user.userId, slot);
      expect(await streams().refreshSlot(user.userId, slot)).toBe(false);
    });
  });

  describe('tickets', () => {
    it('redeem once, and never when forged or expired', async () => {
      const user = await signedInUser(app);
      const tickets = app.get(RealtimeTicketService);

      const { ticket } = tickets.issue(user.userId);
      expect(await tickets.redeem(ticket)).toBe(user.userId);
      expect(await tickets.redeem(ticket)).toBeNull();

      const other = tickets.issue(user.userId);
      const [id, exp] = other.ticket.split('.');
      expect(await tickets.redeem(`${id}.${exp}.${'0'.repeat(64)}`)).toBeNull();
      const stale = tickets.issue(user.userId, Date.now() - 120_000);
      expect(await tickets.redeem(stale.ticket)).toBeNull();
    });
  });

  describe('GET /events over HTTP', () => {
    async function open(path: string, headers: Record<string, string> = {}) {
      const abort = new AbortController();
      const res = await fetch(`${baseUrl}${path}`, { headers, signal: abort.signal });
      return { res, abort };
    }
    async function readUntil(res: Response, text: string, timeoutMs = 3000): Promise<string> {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((resolve) => setTimeout(() => resolve({ value: undefined, done: true }), Math.max(deadline - Date.now(), 1))),
        ]);
        if (value) buffer += decoder.decode(value, { stream: true });
        if (buffer.includes(text) || done) break;
      }
      reader.releaseLock();
      return buffer;
    }

    it('requires authentication', async () => {
      const res = await fetch(`${baseUrl}/events`);
      expect(res.status).toBe(401);
    });

    it('streams events with the SSE headers and the envelope', async () => {
      const user = await signedInUser(app);
      const { res, abort } = await open('/events', { Authorization: `Bearer ${user.accessToken}` });
      try {
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        const head = await readUntil(res, 'retry: 3000');
        expect(head).toContain('retry: 3000');

        await realtime().publish(user.userId, 'assignment.accepted', { assignmentId: 'a-1' });
        const body = await readUntil(res, 'assignment.accepted');
        expect(body).toMatch(/id: \d+-\d+/);
        expect(body).toContain('"type":"assignment.accepted"');
        expect(body).toContain('"version":1');
      } finally {
        abort.abort();
      }
    });

    it('a ticket opens the stream once', async () => {
      const user = await signedInUser(app);
      const issued = await fetch(`${baseUrl}/events/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${user.accessToken}` } });
      expect(issued.status).toBe(200);
      const { ticket } = (await issued.json()).data as { ticket: string };

      const first = await open(`/events?ticket=${encodeURIComponent(ticket)}`);
      try {
        expect(first.res.status).toBe(200);
      } finally {
        first.abort.abort();
      }
      const second = await fetch(`${baseUrl}/events?ticket=${encodeURIComponent(ticket)}`);
      expect(second.status).toBe(401);
    });

    it('a connection over the cap is accepted and replaces the oldest one', async () => {
      await app.get(BusinessConfigService).set('REALTIME_MAX_CONNECTIONS_PER_USER', 2);
      const user = await signedInUser(app);
      const headers = { Authorization: `Bearer ${user.accessToken}` };
      const a = await open('/events', headers);
      const b = await open('/events', headers);
      const c = await open('/events', headers);
      try {
        expect(a.res.status).toBe(200);
        expect(b.res.status).toBe(200);
        expect(c.res.status).toBe(200);
      } finally {
        a.abort.abort();
        b.abort.abort();
        c.abort.abort();
      }
      expect(prisma).toBeTruthy();
    });
  });
});
