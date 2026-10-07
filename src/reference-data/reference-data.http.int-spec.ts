import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { API, seedPolicies } from '../test/auth.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Public reference data (HTTP)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  const get = (path: string) => request(app.getHttpServer()).get(`${API}/reference${path}`);

  const category = (
    key: string,
    name: string,
    options: { pickup?: boolean; destination?: boolean; popular?: boolean; active?: boolean; order?: number; deleted?: boolean } = {},
  ) =>
    prisma.$executeRaw`
      INSERT INTO categories (key, name, requires_pickup, requires_destination, sort_order, is_popular, active, deleted_at, updated_at)
      VALUES (${key}, ${name}, ${options.pickup ?? true}, ${options.destination ?? false}, ${options.order ?? 0},
              ${options.popular ?? false}, ${options.active ?? true}, ${options.deleted ? new Date() : null}, now())
    `;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('categories', () => {
    it('are public (no token) and carry their location rules, in sort order', async () => {
      await category('shopping_purchase', 'Shopping & Purchase', { pickup: false, destination: true, order: 2 });
      await category('delivery', 'Delivery', { pickup: true, destination: true, order: 1 });

      const res = await get('/categories').expect(200);

      expect(res.body.data).toEqual([
        { key: 'delivery', name: 'Delivery', requiresPickup: true, requiresDestination: true, isPopular: false },
        { key: 'shopping_purchase', name: 'Shopping & Purchase', requiresPickup: false, requiresDestination: true, isPopular: false },
      ]);
    });

    it('hide inactive and soft-deleted categories', async () => {
      await category('delivery', 'Delivery');
      await category('retired', 'Retired', { active: false });
      await category('removed', 'Removed', { deleted: true });

      const res = await get('/categories').expect(200);

      expect(res.body.data.map((c: { key: string }) => c.key)).toEqual(['delivery']);
    });

    it('list the popular ones separately', async () => {
      await category('delivery', 'Delivery', { popular: true, order: 1 });
      await category('document', 'Document', { popular: false, order: 2 });

      const res = await get('/popular-categories').expect(200);

      expect(res.body.data.map((c: { key: string }) => c.key)).toEqual(['delivery']);
    });

    it('never recycle a key', async () => {
      await category('delivery', 'Delivery');

      await expect(category('delivery', 'Another')).rejects.toThrow();
    });

    it('cannot be hard-deleted', async () => {
      await category('delivery', 'Delivery');

      await expect(prisma.$executeRaw`DELETE FROM categories`).rejects.toThrow(/not allowed/);
    });
  });

  describe('prohibited items', () => {
    const rule = (keyword: string, options: { status?: string; future?: boolean; deleted?: boolean } = {}) =>
      prisma.$executeRaw`
        INSERT INTO prohibited_item_rules (category, keyword, status, effective_from, policy_version, deleted_at, updated_at)
        VALUES ('WEAPONS', ${keyword}, ${options.status ?? 'ACTIVE'},
                ${options.future ? new Date(Date.now() + 86_400_000) : new Date(Date.now() - 3_600_000)}, '1.0',
                ${options.deleted ? new Date() : null}, now())
      `;

    it('lists active rules that are already in force', async () => {
      await rule('gun');
      await rule('knife', { status: 'INACTIVE' });
      await rule('future-thing', { future: true });
      await rule('removed', { deleted: true });

      const res = await get('/prohibited-items').expect(200);

      expect(res.body.data).toEqual([{ category: 'WEAPONS', keyword: 'gun', description: null, policyVersion: '1.0' }]);
    });
  });

  describe('policies', () => {
    it('lists the current version of every policy', async () => {
      const res = await get('/policies').expect(200);

      expect(res.body.data).toHaveLength(7);
      expect(res.body.data[0]).toEqual(
        expect.objectContaining({ type: expect.any(String), version: '1.0', documentRef: expect.any(String) }),
      );
    });

    it('returns one policy by type, always the newest published version', async () => {
      await prisma.$executeRaw`
        INSERT INTO policy_versions (type, version, document_ref, published_at, requires_reacceptance)
        VALUES ('TERMS_OF_SERVICE'::"ConsentType", '2.0', 'tos/2', date_trunc('milliseconds', now()), true)
      `;

      const res = await get('/policies/TERMS_OF_SERVICE').expect(200);

      expect(res.body.data).toMatchObject({ type: 'TERMS_OF_SERVICE', version: '2.0', requiresReacceptance: true });
    });

    it('does not show a version before its publish time', async () => {
      await prisma.$executeRaw`
        INSERT INTO policy_versions (type, version, document_ref, published_at)
        VALUES ('PRIVACY_POLICY'::"ConsentType", '2.0', 'p/2', now() + interval '1 day')
      `;

      const res = await get('/policies/PRIVACY_POLICY').expect(200);

      expect(res.body.data.version).toBe('1.0');
    });

    it('answers 400 for an unknown type and 404 when no version exists', async () => {
      await get('/policies/NOT_A_POLICY').expect(400);
      await prisma.$executeRaw`TRUNCATE policy_versions CASCADE`;

      const res = await get('/policies/TERMS_OF_SERVICE').expect(404);

      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('policy versions cannot be deleted', async () => {
      await expect(prisma.$executeRaw`DELETE FROM policy_versions`).rejects.toThrow(/not allowed/);
    });
  });
});
