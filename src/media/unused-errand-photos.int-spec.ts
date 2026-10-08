import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { seedPolicies, signedInUser } from '../test/auth.helper.js';
import { fakeStorage, readyMedia } from '../test/media.helper.js';
import { createDraft, draftBody, seedCategories } from '../test/errand.helper.js';
import { MediaCleanupService } from './media-cleanup.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Cleanup of errand photos nobody used', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let categoryId: string;
  let user: Awaited<ReturnType<typeof signedInUser>>;
  const cleanup = () => app.get(MediaCleanupService);
  const age = (id: string, hours: number) =>
    prisma.$executeRawUnsafe(`UPDATE media SET created_at = now() - make_interval(hours => $1::int) WHERE id = $2::uuid`, hours, id);
  const row = async (id: string) => prisma.media.findUniqueOrThrow({ where: { id } });
  const stored = async (key: string) => (await fakeStorage(app).headObject(key)).exists;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    categoryId = (await seedCategories()).delivery;
    fakeStorage(app).reset();
    user = await signedInUser(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it('deletes a processed errand photo that no errand ever used, after MEDIA_ORPHAN_HOURS', async () => {
    const unused = await readyMedia(app, user.accessToken, 'ERRAND_PHOTO');
    const { storageKey, thumbnailKey } = await row(unused);
    await age(unused, 25);

    expect(await cleanup().deleteUnusedErrandPhotos()).toBe(1);

    expect((await row(unused)).deletedAt).toBeInstanceOf(Date);
    expect(await stored(storageKey)).toBe(false);
    if (thumbnailKey) expect(await stored(thumbnailKey)).toBe(false);
  });

  it('keeps a photo that is still young, one attached to an errand, and one that was attached and removed', async () => {
    const young = await readyMedia(app, user.accessToken, 'ERRAND_PHOTO');
    const attached = await readyMedia(app, user.accessToken, 'ERRAND_PHOTO');
    const removed = await readyMedia(app, user.accessToken, 'ERRAND_PHOTO');
    const draft = (await createDraft(app, user, draftBody(categoryId, { photoMediaIds: [attached, removed] })).expect(201)).body.data.id as string;
    await (await import('supertest')).default(app.getHttpServer())
      .patch(`/api/v1/errands/${draft}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ photoMediaIds: [attached] })
      .expect(200);
    for (const id of [attached, removed]) await age(id, 48);

    expect(await cleanup().deleteUnusedErrandPhotos()).toBe(0);

    for (const id of [young, attached, removed]) expect((await row(id)).deletedAt).toBeNull();
  });

  it('leaves other purposes alone', async () => {
    const profile = await readyMedia(app, user.accessToken, 'PROFILE_PHOTO');
    await age(profile, 72);
    expect(await cleanup().deleteUnusedErrandPhotos()).toBe(0);
    expect((await row(profile)).deletedAt).toBeNull();
  });

  it('cannot be attached once it has been cleaned up', async () => {
    const unused = await readyMedia(app, user.accessToken, 'ERRAND_PHOTO');
    await age(unused, 30);
    await cleanup().deleteUnusedErrandPhotos();
    await createDraft(app, user, draftBody(categoryId, { photoMediaIds: [unused] })).expect(400);
  });
});
