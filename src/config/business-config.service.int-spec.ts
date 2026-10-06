/**
 * Business config service integration tests (P1-02)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../database/database.module.js';
import { RedisModule, REDIS_CLIENT } from '../common/redis/redis.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { BusinessConfigService } from './business-config.service.js';
import {
  getTestPrisma,
  cleanAll,
} from '../test/database.helper.js';
import { testConfigModule } from '../test/test-modules.js';

describe('BusinessConfigService (Integration)', () => {
  let service: BusinessConfigService;
  let module: TestingModule;
  const prisma = getTestPrisma();

  async function build(overrideRedis?: unknown): Promise<void> {
    const builder = Test.createTestingModule({
      imports: [testConfigModule(), RedisModule, DatabaseModule, AuditModule],
      providers: [BusinessConfigService],
    });
    if (overrideRedis) {
      builder.overrideProvider(REDIS_CLIENT).useValue(overrideRedis);
    }
    module = await builder.compile();
    service = module.get(BusinessConfigService);
  }

  beforeEach(async () => {
    await cleanAll();
    await build();
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
        INSERT INTO config_values (key, value_json, version, effective_from)
        VALUES ('OFFER_MIN_AMOUNT', '25000'::jsonb, 2, ${future})
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

  describe('resilience and validation', () => {
    const fail = () => Promise.reject(new Error('Redis is down'));
    const downRedis = { get: fail, mget: fail, setex: fail, del: fail, ping: fail, disconnect: () => undefined };

    it('falls back to PostgreSQL when Redis is down (get, set, getAll)', async () => {
      await module.close();
      await build(downRedis);

      await service.set('ERRAND_EXPIRY_HOURS', 36);

      expect(await service.get('ERRAND_EXPIRY_HOURS')).toBe(36);
      expect((await service.getAll()).ERRAND_EXPIRY_HOURS).toBe(36);
    });

    it('rejects a value of the wrong type', async () => {
      await expect(
        service.set('ERRAND_EXPIRY_HOURS', 'soon' as unknown as number),
      ).rejects.toThrow(/expects a number/);
      await expect(
        service.set('FEATURE_OFFERS_ENABLED', 'false' as unknown as boolean),
      ).rejects.toThrow(/expects a boolean/);
    });

    it('ignores a stored value of the wrong type and uses the default', async () => {
      await prisma.$executeRaw`
        INSERT INTO config_values (key, value_json) VALUES ('ERRAND_EXPIRY_HOURS', '"soon"'::jsonb)
      `;

      expect(await service.get('ERRAND_EXPIRY_HOURS')).toBe(24);
    });

    it('ignores soft-deleted versions', async () => {
      await service.set('ERRAND_EXPIRY_HOURS', 48);
      await prisma.$executeRaw`UPDATE config_values SET deleted_at = NOW() WHERE key = 'ERRAND_EXPIRY_HOURS'`;
      await service.invalidate('ERRAND_EXPIRY_HOURS');

      expect(await service.get('ERRAND_EXPIRY_HOURS')).toBe(24);
    });

    it('rejects two versions of one key with the same effective time', async () => {
      const at = new Date(Date.now() - 1000);
      await service.set('OFFER_MIN_AMOUNT', 21000, at);

      await expect(service.set('OFFER_MIN_AMOUNT', 22000, at)).rejects.toThrow();
    });

    it('gives concurrent writers of one key distinct versions', async () => {
      await Promise.all(
        [1, 2, 3, 4, 5].map((n) => service.set('MAX_OPEN_OFFERS_PER_RUNNER', 10 + n)),
      );

      const rows = await prisma.$queryRaw<Array<{ version: number }>>`
        SELECT version FROM config_values WHERE key = 'MAX_OPEN_OFFERS_PER_RUNNER' ORDER BY version
      `;
      expect(rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
    });

    it('audits every change', async () => {
      const adminId = '00000000-0000-0000-0000-000000000009';
      await service.set('VAT_RATE', 10, new Date(), adminId);

      const logs = await prisma.auditLog.findMany({ where: { action: 'config.set' } });
      expect(logs).toHaveLength(1);
      expect(logs[0].actorType).toBe('ADMIN');
      expect(logs[0].actorId).toBe(adminId);
      expect(logs[0].entityType).toBe('config_value');
      expect(logs[0].metadata).toMatchObject({ key: 'VAT_RATE' });
      expect(logs[0].afterHash).toBeTruthy();
    });

    it('does not leave a config row when the audit write fails', async () => {
      // an invalid actor id (not a uuid) makes the audit insert fail inside the transaction
      await expect(
        service.set('VAT_RATE', 12, new Date(), 'not-a-uuid'),
      ).rejects.toThrow();

      const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*) AS n FROM config_values WHERE key = 'VAT_RATE'
      `;
      expect(Number(rows[0].n)).toBe(0);
    });
  });
});
