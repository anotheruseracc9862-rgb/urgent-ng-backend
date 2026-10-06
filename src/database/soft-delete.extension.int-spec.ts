import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseModule } from './database.module.js';
import { PrismaService } from './prisma.service.js';
import { SOFT_DELETABLE_MODELS, withDeleted } from './soft-delete.extension.js';
import { cleanDatabase } from '../test/database.helper.js';
import { testConfigModule } from '../test/test-modules.js';

describe('Soft delete and delete guards (integration)', () => {
  let module: TestingModule;
  let prisma: PrismaService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [testConfigModule(), DatabaseModule],
    }).compile();
    prisma = module.get(PrismaService);
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await module.close();
  });

  const newProduct = (code: string) =>
    prisma.commercialProduct.create({
      data: { code, name: code, type: 'RUNNER_PRO' },
    });

  describe('which models are soft-deletable', () => {
    it('covers models with a deletedAt column and nothing else', () => {
      expect(SOFT_DELETABLE_MODELS.has('ConfigValue')).toBe(true);
      expect(SOFT_DELETABLE_MODELS.has('CommercialProduct')).toBe(true);

      for (const model of ['AuditLog', 'PriceVersion', 'OutboxEvent', 'IdempotencyKey']) {
        expect(SOFT_DELETABLE_MODELS.has(model)).toBe(false);
      }
    });
  });

  describe('prisma.client (extension)', () => {
    it('turns delete into a soft delete and hides the row from reads', async () => {
      const product = await newProduct('SOFT_1');

      await prisma.client.commercialProduct.delete({ where: { id: product.id } });

      expect(await prisma.client.commercialProduct.findUnique({ where: { id: product.id } })).toBeNull();
      expect(await prisma.client.commercialProduct.findMany()).toHaveLength(0);
      expect(await prisma.client.commercialProduct.count()).toBe(0);

      const stillThere = await prisma.commercialProduct.findUniqueOrThrow({ where: { id: product.id } });
      expect(stillThere.deletedAt).not.toBeNull();
    });

    it('turns deleteMany into a soft delete of only the matching rows', async () => {
      await newProduct('KEEP_1');
      await newProduct('GONE_1');
      await newProduct('GONE_2');

      const result = (await prisma.client.commercialProduct.deleteMany({
        where: { code: { startsWith: 'GONE' } },
      })) as { count: number };

      expect(result.count).toBe(2);
      const visible = await prisma.client.commercialProduct.findMany();
      expect(visible.map((p) => p.code)).toEqual(['KEEP_1']);
      expect(await prisma.commercialProduct.count()).toBe(3);
    });

    it('shows deleted rows inside withDeleted()', async () => {
      const product = await newProduct('SOFT_2');
      await prisma.client.commercialProduct.delete({ where: { id: product.id } });

      const all = await withDeleted(() => prisma.client.commercialProduct.findMany());

      expect(all).toHaveLength(1);
      expect(all[0].deletedAt).not.toBeNull();
    });

    it('lets an explicit deletedAt filter win', async () => {
      const product = await newProduct('SOFT_3');
      await prisma.client.commercialProduct.delete({ where: { id: product.id } });

      const deleted = await prisma.client.commercialProduct.findMany({
        where: { deletedAt: { not: null } },
      });

      expect(deleted).toHaveLength(1);
    });

    it('does not update an already deleted row', async () => {
      const product = await newProduct('SOFT_4');
      await prisma.client.commercialProduct.delete({ where: { id: product.id } });

      await expect(
        prisma.client.commercialProduct.update({ where: { id: product.id }, data: { name: 'x' } }),
      ).rejects.toThrow();
      const result = await prisma.client.commercialProduct.updateMany({
        where: { id: product.id },
        data: { name: 'x' },
      });
      expect(result.count).toBe(0);
    });

    it('lets a code be reused after the old row is soft-deleted', async () => {
      const product = await newProduct('REUSE_1');
      await prisma.client.commercialProduct.delete({ where: { id: product.id } });

      await expect(newProduct('REUSE_1')).resolves.toBeDefined();
      await expect(newProduct('REUSE_1')).rejects.toThrow(); // duplicate among live rows
    });

    it('deletes rows of models without deletedAt for real (transient tables)', async () => {
      const event = await prisma.outboxEvent.create({
        data: { eventType: 'test.event', payload: {} },
      });

      await prisma.client.outboxEvent.delete({ where: { id: event.id } });

      expect(await prisma.outboxEvent.count()).toBe(0);
    });
  });

  describe('database guards', () => {
    it('rejects a raw hard DELETE on soft-deletable and never-deleted tables (trigger)', async () => {
      const product = await newProduct('RAW_2');

      await expect(
        prisma.$executeRaw`DELETE FROM commercial_products WHERE id = ${product.id}::uuid`,
      ).rejects.toThrow(/Hard deletes are not allowed/);

      await prisma.$executeRaw`
        INSERT INTO price_versions (product_id, amount_kobo, effective_from)
        VALUES (${product.id}::uuid, ${100}::bigint, NOW())
      `;
      await expect(prisma.$executeRaw`DELETE FROM price_versions`).rejects.toThrow(
        /Hard deletes are not allowed/,
      );

      await prisma.$executeRaw`INSERT INTO config_values (key, value_json) VALUES ('K', '1'::jsonb)`;
      await expect(prisma.$executeRaw`DELETE FROM config_values`).rejects.toThrow(
        /Hard deletes are not allowed/,
      );
    });

    it('price versions are immutable (insert a new version instead of updating)', async () => {
      const product = await newProduct('RAW_3');
      await prisma.$executeRaw`
        INSERT INTO price_versions (product_id, amount_kobo, effective_from)
        VALUES (${product.id}::uuid, ${100}::bigint, NOW())
      `;

      await expect(
        prisma.$executeRaw`UPDATE price_versions SET amount_kobo = 1`,
      ).rejects.toThrow(/immutable/);
    });

    it('allows plain deletes on transient tables (cleanup jobs)', async () => {
      await prisma.outboxEvent.create({ data: { eventType: 'test.event', payload: {} } });
      await prisma.idempotencyKey.create({
        data: {
          userId: '123e4567-e89b-12d3-a456-426614174000',
          operation: 'op',
          key: 'k1',
          requestHash: 'h',
        },
      });

      await expect(prisma.$executeRaw`DELETE FROM outbox_events`).resolves.toBe(1);
      await expect(prisma.$executeRaw`DELETE FROM idempotency_keys`).resolves.toBe(1);
    });
  });
});
