import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import sharp from 'sharp';
import { createHash, randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import {
  API,
  adminLogin,
  bearer,
  createAdmin,
  seedAdminRoles,
  seedPolicies,
  signedInUser,
} from '../test/auth.helper.js';
import { fakeStorage, hasGpsData, makeImage, requestAndUpload, uploadAndConfirm } from '../test/media.helper.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { OutboxService } from '../queue/outbox.service.js';
import { OutboxPublisher } from '../queue/outbox.publisher.js';
import { MediaProcessingService } from './media-processing.service.js';
import { MediaAccessService } from './media-access.service.js';
import { MediaCleanupService } from './media-cleanup.service.js';
import { MediaWorker } from './media.worker.js';
import { MEDIA_MODERATION_HOOK, type IMediaModerationHook } from './moderation.hook.js';
import { MediaCleanupSweeper } from '../scheduler/media-cleanup.sweeper.js';
import type { MediaPurpose } from '@prisma/client';

process.env.RATE_LIMIT_DISABLED = 'true';

type User = Awaited<ReturnType<typeof signedInUser>>;

describe('Media (Phase 3)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();

  const server = () => app.getHttpServer();
  const as = (user: User) => ({
    get: (path: string) => request(server()).get(`${API}${path}`).set(...bearer(user.accessToken)),
    post: (path: string) => request(server()).post(`${API}${path}`).set(...bearer(user.accessToken)),
    put: (path: string) => request(server()).put(`${API}${path}`).set(...bearer(user.accessToken)),
    delete: (path: string) => request(server()).delete(`${API}${path}`).set(...bearer(user.accessToken)),
  });
  const row = (id: string) => prisma.media.findUniqueOrThrow({ where: { id } });
  const processing = () => app.get(MediaProcessingService);
  const storage = () => fakeStorage(app);
  const exists = async (key: string | null) => (key ? (await storage().headObject(key)).exists : false);

  /** A user with a READY media row, processed for real. */
  const readyMedia = async (user: User, purpose: MediaPurpose = 'PROFILE_PHOTO', bytes?: Buffer) => {
    const { mediaId } = await uploadAndConfirm(app, user.accessToken, bytes ?? (await makeImage('jpeg')), { purpose });
    expect(await processing().process(mediaId)).toBe('READY');
    return mediaId;
  };

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    await seedAdminRoles();
    storage().reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await app.close();
  });

  describe('PUT /media/:id/content', () => {
    const requestUpload = async (user: User, sizeBytes: number, mimeType = 'image/png') =>
      (
        await as(user)
          .post('/media/uploads')
          .set('Idempotency-Key', randomUUID())
          .send({ purpose: 'PROFILE_PHOTO', mimeType, sizeBytes })
          .expect(201)
      ).body.data as { media: { id: string }; upload: { url: string; headers: Record<string, string> } };
    const put = (user: { accessToken: string }, id: string, bytes: Buffer, type = 'image/png') =>
      request(app.getHttpServer()).put(`${API}/media/${id}/content`).set('Authorization', `Bearer ${user.accessToken}`).set('Content-Type', type).send(bytes);

    it('stores the bytes through the API so confirm and processing work, with no bucket access from the browser', async () => {
      const user = await signedInUser(app);
      const bytes = await makeImage('png');
      const { media, upload } = await requestUpload(user, bytes.length);
      expect(upload.url).toBe(`/api/v1/media/${media.id}/content`);

      await request(app.getHttpServer())
        .put(upload.url)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .set(upload.headers)
        .send(bytes)
        .expect(204);
      const stored = await row(media.id);
      expect(Buffer.compare(await storage().getObject(stored.storageKey), bytes)).toBe(0);

      await as(user).post(`/media/${media.id}/confirm`).expect(200);
      expect((await row(media.id)).status).toBe('PROCESSING');
    });

    it('refuses a different type, a body larger or smaller than declared, and nothing is stored', async () => {
      const user = await signedInUser(app);
      const { media } = await requestUpload(user, 10);
      const key = (await row(media.id)).storageKey;

      expect((await put(user, media.id, Buffer.alloc(10, 1), 'image/jpeg')).body.error.details.reason).toBe('TYPE_MISMATCH');
      expect((await put(user, media.id, Buffer.alloc(11, 1))).status).toBe(400);
      expect((await put(user, media.id, Buffer.alloc(9, 1))).body.error.details.reason).toBe('SIZE_MISMATCH');
      expect((await storage().headObject(key)).exists).toBe(false);
      await put(user, media.id, Buffer.alloc(10, 1)).expect(204);
      expect((await storage().headObject(key)).exists).toBe(true);
    });

    it('is the owner only, and refuses once the upload was confirmed', async () => {
      const owner = await signedInUser(app);
      const other = await signedInUser(app);
      const bytes = await makeImage('png');
      const { media } = await requestUpload(owner, bytes.length);

      // Someone else's file is answered like a missing one (MEDIA_INVALID, as for confirm and GET).
      expect((await put(other, media.id, bytes)).status).toBe(400);
      await request(app.getHttpServer()).put(`${API}/media/${media.id}/content`).set('Content-Type', 'image/png').send(bytes).expect(401);
      await put(owner, media.id, bytes).expect(204);
      await as(owner).post(`/media/${media.id}/confirm`).expect(200);
      const again = await put(owner, media.id, bytes);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('RESOURCE_CONFLICT');
    });
  });

  describe('POST /media/uploads', () => {
    it('creates a PENDING row and an upload route on the API for exactly that file', async () => {
      const user = await signedInUser(app);

      const res = await as(user)
        .post('/media/uploads')
        .set('Idempotency-Key', randomUUID())
        .send({ purpose: 'ERRAND_PHOTO', mimeType: 'image/png', sizeBytes: 12345 })
        .expect(201);

      expect(res.body.data.media).toMatchObject({ purpose: 'ERRAND_PHOTO', status: 'PENDING', mimeType: 'image/png', sizeBytes: 12345 });
      expect(res.body.data.upload).toMatchObject({
        method: 'PUT',
        url: `/api/v1/media/${res.body.data.media.id}/content`,
        headers: { 'Content-Type': 'image/png' },
      });
      expect(JSON.stringify(res.body)).not.toContain('storageKey');
      const stored = await row(res.body.data.media.id);
      expect(stored.storageKey).toContain(user.userId);
      expect(stored.storageKey).toContain('errand_photo');
      // No presigned URL: the bucket is never given to the browser.
      expect(storage().getCalls('createPresignedUpload')).toHaveLength(0);
    });

    it('needs an Idempotency-Key and replays the first answer for a repeated key', async () => {
      const user = await signedInUser(app);
      const body = { purpose: 'PROFILE_PHOTO', mimeType: 'image/jpeg', sizeBytes: 1000 };

      await as(user).post('/media/uploads').send(body).expect(400);
      const key = randomUUID();
      const first = await as(user).post('/media/uploads').set('Idempotency-Key', key).send(body).expect(201);
      const second = await as(user).post('/media/uploads').set('Idempotency-Key', key).send(body).expect(201);

      expect(second.body.data.media.id).toBe(first.body.data.media.id);
      expect(await prisma.media.count()).toBe(1);
    });

    it.each(['image/gif', 'image/svg+xml', 'application/pdf', 'text/html', ''])('rejects the type "%s"', async (mimeType) => {
      const user = await signedInUser(app);

      const res = await as(user)
        .post('/media/uploads')
        .set('Idempotency-Key', randomUUID())
        .send({ purpose: 'PROFILE_PHOTO', mimeType, sizeBytes: 1000 })
        .expect(400);

      expect(res.body.error.code).toBe('MEDIA_INVALID');
      expect(res.body.error.details.reason).toBe('UNSUPPORTED_TYPE');
      expect(await prisma.media.count()).toBe(0);
    });

    it('rejects a file over MAX_UPLOAD_BYTES and accepts one at the limit', async () => {
      const user = await signedInUser(app);
      const send = (sizeBytes: number) =>
        as(user).post('/media/uploads').set('Idempotency-Key', randomUUID()).send({ purpose: 'PROFILE_PHOTO', mimeType: 'image/jpeg', sizeBytes });

      const tooBig = await send(5 * 1024 * 1024 + 1).expect(400);
      expect(tooBig.body.error).toMatchObject({ code: 'MEDIA_INVALID', details: { reason: 'TOO_LARGE', maxBytes: 5 * 1024 * 1024 } });
      await send(5 * 1024 * 1024).expect(201);
    });

    it.each([0, -5, 1.5, 'big'])('rejects the size %s', async (sizeBytes) => {
      const user = await signedInUser(app);

      await as(user)
        .post('/media/uploads')
        .set('Idempotency-Key', randomUUID())
        .send({ purpose: 'PROFILE_PHOTO', mimeType: 'image/jpeg', sizeBytes })
        .expect(400);
    });

    it('rejects an unknown purpose, and anonymous callers', async () => {
      const user = await signedInUser(app);

      await as(user).post('/media/uploads').set('Idempotency-Key', randomUUID()).send({ purpose: 'SELFIE', mimeType: 'image/jpeg', sizeBytes: 10 }).expect(400);
      await request(server()).post(`${API}/media/uploads`).set('Idempotency-Key', randomUUID()).send({ purpose: 'PROFILE_PHOTO', mimeType: 'image/jpeg', sizeBytes: 10 }).expect(401);
    });

    it('limits the number of unconfirmed uploads per user', async () => {
      const user = await signedInUser(app);
      const send = () =>
        as(user).post('/media/uploads').set('Idempotency-Key', randomUUID()).send({ purpose: 'OTHER', mimeType: 'image/jpeg', sizeBytes: 10 });

      for (let i = 0; i < 20; i += 1) {
        await send().expect(201);
      }
      const res = await send().expect(429);

      expect(res.body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('POST /media/:id/confirm', () => {
    it('moves the row to PROCESSING and queues one processing event', async () => {
      const user = await signedInUser(app);
      const { mediaId } = await requestAndUpload(app, user.accessToken, await makeImage('jpeg'));

      const res = await as(user).post(`/media/${mediaId}/confirm`).expect(200);

      expect(res.body.data.status).toBe('PROCESSING');
      expect(res.body.data.confirmedAt).not.toBeNull();
      const events = await prisma.outboxEvent.findMany({ where: { eventType: 'media.confirmed' } });
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({ mediaId });
    });

    it('is safe to repeat: no second event', async () => {
      const user = await signedInUser(app);
      const { mediaId } = await requestAndUpload(app, user.accessToken, await makeImage('jpeg'));

      await as(user).post(`/media/${mediaId}/confirm`).expect(200);
      const again = await as(user).post(`/media/${mediaId}/confirm`).expect(200);

      expect(again.body.data.status).toBe('PROCESSING');
      expect(await prisma.outboxEvent.count({ where: { eventType: 'media.confirmed' } })).toBe(1);
    });

    it('two confirms at the same moment queue one event', async () => {
      const user = await signedInUser(app);
      const { mediaId } = await requestAndUpload(app, user.accessToken, await makeImage('jpeg'));

      await Promise.all([as(user).post(`/media/${mediaId}/confirm`), as(user).post(`/media/${mediaId}/confirm`)]);

      expect(await prisma.outboxEvent.count({ where: { eventType: 'media.confirmed' } })).toBe(1);
    });

    it("fails with MEDIA_INVALID for someone else's upload, and the upload stays confirmable by its owner", async () => {
      const owner = await signedInUser(app);
      const stranger = await signedInUser(app);
      const { mediaId } = await requestAndUpload(app, owner.accessToken, await makeImage('jpeg'));

      const res = await as(stranger).post(`/media/${mediaId}/confirm`).expect(400);

      expect(res.body.error.code).toBe('MEDIA_INVALID');
      expect((await row(mediaId)).status).toBe('PENDING');
      await as(owner).post(`/media/${mediaId}/confirm`).expect(200);
    });

    it('fails with MEDIA_INVALID for an id that does not exist (same answer as someone else\'s)', async () => {
      const user = await signedInUser(app);

      const res = await as(user).post(`/media/${randomUUID()}/confirm`).expect(400);

      expect(res.body.error.code).toBe('MEDIA_INVALID');
    });

    it('fails with MEDIA_INVALID when nothing was uploaded, and stays PENDING so the client can retry', async () => {
      const user = await signedInUser(app);
      const res = await as(user).post('/media/uploads').set('Idempotency-Key', randomUUID()).send({ purpose: 'PROFILE_PHOTO', mimeType: 'image/jpeg', sizeBytes: 500 }).expect(201);
      const mediaId = res.body.data.media.id as string;

      const confirm = await as(user).post(`/media/${mediaId}/confirm`).expect(400);

      expect(confirm.body.error).toMatchObject({ code: 'MEDIA_INVALID', details: { reason: 'OBJECT_MISSING' } });
      expect((await row(mediaId)).status).toBe('PENDING');
      const { storageKey } = await row(mediaId).then((r) => ({ storageKey: r.storageKey }));
      storage().simulateClientUpload(storageKey, Buffer.alloc(500, 1), 'image/jpeg');
      await as(user).post(`/media/${mediaId}/confirm`).expect(200);
    });

    it('rejects an upload whose size differs from the request, and removes the object', async () => {
      const user = await signedInUser(app);
      const bytes = await makeImage('jpeg');
      const { mediaId, storageKey } = await requestAndUpload(app, user.accessToken, bytes, { declaredSize: bytes.length + 10 });

      const res = await as(user).post(`/media/${mediaId}/confirm`).expect(400);

      expect(res.body.error.details.reason).toBe('UPLOAD_MISMATCH');
      expect((await row(mediaId)).status).toBe('REJECTED');
      expect(await exists(storageKey)).toBe(false);
    });

    it('rejects an upload whose content type differs from the request', async () => {
      const user = await signedInUser(app);
      const bytes = await makeImage('png');
      const { mediaId, storageKey } = await requestAndUpload(app, user.accessToken, bytes, { mimeType: 'image/jpeg' });
      storage().simulateClientUpload(storageKey, bytes, 'image/png');

      const res = await as(user).post(`/media/${mediaId}/confirm`).expect(400);

      expect(res.body.error.code).toBe('MEDIA_INVALID');
      expect((await row(mediaId)).rejectionReason).toBe('UPLOAD_MISMATCH');
    });

    it('rejects an object over the server hard cap', async () => {
      const user = await signedInUser(app);
      const bytes = await makeImage('jpeg');
      await app.get(BusinessConfigService).set('SERVER_HARD_UPLOAD_BYTES', 100);
      const { mediaId } = await requestAndUpload(app, user.accessToken, bytes);

      await as(user).post(`/media/${mediaId}/confirm`).expect(400);

      expect((await row(mediaId)).status).toBe('REJECTED');
    });

    it('rejects a malformed id', async () => {
      const user = await signedInUser(app);

      await as(user).post('/media/not-a-uuid/confirm').expect(400);
    });
  });

  describe('processing', () => {
    it('removes GPS and every other EXIF field, and replaces the original upload', async () => {
      const user = await signedInUser(app);
      const original = await makeImage('jpeg', { gps: true });
      expect(await hasGpsData(original)).toBe(true);
      const { mediaId, storageKey } = await uploadAndConfirm(app, user.accessToken, original);

      expect(await processing().process(mediaId)).toBe('READY');

      const media = await row(mediaId);
      const stored = await storage().getObject(media.storageKey);
      expect(await hasGpsData(stored)).toBe(false);
      expect((await sharp(stored).metadata()).exif).toBeUndefined();
      const thumb = await storage().getObject(media.thumbnailKey!);
      expect((await sharp(thumb).metadata()).exif).toBeUndefined();
      expect(await exists(storageKey)).toBe(false);
      expect(media.storageKey).not.toBe(storageKey);
      expect(media.storageKey).toContain(`${user.userId}/profile_photo/${mediaId}/`);
    });

    it('fills in size, dimensions, checksum and times', async () => {
      const user = await signedInUser(app);
      const { mediaId } = await uploadAndConfirm(app, user.accessToken, await makeImage('jpeg', { width: 800, height: 600 }));

      await processing().process(mediaId);

      const media = await row(mediaId);
      const stored = await storage().getObject(media.storageKey);
      expect(media).toMatchObject({ status: 'READY', width: 800, height: 600, moderationStatus: 'NONE', rejectionReason: null });
      expect(Number(media.sizeBytes)).toBe(stored.length);
      expect(media.checksum).toBe(createHash('sha256').update(stored).digest('hex'));
      expect(media.processedAt).not.toBeNull();
    });

    it('scales large images down to 1600 px and makes a thumbnail of at most 320 px', async () => {
      const user = await signedInUser(app);
      const { mediaId } = await uploadAndConfirm(app, user.accessToken, await makeImage('jpeg', { width: 3200, height: 2000 }));

      await processing().process(mediaId);

      const media = await row(mediaId);
      expect([media.width, media.height]).toEqual([1600, 1000]);
      const thumb = await sharp(await storage().getObject(media.thumbnailKey!)).metadata();
      expect(thumb.format).toBe('webp');
      expect(Math.max(thumb.width!, thumb.height!)).toBe(320);
    });

    it('never enlarges a small image', async () => {
      const user = await signedInUser(app);
      const { mediaId } = await uploadAndConfirm(app, user.accessToken, await makeImage('png', { width: 200, height: 100 }), { mimeType: 'image/png' });

      await processing().process(mediaId);

      expect([(await row(mediaId)).width, (await row(mediaId)).height]).toEqual([200, 100]);
    });

    it('applies the camera orientation before stripping it, so the picture is not sideways', async () => {
      const user = await signedInUser(app);
      const { mediaId } = await uploadAndConfirm(app, user.accessToken, await makeImage('jpeg', { width: 800, height: 600, orientation: 6 }));

      await processing().process(mediaId);

      const media = await row(mediaId);
      expect([media.width, media.height]).toEqual([600, 800]);
      expect((await sharp(await storage().getObject(media.storageKey)).metadata()).orientation).toBeUndefined();
    });

    it.each([
      ['jpeg', 'image/jpeg', 'jpg'],
      ['png', 'image/png', 'png'],
      ['webp', 'image/webp', 'webp'],
    ] as const)('keeps the %s format and extension', async (type, mime, extension) => {
      const user = await signedInUser(app);
      const { mediaId } = await uploadAndConfirm(app, user.accessToken, await makeImage(type), { mimeType: mime });

      await processing().process(mediaId);

      const media = await row(mediaId);
      expect(media.status).toBe('READY');
      expect(media.storageKey.endsWith(`.${extension}`)).toBe(true);
      expect((await sharp(await storage().getObject(media.storageKey)).metadata()).format).toBe(type);
    });

    it('rejects bytes that are not an image, whatever the declared type, and deletes them', async () => {
      const user = await signedInUser(app);
      const { mediaId, storageKey } = await uploadAndConfirm(app, user.accessToken, Buffer.from('<?php system($_GET["c"]); ?>'));

      expect(await processing().process(mediaId)).toBe('REJECTED');

      expect(await row(mediaId)).toMatchObject({ status: 'REJECTED', rejectionReason: 'NOT_AN_IMAGE' });
      expect(await exists(storageKey)).toBe(false);
    });

    it('rejects an SVG renamed to .jpg', async () => {
      const user = await signedInUser(app);
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
      const { mediaId } = await uploadAndConfirm(app, user.accessToken, svg);

      await processing().process(mediaId);

      expect((await row(mediaId)).rejectionReason).toBe('NOT_AN_IMAGE');
    });

    it('rejects an image whose real type differs from the declared type', async () => {
      const user = await signedInUser(app);
      const { mediaId } = await uploadAndConfirm(app, user.accessToken, await makeImage('png'), { mimeType: 'image/jpeg' });

      await processing().process(mediaId);

      expect(await row(mediaId)).toMatchObject({ status: 'REJECTED', rejectionReason: 'TYPE_MISMATCH' });
    });

    it('rejects a file with a valid signature and a corrupt body', async () => {
      const user = await signedInUser(app);
      const bad = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
      const { mediaId } = await uploadAndConfirm(app, user.accessToken, bad, { mimeType: 'image/png' });

      await processing().process(mediaId);

      expect((await row(mediaId)).rejectionReason).toBe('CORRUPT_IMAGE');
    });

    it('rejects an image with too many pixels before decoding it', async () => {
      const user = await signedInUser(app);
      const huge = await makeImage('png', { width: 7200, height: 7200 });
      const { mediaId } = await uploadAndConfirm(app, user.accessToken, huge, { mimeType: 'image/png' });

      await processing().process(mediaId);

      expect((await row(mediaId)).rejectionReason).toBe('TOO_MANY_PIXELS');
    }, 60_000);

    it('rejects when the object is gone', async () => {
      const user = await signedInUser(app);
      const { mediaId, storageKey } = await uploadAndConfirm(app, user.accessToken, await makeImage('jpeg'));
      await storage().deleteObject(storageKey);

      await processing().process(mediaId);

      expect((await row(mediaId)).rejectionReason).toBe('OBJECT_MISSING');
    });

    it('rejects an object over the hard cap even if it passed confirm earlier', async () => {
      const user = await signedInUser(app);
      const { mediaId } = await uploadAndConfirm(app, user.accessToken, await makeImage('jpeg'));
      await app.get(BusinessConfigService).set('SERVER_HARD_UPLOAD_BYTES', 100);

      await processing().process(mediaId);

      expect((await row(mediaId)).rejectionReason).toBe('TOO_LARGE');
    });

    it('does nothing for media that is not PROCESSING', async () => {
      const user = await signedInUser(app);
      const { mediaId } = await requestAndUpload(app, user.accessToken, await makeImage('jpeg'));

      expect(await processing().process(mediaId)).toBe('SKIPPED');
      expect(await processing().process(randomUUID())).toBe('SKIPPED');

      expect((await row(mediaId)).status).toBe('PENDING');
    });

    it('is retry-safe: a second run changes nothing', async () => {
      const user = await signedInUser(app);
      const { mediaId } = await uploadAndConfirm(app, user.accessToken, await makeImage('jpeg', { gps: true }));
      await processing().process(mediaId);
      const before = await row(mediaId);

      expect(await processing().process(mediaId)).toBe('SKIPPED');

      expect(await row(mediaId)).toEqual(before);
      expect(await exists(before.storageKey)).toBe(true);
    });

    it('is retry-safe when two workers run the same job at once', async () => {
      const user = await signedInUser(app);
      const { mediaId, storageKey } = await uploadAndConfirm(app, user.accessToken, await makeImage('jpeg', { gps: true }));

      await Promise.all([processing().process(mediaId), processing().process(mediaId)]);

      const media = await row(mediaId);
      expect(media.status).toBe('READY');
      expect(await exists(media.storageKey)).toBe(true);
      expect(await exists(media.thumbnailKey)).toBe(true);
      expect(await exists(storageKey)).toBe(false);
    });

    it('is retry-safe after a storage outage: the job fails, the row stays PROCESSING, the retry succeeds', async () => {
      const user = await signedInUser(app);
      const { mediaId } = await uploadAndConfirm(app, user.accessToken, await makeImage('jpeg'));
      const spy = vi.spyOn(storage(), 'getObject').mockRejectedValueOnce(new Error('S3 is down'));

      await expect(processing().process(mediaId)).rejects.toThrow('S3 is down');
      expect((await row(mediaId)).status).toBe('PROCESSING');
      spy.mockRestore();

      expect(await processing().process(mediaId)).toBe('READY');
    });

    it('rejects the row when every retry has failed', async () => {
      const user = await signedInUser(app);
      const { mediaId, storageKey } = await uploadAndConfirm(app, user.accessToken, await makeImage('jpeg'));

      await processing().markFailed(mediaId);

      expect(await row(mediaId)).toMatchObject({ status: 'REJECTED', rejectionReason: 'PROCESSING_FAILED' });
      expect(await exists(storageKey)).toBe(false);
    });

    describe('moderation hook', () => {
      const hook = () => app.get<IMediaModerationHook>(MEDIA_MODERATION_HOOK);

      it('FLAG publishes the file and marks it for review', async () => {
        const user = await signedInUser(app);
        const { mediaId } = await uploadAndConfirm(app, user.accessToken, await makeImage('jpeg'));
        vi.spyOn(hook(), 'review').mockResolvedValueOnce({ decision: 'FLAG', reason: 'maybe' });

        expect(await processing().process(mediaId)).toBe('FLAGGED');

        expect(await row(mediaId)).toMatchObject({ status: 'READY', moderationStatus: 'FLAGGED' });
      });

      it('REJECT removes the file', async () => {
        const user = await signedInUser(app);
        const { mediaId, storageKey } = await uploadAndConfirm(app, user.accessToken, await makeImage('jpeg'));
        vi.spyOn(hook(), 'review').mockResolvedValueOnce({ decision: 'REJECT' });

        expect(await processing().process(mediaId)).toBe('REJECTED');

        expect(await row(mediaId)).toMatchObject({ status: 'REJECTED', moderationStatus: 'REMOVED', rejectionReason: 'MODERATION' });
        expect(await exists(storageKey)).toBe(false);
        expect(storage().getCalls('putObject')).toHaveLength(0);
      });

      it('sees the cleaned image, never the original with its location data', async () => {
        const user = await signedInUser(app);
        const { mediaId } = await uploadAndConfirm(app, user.accessToken, await makeImage('jpeg', { gps: true }));
        const spy = vi.spyOn(hook(), 'review');

        await processing().process(mediaId);

        const seen = spy.mock.calls[0][0];
        expect(seen).toMatchObject({ mediaId, ownerId: user.userId, purpose: 'PROFILE_PHOTO' });
        expect(await hasGpsData(seen.image)).toBe(false);
      });
    });

    it('runs end to end through the outbox, the media queue and the worker', async () => {
      const user = await signedInUser(app);
      const { mediaId } = await uploadAndConfirm(app, user.accessToken, await makeImage('jpeg', { gps: true }));
      const worker = app.get(MediaWorker);

      // Registering wrote `user.created` too (analytics), so more than the one media event is pending.
      expect(await app.get(OutboxService).publishPendingEvents((event) => app.get(OutboxPublisher).publish(event))).toBeGreaterThanOrEqual(1);
      worker.start();
      try {
        await vi.waitFor(async () => expect((await row(mediaId)).status).toBe('READY'), { timeout: 20_000, interval: 200 });
      } finally {
        await worker.stop();
      }

      const media = await row(mediaId);
      expect(await hasGpsData(await storage().getObject(media.storageKey))).toBe(false);
    }, 40_000);
  });

  describe('GET /media/:id', () => {
    it('shows the owner the status, and a rejection reason only when rejected', async () => {
      const user = await signedInUser(app);
      const good = await readyMedia(user);
      const bad = await uploadAndConfirm(app, user.accessToken, Buffer.from('not an image'));
      await processing().process(bad.mediaId);

      const ok = await as(user).get(`/media/${good}`).expect(200);
      const rejected = await as(user).get(`/media/${bad.mediaId}`).expect(200);

      expect(ok.body.data).toMatchObject({ status: 'READY', rejectionReason: null, width: 800, height: 600 });
      expect(rejected.body.data).toMatchObject({ status: 'REJECTED', rejectionReason: 'NOT_AN_IMAGE' });
    });

    it('answers MEDIA_INVALID to anyone else', async () => {
      const owner = await signedInUser(app);
      const stranger = await signedInUser(app);
      const id = await readyMedia(owner);

      const res = await as(stranger).get(`/media/${id}`).expect(400);

      expect(res.body.error.code).toBe('MEDIA_INVALID');
    });
  });

  describe('GET /media/:id/url (purpose-scoped access)', () => {
    it('gives the owner a short-lived URL for the file and for the thumbnail', async () => {
      const user = await signedInUser(app);
      const id = await readyMedia(user, 'DISPUTE_EVIDENCE');
      const media = await row(id);

      const full = await as(user).get(`/media/${id}/url`).expect(200);
      const thumb = await as(user).get(`/media/${id}/url?variant=thumbnail`).expect(200);

      expect(full.body.data).toMatchObject({ variant: 'full' });
      expect(full.body.data.url).toContain(media.storageKey);
      expect(thumb.body.data).toMatchObject({ variant: 'thumbnail' });
      expect(thumb.body.data.url).toContain(media.thumbnailKey!);
      expect(storage().getCalls('createPresignedDownload')[0].args[1]).toBe(300);
      const ttl = new Date(full.body.data.expiresAt).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(200_000);
      expect(ttl).toBeLessThanOrEqual(300_000);
    });

    it('answers 409 MEDIA_NOT_READY while processing and MEDIA_INVALID once rejected', async () => {
      const user = await signedInUser(app);
      const pending = await uploadAndConfirm(app, user.accessToken, await makeImage('jpeg'));
      const rejected = await uploadAndConfirm(app, user.accessToken, Buffer.from('nope'));
      await processing().process(rejected.mediaId);

      const waiting = await as(user).get(`/media/${pending.mediaId}/url`).expect(409);
      const bad = await as(user).get(`/media/${rejected.mediaId}/url`).expect(400);

      expect(waiting.body.error.code).toBe('MEDIA_NOT_READY');
      expect(bad.body.error.code).toBe('MEDIA_INVALID');
    });

    it.each<MediaPurpose>([
      'DISPUTE_EVIDENCE',
      'VERIFICATION_INPUT',
      'CHAT_IMAGE',
      'PICKUP_EVIDENCE',
      'DELIVERY_EVIDENCE',
      'PURCHASE_RECEIPT',
      'ERRAND_PHOTO',
      'OTHER',
    ])('an unrelated user cannot reach %s, even knowing the media id and the storage key', async (purpose) => {
      const owner = await signedInUser(app);
      const stranger = await signedInUser(app);
      const id = await readyMedia(owner, purpose);
      const { storageKey } = await row(id);
      storage().reset();

      const res = await as(stranger).get(`/media/${id}/url`).expect(404);
      const thumb = await as(stranger).get(`/media/${id}/url?variant=thumbnail`).expect(404);

      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
      expect(thumb.body.error.code).toBe('RESOURCE_NOT_FOUND');
      expect(JSON.stringify(res.body)).not.toContain(storageKey);
      expect(storage().getCalls('createPresignedDownload')).toHaveLength(0);
    });

    it('answers the same 404 for an id that does not exist', async () => {
      const user = await signedInUser(app);

      const res = await as(user).get(`/media/${randomUUID()}/url`).expect(404);

      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('needs a signed-in user', async () => {
      await request(server()).get(`${API}/media/${randomUUID()}/url`).expect(401);
    });

    it('a module that registers a policy decides who else may view (and only when the file is READY)', async () => {
      const owner = await signedInUser(app);
      const party = await signedInUser(app);
      const stranger = await signedInUser(app);
      app.get(MediaAccessService).register({
        purposes: ['DISPUTE_EVIDENCE'],
        canView: async (_media, viewerId) => viewerId === party.userId,
      });
      const pending = await uploadAndConfirm(app, owner.accessToken, await makeImage('jpeg'), { purpose: 'DISPUTE_EVIDENCE' });
      const id = await readyMedia(owner, 'DISPUTE_EVIDENCE');

      await as(party).get(`/media/${pending.mediaId}/url`).expect(404);
      await as(party).get(`/media/${id}/url`).expect(200);
      await as(stranger).get(`/media/${id}/url`).expect(404);
    });

    it('nobody but an admin sees a file removed by moderation, not even the owner', async () => {
      const user = await signedInUser(app);
      const id = await readyMedia(user);
      await prisma.$executeRaw`UPDATE media SET moderation_status = 'REMOVED' WHERE id = ${id}::uuid`;

      await as(user).get(`/media/${id}/url`).expect(404);
    });

    describe('profile photos', () => {
      it('are visible to other signed-in users while they are the current photo', async () => {
        const owner = await signedInUser(app);
        const viewer = await signedInUser(app);
        const id = await readyMedia(owner);
        await as(owner).put('/me/photo').send({ mediaId: id }).expect(200);

        await as(viewer).get(`/media/${id}/url?variant=thumbnail`).expect(200);
      });

      it('are private again when not set as the photo', async () => {
        const owner = await signedInUser(app);
        const viewer = await signedInUser(app);
        const id = await readyMedia(owner);

        await as(viewer).get(`/media/${id}/url`).expect(404);
      });

      it('are hidden from a user who is blocked by the owner, and from one who blocked the owner', async () => {
        const owner = await signedInUser(app);
        const blocked = await signedInUser(app);
        const blocker = await signedInUser(app);
        const id = await readyMedia(owner);
        await as(owner).put('/me/photo').send({ mediaId: id }).expect(200);
        await as(owner).post(`/users/${blocked.userId}/block`).expect(204);
        await as(blocker).post(`/users/${owner.userId}/block`).expect(204);

        await as(blocked).get(`/media/${id}/url`).expect(404);
        await as(blocker).get(`/media/${id}/url`).expect(404);
        await as(owner).get(`/media/${id}/url`).expect(200);
      });
    });

    describe('admin', () => {
      const adminGet = (token: string, id: string) =>
        request(server()).get(`${API}/admin/media/${id}/url`).set(...bearer(token));

      it('needs the permission that matches the purpose, and every view is audited', async () => {
        const user = await signedInUser(app);
        const verification = await readyMedia(user, 'VERIFICATION_INPUT');
        const photo = await readyMedia(user, 'PROFILE_PHOTO');
        const support = await adminLogin(app, await createAdmin(app, { roles: ['SUPPORT_AGENT'] }));
        const safety = await adminLogin(app, await createAdmin(app, { roles: ['TRUST_AND_SAFETY'] }));

        const denied = await adminGet(support.accessToken!, verification).expect(403);
        await adminGet(support.accessToken!, photo).expect(200);
        const allowed = await adminGet(safety.accessToken!, verification).expect(200);

        expect(denied.body.error.code).toBe('FORBIDDEN');
        expect(allowed.body.data.variant).toBe('full');
        const audit = await prisma.auditLog.findMany({ where: { action: 'media.admin_viewed' }, orderBy: { createdAt: 'asc' } });
        expect(audit.map((a) => a.actorId)).toEqual([support.adminId, safety.adminId]);
        expect(audit[1]).toMatchObject({ actorType: 'ADMIN', entityType: 'media', entityId: verification });
        expect(audit[1].metadata).toEqual({ purpose: 'VERIFICATION_INPUT', variant: 'full' });
      });

      it('is closed to anonymous callers and to consumer tokens', async () => {
        const user = await signedInUser(app);
        const id = await readyMedia(user);

        await request(server()).get(`${API}/admin/media/${id}/url`).expect(401);
        await adminGet(user.accessToken, id).expect(401);
      });

      it('answers 404 for an id that does not exist', async () => {
        const admin = await adminLogin(app, await createAdmin(app));

        await adminGet(admin.accessToken!, randomUUID()).expect(404);
      });
    });
  });

  describe('PUT and DELETE /me/photo', () => {
    it('sets a READY profile photo and shows it on the profile', async () => {
      const user = await signedInUser(app);
      const id = await readyMedia(user);

      const res = await as(user).put('/me/photo').send({ mediaId: id }).expect(200);

      expect(res.body.data.photoMediaId).toBe(id);
      const me = await as(user).get('/me').expect(200);
      expect(me.body.data.photoMediaId).toBe(id);
    });

    it('refuses media that is not ready, not a profile photo, rejected or not the caller\'s', async () => {
      const user = await signedInUser(app);
      const other = await signedInUser(app);
      const processingOne = await uploadAndConfirm(app, user.accessToken, await makeImage('jpeg'));
      const errandPhoto = await readyMedia(user, 'ERRAND_PHOTO');
      const rejected = await uploadAndConfirm(app, user.accessToken, Buffer.from('nope'));
      await processing().process(rejected.mediaId);
      const theirs = await readyMedia(other);

      expect((await as(user).put('/me/photo').send({ mediaId: processingOne.mediaId }).expect(409)).body.error.code).toBe('MEDIA_NOT_READY');
      expect((await as(user).put('/me/photo').send({ mediaId: errandPhoto }).expect(400)).body.error.code).toBe('MEDIA_INVALID');
      expect((await as(user).put('/me/photo').send({ mediaId: rejected.mediaId }).expect(400)).body.error.code).toBe('MEDIA_INVALID');
      expect((await as(user).put('/me/photo').send({ mediaId: theirs }).expect(400)).body.error.code).toBe('MEDIA_INVALID');
      expect((await as(user).get('/me').expect(200)).body.data.photoMediaId).toBeNull();
      await as(user).put('/me/photo').send({ mediaId: 'nope' }).expect(400);
    });

    it('replacing the photo deletes the previous one, row and files', async () => {
      const user = await signedInUser(app);
      const first = await readyMedia(user);
      await as(user).put('/me/photo').send({ mediaId: first }).expect(200);
      const firstRow = await row(first);
      const second = await readyMedia(user);

      await as(user).put('/me/photo').send({ mediaId: second }).expect(200);

      expect((await row(first)).deletedAt).not.toBeNull();
      expect(await exists(firstRow.storageKey)).toBe(false);
      expect(await exists(firstRow.thumbnailKey)).toBe(false);
      expect((await as(user).get('/me').expect(200)).body.data.photoMediaId).toBe(second);
    });

    it('setting the same photo again changes nothing', async () => {
      const user = await signedInUser(app);
      const id = await readyMedia(user);

      await as(user).put('/me/photo').send({ mediaId: id }).expect(200);
      await as(user).put('/me/photo').send({ mediaId: id }).expect(200);

      expect((await row(id)).deletedAt).toBeNull();
      expect(await exists((await row(id)).storageKey)).toBe(true);
    });

    it('DELETE removes the photo and is safe to repeat', async () => {
      const user = await signedInUser(app);
      const id = await readyMedia(user);
      await as(user).put('/me/photo').send({ mediaId: id }).expect(200);

      const res = await as(user).delete('/me/photo').expect(200);
      await as(user).delete('/me/photo').expect(200);

      expect(res.body.data.photoMediaId).toBeNull();
      expect((await row(id)).deletedAt).not.toBeNull();
      expect(await exists((await row(id)).storageKey)).toBe(false);
    });

    it('is closed to anonymous callers', async () => {
      await request(server()).put(`${API}/me/photo`).send({ mediaId: randomUUID() }).expect(401);
      await request(server()).delete(`${API}/me/photo`).expect(401);
    });
  });

  describe('DELETE /media/:id', () => {
    it('lets the owner cancel an upload that is still waiting, removing the object', async () => {
      const user = await signedInUser(app);
      const { mediaId, storageKey } = await requestAndUpload(app, user.accessToken, await makeImage('jpeg'));

      await as(user).delete(`/media/${mediaId}`).expect(204);

      expect((await row(mediaId)).deletedAt).not.toBeNull();
      expect(await exists(storageKey)).toBe(false);
      await as(user).get(`/media/${mediaId}`).expect(400);
      await as(user).post(`/media/${mediaId}/confirm`).expect(400);
    });

    it('keeps files that records may depend on (errand photos, chat images, evidence)', async () => {
      const user = await signedInUser(app);
      for (const purpose of ['ERRAND_PHOTO', 'CHAT_IMAGE', 'DISPUTE_EVIDENCE', 'VERIFICATION_INPUT'] as const) {
        const id = await readyMedia(user, purpose);

        const res = await as(user).delete(`/media/${id}`).expect(409);

        expect(res.body.error.code).toBe('RESOURCE_CONFLICT');
        expect((await row(id)).deletedAt).toBeNull();
      }
    });

    it('a profile photo can be deleted, and clears the profile', async () => {
      const user = await signedInUser(app);
      const id = await readyMedia(user);
      await as(user).put('/me/photo').send({ mediaId: id }).expect(200);

      await as(user).delete(`/media/${id}`).expect(204);

      expect((await as(user).get('/me').expect(200)).body.data.photoMediaId).toBeNull();
    });

    it("cannot delete someone else's media", async () => {
      const owner = await signedInUser(app);
      const stranger = await signedInUser(app);
      const { mediaId } = await requestAndUpload(app, owner.accessToken, await makeImage('jpeg'));

      const res = await as(stranger).delete(`/media/${mediaId}`).expect(400);

      expect(res.body.error.code).toBe('MEDIA_INVALID');
      expect((await row(mediaId)).deletedAt).toBeNull();
    });

    it('the database refuses a hard delete of a media row', async () => {
      const user = await signedInUser(app);
      const { mediaId } = await requestAndUpload(app, user.accessToken, await makeImage('jpeg'));

      await expect(prisma.$executeRaw`DELETE FROM media WHERE id = ${mediaId}::uuid`).rejects.toThrow();
    });
  });

  describe('cleanup', () => {
    const cleanup = () => app.get(MediaCleanupService);
    const age = (id: string, interval: string) =>
      prisma.$executeRawUnsafe(`UPDATE media SET created_at = now() - interval '${interval}', updated_at = now() - interval '${interval}' WHERE id = '${id}'::uuid`);

    it('deletes uploads never confirmed within 24 hours (object and row) and keeps newer ones', async () => {
      const user = await signedInUser(app);
      const old = await requestAndUpload(app, user.accessToken, await makeImage('jpeg'));
      const fresh = await requestAndUpload(app, user.accessToken, await makeImage('jpeg'));
      const confirmed = await uploadAndConfirm(app, user.accessToken, await makeImage('jpeg'));
      await age(old.mediaId, '25 hours');
      await age(confirmed.mediaId, '25 hours');

      expect(await cleanup().deleteOrphanUploads()).toBe(1);

      expect((await row(old.mediaId)).deletedAt).not.toBeNull();
      expect(await exists(old.storageKey)).toBe(false);
      expect((await row(fresh.mediaId)).deletedAt).toBeNull();
      expect(await exists(fresh.storageKey)).toBe(true);
      expect((await row(confirmed.mediaId)).deletedAt).toBeNull();
    });

    it('uses the configured number of hours', async () => {
      const user = await signedInUser(app);
      const upload = await requestAndUpload(app, user.accessToken, await makeImage('jpeg'));
      await age(upload.mediaId, '2 hours');
      expect(await cleanup().deleteOrphanUploads()).toBe(0);

      await app.get(BusinessConfigService).set('MEDIA_ORPHAN_HOURS', 1);

      expect(await cleanup().deleteOrphanUploads()).toBe(1);
    });

    it('a late confirm of an orphan fails cleanly', async () => {
      const user = await signedInUser(app);
      const upload = await requestAndUpload(app, user.accessToken, await makeImage('jpeg'));
      await age(upload.mediaId, '30 hours');
      await cleanup().deleteOrphanUploads();

      await as(user).post(`/media/${upload.mediaId}/confirm`).expect(400);
    });

    it('removes the files of an anonymised account and keeps the rows as a record', async () => {
      const user = await signedInUser(app);
      const keep = await signedInUser(app);
      const id = await readyMedia(user);
      const kept = await readyMedia(keep);
      const media = await row(id);
      await prisma.$executeRaw`UPDATE users SET anonymised_at = now(), phone_e164 = NULL, email = NULL WHERE id = ${user.userId}::uuid`;

      expect(await cleanup().deleteMediaOfAnonymisedUsers()).toBe(1);

      expect((await row(id)).deletedAt).not.toBeNull();
      expect(await exists(media.storageKey)).toBe(false);
      expect(await exists(media.thumbnailKey)).toBe(false);
      expect((await row(kept)).deletedAt).toBeNull();
      expect(await cleanup().deleteMediaOfAnonymisedUsers()).toBe(0);
    });

    it('queues processing again for confirmed uploads stuck for over 10 minutes, once per 10 minutes', async () => {
      const user = await signedInUser(app);
      const stuck = await uploadAndConfirm(app, user.accessToken, await makeImage('jpeg'));
      const recent = await uploadAndConfirm(app, user.accessToken, await makeImage('jpeg'));
      await prisma.$executeRaw`UPDATE media SET updated_at = now() - interval '11 minutes' WHERE id = ${stuck.mediaId}::uuid`;
      const before = await prisma.outboxEvent.count({ where: { eventType: 'media.confirmed' } });

      expect(await cleanup().requeueStuckProcessing()).toBe(1);
      expect(await cleanup().requeueStuckProcessing()).toBe(0);

      expect(await prisma.outboxEvent.count({ where: { eventType: 'media.confirmed' } })).toBe(before + 1);
      const events = await prisma.outboxEvent.findMany({ where: { eventType: 'media.confirmed' } });
      expect(events.filter((e) => (e.payload as { mediaId: string }).mediaId === stuck.mediaId)).toHaveLength(2);
      expect(events.filter((e) => (e.payload as { mediaId: string }).mediaId === recent.mediaId)).toHaveLength(1);
    });

    it('the sweeper runs all three steps', async () => {
      const user = await signedInUser(app);
      const old = await requestAndUpload(app, user.accessToken, await makeImage('jpeg'));
      await age(old.mediaId, '25 hours');
      const sweeper = new MediaCleanupSweeper(prisma as never, cleanup());

      expect(await sweeper['processBatch']()).toBe(1);
    });
  });
});
