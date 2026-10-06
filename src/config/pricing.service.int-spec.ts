/**
 * Pricing service integration tests (P1-02)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../database/database.module.js';
import { PricingService } from './pricing.service.js';
import { getTestPrisma, cleanDatabase } from '../test/database.helper.js';
import { testConfigModule } from '../test/test-modules.js';

describe('PricingService (Integration)', () => {
  let service: PricingService;
  let module: TestingModule;
  const prisma = getTestPrisma();

  beforeEach(async () => {
    await cleanDatabase();

    module = await Test.createTestingModule({
      imports: [testConfigModule(), DatabaseModule],
      providers: [PricingService],
    }).compile();

    service = module.get<PricingService>(PricingService);
  });

  afterEach(async () => {
    await module?.close();
  });

  describe('getCurrentPrice()', () => {
    it('should return null when no prices exist', async () => {
      const productId = '00000000-0000-0000-0000-000000000001';
      const price = await service.getCurrentPrice(productId);
      expect(price).toBeNull();
    });

    it('should return current price ignoring future-dated prices', async () => {
      // Create product
      const product = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO commercial_products (code, name, type)
        VALUES ('TEST_PRODUCT', 'Test Product', 'RUNNER_PRO')
        RETURNING id
      `;

      const productId = product[0].id;
      const now = new Date();
      const future = new Date(now.getTime() + 86400000); // +1 day

      // Insert current price
      await prisma.$executeRaw`
        INSERT INTO price_versions (product_id, amount_kobo, effective_from)
        VALUES (${productId}::uuid, 100000, ${now})
      `;

      // Insert future price
      await prisma.$executeRaw`
        INSERT INTO price_versions (product_id, amount_kobo, effective_from)
        VALUES (${productId}::uuid, 150000, ${future})
      `;

      const price = await service.getCurrentPrice(productId);

      expect(price).not.toBeNull();
      expect(price!.amountKobo).toBe(100000n); // BigInt from database
    });

    it('should return most recent price when multiple past prices exist', async () => {
      const product = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO commercial_products (code, name, type)
        VALUES ('TEST_PRODUCT', 'Test Product', 'RUNNER_PRO')
        RETURNING id
      `;

      const productId = product[0].id;
      const day1 = new Date('2026-01-01');
      const day2 = new Date('2026-02-01');
      const day3 = new Date('2026-03-01');

      // Insert prices at different dates
      await prisma.$executeRaw`
        INSERT INTO price_versions (product_id, amount_kobo, effective_from)
        VALUES 
          (${productId}::uuid, 100000, ${day1}),
          (${productId}::uuid, 120000, ${day2}),
          (${productId}::uuid, 150000, ${day3})
      `;

      const price = await service.getCurrentPrice(productId);

      expect(price).not.toBeNull();
      expect(price!.amountKobo).toBe(150000n); // Most recent
    });
  });

  describe('getCurrentPriceByCode()', () => {
    it('should return price by product code', async () => {
      const product = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO commercial_products (code, name, type, active)
        VALUES ('RUNNER_PRO', 'Runner Pro', 'RUNNER_PRO', true)
        RETURNING id
      `;

      await prisma.$executeRaw`
        INSERT INTO price_versions (product_id, amount_kobo, effective_from)
        VALUES (${product[0].id}::uuid, 500000, NOW())
      `;

      const price = await service.getCurrentPriceByCode('RUNNER_PRO');

      expect(price).not.toBeNull();
      expect(price!.amountKobo).toBe(500000n);
    });

    it('should return null for inactive products', async () => {
      const product = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO commercial_products (code, name, type, active)
        VALUES ('INACTIVE_PRODUCT', 'Inactive', 'RUNNER_PRO', false)
        RETURNING id
      `;

      await prisma.$executeRaw`
        INSERT INTO price_versions (product_id, amount_kobo, effective_from)
        VALUES (${product[0].id}::uuid, 100000, NOW())
      `;

      const price = await service.getCurrentPriceByCode('INACTIVE_PRODUCT');
      expect(price).toBeNull();
    });
  });

  describe('getPriceAt()', () => {
    it('should return price that was effective at a specific date', async () => {
      const product = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO commercial_products (code, name, type)
        VALUES ('TEST_PRODUCT', 'Test Product', 'RUNNER_PRO')
        RETURNING id
      `;

      const productId = product[0].id;
      const jan1 = new Date('2026-01-01');
      const feb1 = new Date('2026-02-01');
      const mar1 = new Date('2026-03-01');

      // Insert prices
      await prisma.$executeRaw`
        INSERT INTO price_versions (product_id, amount_kobo, effective_from)
        VALUES 
          (${productId}::uuid, 100000, ${jan1}),
          (${productId}::uuid, 120000, ${feb1})
      `;

      // Query price on March 1 (should get Feb 1 price)
      const price = await service.getPriceAt(productId, mar1);

      expect(price).not.toBeNull();
      expect(price!.amountKobo).toBe(120000n);
    });

    it('should return null if querying before any price existed', async () => {
      const product = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO commercial_products (code, name, type)
        VALUES ('TEST_PRODUCT', 'Test Product', 'RUNNER_PRO')
        RETURNING id
      `;

      const productId = product[0].id;

      await prisma.$executeRaw`
        INSERT INTO price_versions (product_id, amount_kobo, effective_from)
        VALUES (${productId}::uuid, 100000, '2026-02-01'::date)
      `;

      // Query price on Jan 1 (before any price existed)
      const price = await service.getPriceAt(productId, new Date('2026-01-01'));
      expect(price).toBeNull();
    });
  });

  describe('getPriceHistory()', () => {
    it('should return all price versions ordered by date descending', async () => {
      const product = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO commercial_products (code, name, type)
        VALUES ('TEST_PRODUCT', 'Test Product', 'RUNNER_PRO')
        RETURNING id
      `;

      const productId = product[0].id;

      await prisma.$executeRaw`
        INSERT INTO price_versions (product_id, amount_kobo, effective_from)
        VALUES 
          (${productId}::uuid, 100000, '2026-01-01'::date),
          (${productId}::uuid, 120000, '2026-02-01'::date),
          (${productId}::uuid, 150000, '2026-03-01'::date)
      `;

      const history = await service.getPriceHistory(productId);

      expect(history).toHaveLength(3);
      expect(history[0].amountKobo).toBe(150000n); // Most recent first
      expect(history[1].amountKobo).toBe(120000n);
      expect(history[2].amountKobo).toBe(100000n);
    });

    it('should return empty array for product with no prices', async () => {
      const product = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO commercial_products (code, name, type)
        VALUES ('TEST_PRODUCT', 'Test Product', 'RUNNER_PRO')
        RETURNING id
      `;

      const history = await service.getPriceHistory(product[0].id);
      expect(history).toHaveLength(0);
    });
  });

  describe('createPriceVersion()', () => {
    it('should create a new price version', async () => {
      const product = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO commercial_products (code, name, type)
        VALUES ('TEST_PRODUCT', 'Test Product', 'RUNNER_PRO')
        RETURNING id
      `;

      const productId = product[0].id;
      const effectiveFrom = new Date('2026-01-01');

      const priceVersion = await service.createPriceVersion(
        productId,
        100000,
        effectiveFrom,
        'Launch price',
      );

      expect(priceVersion).toBeDefined();
      expect(priceVersion.productId).toBe(productId);
      expect(priceVersion.amountKobo).toBe(100000n);
      expect(priceVersion.notes).toBe('Launch price');
    });

    it('should record admin ID when provided', async () => {
      const product = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO commercial_products (code, name, type)
        VALUES ('TEST_PRODUCT', 'Test Product', 'RUNNER_PRO')
        RETURNING id
      `;

      const adminId = '00000000-0000-0000-0000-000000000001';

      const priceVersion = await service.createPriceVersion(
        product[0].id,
        100000,
        new Date(),
        'Admin update',
        adminId,
      );

      expect(priceVersion.createdByAdminId).toBe(adminId);
    });
  });

  describe('getActiveProducts()', () => {
    it('should return active products with current prices', async () => {
      // Create products
      const product1 = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO commercial_products (code, name, type, active)
        VALUES ('RUNNER_PRO', 'Runner Pro', 'RUNNER_PRO', true)
        RETURNING id
      `;

      const product2 = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO commercial_products (code, name, type, active)
        VALUES ('PRIORITY_BOOST', 'Priority Boost', 'PRIORITY_BOOST', true)
        RETURNING id
      `;

      // Add prices
      await prisma.$executeRaw`
        INSERT INTO price_versions (product_id, amount_kobo, effective_from)
        VALUES 
          (${product1[0].id}::uuid, 500000, '2026-01-01'::date),
          (${product2[0].id}::uuid, 100000, '2026-01-01'::date)
      `;

      const products = await service.getActiveProducts();

      expect(products).toHaveLength(2);
      expect(products[0].currentPrice).toBeDefined();
      expect(products[1].currentPrice).toBeDefined();
    });

    it('should not return inactive products', async () => {
      await prisma.$executeRaw`
        INSERT INTO commercial_products (code, name, type, active)
        VALUES 
          ('ACTIVE', 'Active Product', 'RUNNER_PRO', true),
          ('INACTIVE', 'Inactive Product', 'RUNNER_PRO', false)
      `;

      const products = await service.getActiveProducts();

      expect(products).toHaveLength(1);
      expect(products[0].code).toBe('ACTIVE');
    });
  });
});
