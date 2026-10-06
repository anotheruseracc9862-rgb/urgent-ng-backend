/**
 * Business config service integration tests (P1-02)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module.js';
import { BusinessConfigService } from './business-config.service.js';
import { getTestPrisma, cleanDatabase } from '../test/database.helper.js';
import { Redis } from 'ioredis';

describe('BusinessConfigService (Integration)', () => {
  let service: BusinessConfigService;
  let module: TestingModule;
  const prisma = getTestPrisma();

  beforeEach(async () => {
    await cleanDatabase();

    // Also clear Redis config cache
    const redis = new Redis({
      host: 'localhost',
      port: 6399,
      db: 0,
    });
    await redis.flushdb();
    await redis.quit();

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        DatabaseModule,
      ],
      providers: [BusinessConfigService],
    }).compile();

    service = module.get<BusinessConfigService>(BusinessConfigService);
    await service.onModuleInit();
  });

  afterEach(async () => {
    await module?.close();
  });

  describe('get()', () => {
    it('should return default value when no database record exists', async () => {
      const value = await service.get('ERRAND_EXPIRY_HOURS');
      expect(value).toBe(24); // Default value
    });

    it('should return database value when record exists', async () => {
      // Insert a config value
      await prisma.$executeRaw`
        INSERT INTO config_values (key, value_json, effective_from)
        VALUES ('ERRAND_EXPIRY_HOURS', '48'::jsonb, NOW())
      `;

      const value = await service.get('ERRAND_EXPIRY_HOURS');
      expect(value).toBe(48);
    });

    it('should return current effective value, not future-dated', async () => {
      const now = new Date();
      const future = new Date(now.getTime() + 86400000); // +1 day

      // Insert current value
      await prisma.$executeRaw`
        INSERT INTO config_values (key, value_json, effective_from)
        VALUES ('OFFER_MIN_AMOUNT', '20000'::jsonb, ${now})
      `;

      // Insert future value
      await prisma.$executeRaw`
        INSERT INTO config_values (key, value_json, effective_from)
        VALUES ('OFFER_MIN_AMOUNT', '25000'::jsonb, ${future})
      `;

      const value = await service.get('OFFER_MIN_AMOUNT');
      expect(value).toBe(20000); // Should get current, not future
    });

    it('should cache values for 60 seconds', async () => {
      await prisma.$executeRaw`
        INSERT INTO config_values (key, value_json, effective_from)
        VALUES ('MAX_OPEN_OFFERS_PER_RUNNER', '20'::jsonb, NOW())
      `;

      // First read
      const value1 = await service.get('MAX_OPEN_OFFERS_PER_RUNNER');
      expect(value1).toBe(20);

      // Change database value
      await prisma.$executeRaw`
        UPDATE config_values 
        SET value_json = '30'::jsonb 
        WHERE key = 'MAX_OPEN_OFFERS_PER_RUNNER'
      `;

      // Second read should still return cached value
      const value2 = await service.get('MAX_OPEN_OFFERS_PER_RUNNER');
      expect(value2).toBe(20); // Still cached
    });

    it('should handle boolean kill switches', async () => {
      await prisma.$executeRaw`
        INSERT INTO config_values (key, value_json, effective_from)
        VALUES ('FEATURE_REGISTRATIONS_ENABLED', 'false'::jsonb, NOW())
      `;

      const value = await service.get('FEATURE_REGISTRATIONS_ENABLED');
      expect(value).toBe(false);
    });

    it('should handle decimal VAT_RATE', async () => {
      await prisma.$executeRaw`
        INSERT INTO config_values (key, value_json, effective_from)
        VALUES ('VAT_RATE', '7.5'::jsonb, NOW())
      `;

      const value = await service.get('VAT_RATE');
      expect(value).toBe(7.5);
    });
  });

  describe('set()', () => {
    it('should set a new config value', async () => {
      await service.set('ERRAND_EXPIRY_HOURS', 48);

      const value = await service.get('ERRAND_EXPIRY_HOURS');
      expect(value).toBe(48);
    });

    it('should increment version on each update', async () => {
      await service.set('OFFER_MIN_AMOUNT', 20000);
      await service.set('OFFER_MIN_AMOUNT', 25000);
      await service.set('OFFER_MIN_AMOUNT', 30000);

      const versions = await prisma.$queryRaw<Array<{ version: number }>>`
        SELECT version FROM config_values 
        WHERE key = 'OFFER_MIN_AMOUNT' 
        ORDER BY version
      `;

      expect(versions).toHaveLength(3);
      expect(versions[0].version).toBe(1);
      expect(versions[1].version).toBe(2);
      expect(versions[2].version).toBe(3);
    });

    it('should support future-dated config changes', async () => {
      const now = new Date('2026-10-01T12:00:00Z'); // Past date
      const future = new Date('2026-12-01T12:00:00Z'); // Future date

      await service.set('RUNNER_PRO_PRICE', 500000, now);
      await service.set('RUNNER_PRO_PRICE', 600000, future);

      // Current price should still be 500000
      const currentPrice = await service.get('RUNNER_PRO_PRICE');
      expect(currentPrice).toBe(500000);

      // Future record exists
      const futureRecord = await prisma.$queryRaw<Array<{ amount: number }>>`
        SELECT value_json::int as amount
        FROM config_values
        WHERE key = 'RUNNER_PRO_PRICE'
          AND effective_from > NOW()
      `;

      expect(futureRecord).toHaveLength(1);
      expect(futureRecord[0].amount).toBe(600000);
    });

    it('should invalidate cache on write', async () => {
      // Set initial value
      await service.set('MAX_OPEN_OFFERS_PER_RUNNER', 20);
      
      // Read to populate cache
      const value1 = await service.get('MAX_OPEN_OFFERS_PER_RUNNER');
      expect(value1).toBe(20);

      // Update value (should invalidate cache)
      await service.set('MAX_OPEN_OFFERS_PER_RUNNER', 30);

      // Should immediately see new value
      const value2 = await service.get('MAX_OPEN_OFFERS_PER_RUNNER');
      expect(value2).toBe(30);
    });

    it('should record admin ID when provided', async () => {
      const adminId = '00000000-0000-0000-0000-000000000001';

      await service.set('ERRAND_EXPIRY_HOURS', 48, new Date(), adminId);

      const record = await prisma.$queryRaw<Array<{ updated_by_admin_id: string | null }>>`
        SELECT updated_by_admin_id
        FROM config_values
        WHERE key = 'ERRAND_EXPIRY_HOURS'
      `;

      expect(record[0].updated_by_admin_id).toBe(adminId);
    });
  });

  describe('getAll()', () => {
    it('should return all config values with defaults', async () => {
      const config = await service.getAll();

      expect(config.ERRAND_EXPIRY_HOURS).toBe(24);
      expect(config.OFFER_MIN_AMOUNT).toBe(20000);
      expect(config.VAT_RATE).toBe(7.5);
      expect(config.FEATURE_REGISTRATIONS_ENABLED).toBe(true);
    });

    it('should include database overrides in getAll', async () => {
      await service.set('ERRAND_EXPIRY_HOURS', 48);
      await service.set('OFFER_MIN_AMOUNT', 25000);

      const config = await service.getAll();

      expect(config.ERRAND_EXPIRY_HOURS).toBe(48);
      expect(config.OFFER_MIN_AMOUNT).toBe(25000);
    });
  });

  describe('cache expiry', () => {
    it('should refresh cached value after 60 seconds', async () => {
      await prisma.$executeRaw`
        INSERT INTO config_values (key, value_json, effective_from)
        VALUES ('RATING_SCALE_MAX', '5'::jsonb, NOW())
      `;

      // First read (populates cache)
      const value1 = await service.get('RATING_SCALE_MAX');
      expect(value1).toBe(5);

      // Manually invalidate to simulate cache expiry
      await service.invalidate('RATING_SCALE_MAX');

      // Change database value
      await prisma.$executeRaw`
        UPDATE config_values 
        SET value_json = '10'::jsonb 
        WHERE key = 'RATING_SCALE_MAX'
      `;

      // Should see new value after cache clear
      const value2 = await service.get('RATING_SCALE_MAX');
      expect(value2).toBe(10);
    });
  });
});
