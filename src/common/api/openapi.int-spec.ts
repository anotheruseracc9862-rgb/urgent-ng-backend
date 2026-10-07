import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { OpenAPIObject } from '@nestjs/swagger';
import { createTestApp } from '../../test/app.factory.js';
import { cleanAll } from '../../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../../test/auth.helper.js';
import { makeImage, requestAndUpload } from '../../test/media.helper.js';
import { MediaProcessingService } from '../../media/media-processing.service.js';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.RATE_LIMIT_DISABLED = 'true';

type Schema = { $ref?: string; type?: string; properties?: Record<string, Schema>; items?: Schema; required?: string[]; nullable?: boolean; enum?: unknown[] };

describe('OpenAPI document', () => {
  let app: INestApplication;
  let doc: OpenAPIObject;

  const operations = () =>
    Object.entries(doc.paths).flatMap(([path, item]) =>
      (['get', 'post', 'put', 'patch', 'delete'] as const)
        .filter((method) => (item as Record<string, unknown>)[method])
        .map((method) => ({ path, method, op: (item as Record<string, any>)[method] })),
    );

  const resolve = (schema: Schema): Schema => {
    if (!schema.$ref) return schema;
    const name = schema.$ref.replace('#/components/schemas/', '');
    return (doc.components!.schemas as Record<string, Schema>)[name];
  };

  /** The `data` schema of a documented success response. */
  const dataSchema = (path: string, method: string, status: string): Schema => {
    const response = (doc.paths[path] as any)[method].responses[status];
    return resolve(response.content['application/json'].schema.properties.data);
  };

  /** Every key in the real object is documented, and every documented required key is present. */
  const expectMatches = (actual: unknown, schema: Schema, where: string) => {
    const resolved = resolve(schema);
    if (resolved.type === 'array') {
      for (const item of actual as unknown[]) expectMatches(item, resolved.items!, `${where}[]`);
      return;
    }
    if (!resolved.properties) return;
    const documented = Object.keys(resolved.properties);
    const object = actual as Record<string, unknown>;
    expect(Object.keys(object).filter((k) => !documented.includes(k)), `${where}: undocumented keys`).toEqual([]);
    for (const key of resolved.required ?? []) {
      expect(object, `${where}: missing required ${key}`).toHaveProperty(key);
    }
    for (const [key, value] of Object.entries(object)) {
      const child = resolved.properties[key];
      if (value !== null && typeof value === 'object') expectMatches(value, child, `${where}.${key}`);
    }
  };

  beforeAll(async () => {
    app = await createTestApp();
    // The Swagger compiler plugin only runs in `nest build`, so the document is checked the way
    // the frontend gets it: build, run the real generator, read the file it writes.
    const build = spawnSync('npx', ['nest', 'build'], { shell: true, encoding: 'utf8', timeout: 120_000 });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    const generate = spawnSync('node', ['dist/scripts/generate-openapi.js'], { encoding: 'utf8', timeout: 120_000 });
    expect(generate.status, generate.stdout + generate.stderr).toBe(0);
    doc = JSON.parse(readFileSync(join(process.cwd(), 'openapi.json'), 'utf8')) as OpenAPIObject;
  }, 300_000);
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
  });
  afterAll(async () => {
    await app.close();
  });

  it('documents the Phase 2 route groups under /api/v1', () => {
    const paths = Object.keys(doc.paths);

    for (const expected of [
      '/api/v1/auth/register',
      '/api/v1/auth/login',
      '/api/v1/auth/refresh',
      '/api/v1/auth/password/reset',
      '/api/v1/me',
      '/api/v1/me/sessions/{id}',
      '/api/v1/me/notification-preferences',
      '/api/v1/me/delete-request',
      '/api/v1/users/{id}/block',
      '/api/v1/reference/categories',
      '/api/v1/admin/auth/mfa/verify',
    ]) {
      expect(paths).toContain(expected);
    }
  });

  it('gives every operation a unique id, a tag and a documented success response', () => {
    const ids = new Set<string>();
    for (const { path, method, op } of operations()) {
      if (path.includes('/health')) continue;
      expect(ids.has(op.operationId), `duplicate operationId ${op.operationId}`).toBe(false);
      ids.add(op.operationId);
      expect(op.tags?.length, `${method} ${path} has no tag`).toBeGreaterThan(0);
      const success = Object.keys(op.responses).filter((s) => s.startsWith('2'));
      expect(success.length, `${method} ${path} documents no 2xx`).toBeGreaterThan(0);
    }
  });

  it('wraps every documented 2xx body in the standard envelope', () => {
    for (const { path, method, op } of operations()) {
      if (path.includes('/health')) continue;
      for (const [status, response] of Object.entries<any>(op.responses)) {
        if (!status.startsWith('2') || status === '204') continue;
        const schema = response.content?.['application/json']?.schema;
        expect(schema?.properties?.data, `${method} ${path} ${status} has no data`).toBeDefined();
        expect(schema?.properties?.requestId, `${method} ${path} ${status} has no requestId`).toBeDefined();
      }
    }
  });

  it('lists the security scheme on every protected route and none on public ones', () => {
    const security = (path: string, method: string) =>
      JSON.stringify((doc.paths[path] as any)[method].security ?? []);

    expect(security('/api/v1/me', 'get')).toContain('consumer');
    expect(security('/api/v1/me/sessions', 'get')).toContain('consumer-cookie');
    expect(security('/api/v1/admin/auth/me', 'get')).toContain('admin');
    expect(security('/api/v1/auth/login', 'post')).toBe('[]');
    expect(security('/api/v1/reference/categories', 'get')).toBe('[]');
    expect(Object.keys(doc.components!.securitySchemes!).sort()).toEqual(
      ['admin', 'admin-cookie', 'consumer', 'consumer-cookie'],
    );
  });

  it('documents error responses with the standard error body', () => {
    const login = (doc.paths['/api/v1/auth/login'] as any).post.responses['401'];

    expect(login.content['application/json'].schema.$ref).toContain('ErrorBodyDto');
    const error = (doc.components!.schemas as any).ErrorBodyDto;
    expect(Object.keys(error.properties)).toEqual(['error', 'requestId']);
  });

  it('documents request bodies with constraints and enums from the validators', () => {
    const schemas = doc.components!.schemas as Record<string, any>;

    expect(schemas.RegisterDto.required).toEqual(['name', 'password', 'consents']);
    expect(schemas.RegisterDto.properties.password).toMatchObject({ minLength: 8, maxLength: 128 });
    expect(schemas.RegisterDto.properties.email.format).toBe('email');
    expect(schemas.ConsentInputDto.properties.type.enum).toContain('TERMS_OF_SERVICE');
    expect(schemas.RegisterDeviceDto.properties.type.enum).toEqual(['MOBILE_PUSH', 'WEB_PUSH']);
    expect(schemas.VerifyOtpDto.properties.code.pattern).toBeDefined();
  });

  it('resolves every $ref', () => {
    const text = JSON.stringify(doc);
    const refs = [...text.matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]);

    for (const name of new Set(refs)) {
      expect((doc.components!.schemas as Record<string, unknown>)[name], `missing schema ${name}`).toBeDefined();
    }
  });

  describe('real responses match the documented schemas', () => {
    const get = (path: string, token?: string) => {
      const req = request(app.getHttpServer()).get(`${API}${path}`);
      return token ? req.set(...bearer(token)) : req;
    };

    it('GET /me, /me/sessions, /me/consents, /me/notification-preferences, /me/devices, /me/blocks', async () => {
      const user = await signedInUser(app);
      await request(app.getHttpServer()).post(`${API}/me/devices`).set(...bearer(user.accessToken)).send({ type: 'MOBILE_PUSH', pushToken: 'fcm-token-aaaaaaaa' });
      const other = await signedInUser(app);
      await request(app.getHttpServer()).post(`${API}/users/${other.userId}/block`).set(...bearer(user.accessToken));

      for (const path of ['/me', '/me/sessions', '/me/consents', '/me/notification-preferences', '/me/devices', '/me/blocks']) {
        const res = await get(path, user.accessToken).expect(200);
        expectMatches(res.body.data, dataSchema(`/api/v1${path}`, 'get', '200'), path);
      }
    });

    it('GET /users/:id and the public reference endpoints', async () => {
      const user = await signedInUser(app);
      const other = await signedInUser(app);

      const profile = await get(`/users/${other.userId}`, user.accessToken).expect(200);
      expectMatches(profile.body.data, dataSchema('/api/v1/users/{id}', 'get', '200'), 'users/:id');
      const policies = await get('/reference/policies').expect(200);
      expectMatches(policies.body.data, dataSchema('/api/v1/reference/policies', 'get', '200'), 'policies');
    });

    it('the media flow: request upload, confirm, get, signed URL and profile photo', async () => {
      const user = await signedInUser(app);
      const bytes = await makeImage('jpeg');
      const upload = await request(app.getHttpServer())
        .post(`${API}/media/uploads`)
        .set(...bearer(user.accessToken))
        .set('Idempotency-Key', 'contract-test-key-1')
        .send({ purpose: 'PROFILE_PHOTO', mimeType: 'image/jpeg', sizeBytes: bytes.length })
        .expect(201);
      expectMatches(upload.body.data, dataSchema('/api/v1/media/uploads', 'post', '201'), 'media upload');

      const { mediaId } = await requestAndUpload(app, user.accessToken, bytes);
      const confirmed = await request(app.getHttpServer())
        .post(`${API}/media/${mediaId}/confirm`)
        .set(...bearer(user.accessToken))
        .expect(200);
      expectMatches(confirmed.body.data, dataSchema('/api/v1/media/{id}/confirm', 'post', '200'), 'media confirm');
      await app.get(MediaProcessingService).process(mediaId);

      const media = await get(`/media/${mediaId}`, user.accessToken).expect(200);
      expectMatches(media.body.data, dataSchema('/api/v1/media/{id}', 'get', '200'), 'media get');
      const url = await get(`/media/${mediaId}/url`, user.accessToken).expect(200);
      expectMatches(url.body.data, dataSchema('/api/v1/media/{id}/url', 'get', '200'), 'media url');
      const photo = await request(app.getHttpServer())
        .put(`${API}/me/photo`)
        .set(...bearer(user.accessToken))
        .send({ mediaId })
        .expect(200);
      expectMatches(photo.body.data, dataSchema('/api/v1/me/photo', 'put', '200'), 'me photo');
    });

    it('login (web and mobile), register and refresh', async () => {
      const phone = '+2348039990001';
      const reg = await request(app.getHttpServer())
        .post(`${API}/auth/register`)
        .send({ name: 'Ada Obi', phone, password: 'Str0ng-passw0rd!', consents: (await import('../../test/auth.helper.js')).REQUIRED_CONSENTS })
        .expect(201);
      expectMatches(reg.body.data, dataSchema('/api/v1/auth/register', 'post', '201'), 'register');

      const mobile = await request(app.getHttpServer()).post(`${API}/auth/login`).set('X-Client', 'mobile').send({ phone, password: 'Str0ng-passw0rd!' }).expect(200);
      const web = await request(app.getHttpServer()).post(`${API}/auth/login`).send({ phone, password: 'Str0ng-passw0rd!' }).expect(200);
      expectMatches(mobile.body.data, dataSchema('/api/v1/auth/login', 'post', '200'), 'login mobile');
      expectMatches(web.body.data, dataSchema('/api/v1/auth/login', 'post', '200'), 'login web');
      const refreshed = await request(app.getHttpServer()).post(`${API}/auth/refresh`).set('X-Client', 'mobile').send({ refreshToken: mobile.body.data.refreshToken }).expect(200);
      expectMatches(refreshed.body.data, dataSchema('/api/v1/auth/refresh', 'post', '200'), 'refresh');
    });
  });
});
