/**
 * The email logo is hosted by this backend: no login, an image, cacheable, and outside /api.
 * Mail apps load it from an absolute address, so it has to be reachable by anyone.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../../test/app.factory.js';
import { emailBrand } from './email-brand.js';

describe('email logo', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('is served at /assets/email/logo.png as a small PNG anyone can load', async () => {
    const res = await request(app.getHttpServer()).get('/assets/email/logo.png').expect(200);

    expect(res.headers['content-type']).toBe('image/png');
    expect(Number(res.headers['content-length'])).toBeLessThan(30_000);
    expect(res.headers['cache-control']).toContain('max-age=');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.body.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('is the address the emails use', () => {
    const { logoUrl } = emailBrand({ API_PUBLIC_URL: 'https://api.urgent.ng' } as NodeJS.ProcessEnv);
    expect(new URL(logoUrl).pathname).toBe('/assets/email/logo.png');
  });

  it('serves nothing else by accident: no directory listing, no files outside the assets folder', async () => {
    await request(app.getHttpServer()).get('/assets/').expect(404);
    await request(app.getHttpServer()).get('/assets/email/').expect(404);
    await request(app.getHttpServer()).get('/assets/../package.json').expect(404);
    await request(app.getHttpServer()).get('/assets/%2e%2e/package.json').expect(404);
    await request(app.getHttpServer()).get('/assets/email/missing.png').expect(404);
  });

  it('is not under the API prefix, so it needs no login and no versioned route', async () => {
    await request(app.getHttpServer()).get('/api/v1/assets/email/logo.png').expect(404);
  });
});
