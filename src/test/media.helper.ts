/**
 * Helpers for media tests: real image files (optionally with GPS EXIF) and the upload flow
 * against the fake storage provider.
 */

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { MediaPurpose } from '@prisma/client';
import { STORAGE_PROVIDER } from '../common/providers/storage.provider.js';
import type { FakeStorageProvider } from '../common/providers/fakes/storage.fake.js';
import { API, bearer } from './auth.helper.js';
import { getTestPrisma } from './database.helper.js';

export { makeImage, hasGpsData } from './image.factory.js';

export const fakeStorage = (app: INestApplication) => app.get<FakeStorageProvider>(STORAGE_PROVIDER);

export interface UploadOptions {
  purpose?: MediaPurpose;
  mimeType?: string;
  /** Size to declare. Defaults to the real size of `bytes`. */
  declaredSize?: number;
}

/** Request an upload as `token` and "upload" the bytes to the fake storage. Does not confirm. */
export async function requestAndUpload(
  app: INestApplication,
  token: string,
  bytes: Buffer,
  options: UploadOptions = {},
): Promise<{ mediaId: string; storageKey: string }> {
  const mimeType = options.mimeType ?? 'image/jpeg';
  const res = await request(app.getHttpServer())
    .post(`${API}/media/uploads`)
    .set(...bearer(token))
    .set('Idempotency-Key', randomUUID())
    .send({ purpose: options.purpose ?? 'PROFILE_PHOTO', mimeType, sizeBytes: options.declaredSize ?? bytes.length });
  if (res.status !== 201) {
    throw new Error(`upload request failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  const mediaId = res.body.data.media.id as string;
  const row = await getTestPrisma().media.findUniqueOrThrow({ where: { id: mediaId } });
  fakeStorage(app).simulateClientUpload(row.storageKey, bytes, mimeType);
  return { mediaId, storageKey: row.storageKey };
}

/** Request, upload and confirm. Returns once the row is PROCESSING. */
export async function uploadAndConfirm(
  app: INestApplication,
  token: string,
  bytes: Buffer,
  options: UploadOptions = {},
) {
  const uploaded = await requestAndUpload(app, token, bytes, options);
  await request(app.getHttpServer())
    .post(`${API}/media/${uploaded.mediaId}/confirm`)
    .set(...bearer(token))
    .expect(200);
  return uploaded;
}
