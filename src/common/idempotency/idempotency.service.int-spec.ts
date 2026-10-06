import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { IdempotencyService, IdempotencyConflictError } from './idempotency.service.js';
import { DatabaseModule } from '../../database/database.module.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '@prisma/client';
import { cleanDatabase } from '../../test/database.helper.js';
import { testConfigModule } from '../../test/test-modules.js';

describe('IdempotencyService (integration)', () => {
  let service: IdempotencyService;
  let prisma: PrismaService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [testConfigModule(), DatabaseModule],
      providers: [IdempotencyService],
    }).compile();

    service = module.get<IdempotencyService>(IdempotencyService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  beforeEach(async () => {
    // Clean up idempotency keys
    await cleanDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('store and check', () => {
    it('should store a new idempotency key', async () => {
      const userId = '123e4567-e89b-12d3-a456-426614174000';
      const operation = 'test-operation';
      const key = 'test-key-001';
      const requestBody = { action: 'create', item: 'test' };

      const stored = await service.store(userId, operation, key, requestBody);

      expect(stored).toBe(true);

      const record = await prisma.idempotencyKey.findUnique({
        where: {
          userId_operation_key: {
            userId,
            operation,
            key,
          },
        },
      });

      expect(record).toBeDefined();
      expect(record!.userId).toBe(userId);
      expect(record!.operation).toBe(operation);
      expect(record!.key).toBe(key);
      expect(record!.responseStatus).toBeNull();
      expect(record!.responseBody).toBeNull();
    });

    it('should return false on duplicate idempotency key', async () => {
      const userId = '123e4567-e89b-12d3-a456-426614174000';
      const operation = 'test-operation';
      const key = 'test-key-002';
      const requestBody = { action: 'create' };

      await service.store(userId, operation, key, requestBody);

      const stored = await service.store(userId, operation, key, requestBody);

      expect(stored).toBe(false);
    });

    it('should check and return null for non-existent key', async () => {
      const result = await service.check(
        '123e4567-e89b-12d3-a456-426614174000',
        'test-operation',
        'non-existent-key',
        { action: 'test' },
      );

      expect(result).toBeNull();
    });

    it('should check and return existing key without response', async () => {
      const userId = '123e4567-e89b-12d3-a456-426614174000';
      const operation = 'test-operation';
      const key = 'test-key-003';
      const requestBody = { action: 'create' };

      await service.store(userId, operation, key, requestBody);

      const result = await service.check(userId, operation, key, requestBody);

      expect(result).toBeDefined();
      expect(result!.responseStatus).toBeNull();
      expect(result!.responseBody).toBeNull();
    });

    it('should check and return existing key with response', async () => {
      const userId = '123e4567-e89b-12d3-a456-426614174000';
      const operation = 'test-operation';
      const key = 'test-key-004';
      const requestBody = { action: 'create' };
      const responseBody = { success: true, data: { id: 'abc123' } };

      await service.store(userId, operation, key, requestBody);
      await service.updateResponse(userId, operation, key, 201, responseBody);

      const result = await service.check(userId, operation, key, requestBody);

      expect(result).toBeDefined();
      expect(result!.responseStatus).toBe(201);
      expect(result!.responseBody).toEqual(responseBody);
    });

    it('should throw IdempotencyConflictError when request body differs', async () => {
      const userId = '123e4567-e89b-12d3-a456-426614174000';
      const operation = 'test-operation';
      const key = 'test-key-005';
      const originalBody = { action: 'create', item: 'original' };
      const differentBody = { action: 'create', item: 'different' };

      await service.store(userId, operation, key, originalBody);

      await expect(
        service.check(userId, operation, key, differentBody),
      ).rejects.toThrow(IdempotencyConflictError);
    });
  });

  describe('updateResponse', () => {
    it('should update response for existing key', async () => {
      const userId = '123e4567-e89b-12d3-a456-426614174000';
      const operation = 'test-operation';
      const key = 'test-key-006';
      const requestBody = { action: 'create' };
      const responseBody = { success: true, errandId: 'e123' };

      await service.store(userId, operation, key, requestBody);
      await service.updateResponse(userId, operation, key, 200, responseBody);

      const record = await prisma.idempotencyKey.findUnique({
        where: {
          userId_operation_key: {
            userId,
            operation,
            key,
          },
        },
      });

      expect(record!.responseStatus).toBe(200);
      expect(record!.responseBody).toEqual(responseBody);
    });

    it('should throw when updating non-existent key', async () => {
      await expect(
        service.updateResponse(
          '123e4567-e89b-12d3-a456-426614174000',
          'test-operation',
          'non-existent',
          200,
          {},
        ),
      ).rejects.toThrow();
    });
  });

  describe('cleanup', () => {
    it('should delete old idempotency keys', async () => {
      const userId = '123e4567-e89b-12d3-a456-426614174000';
      const operation = 'test-operation';

      // Create a key from 25 hours ago
      const oldKey = 'old-key';
      const oldCreatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await prisma.idempotencyKey.create({
        data: {
          userId,
          operation,
          key: oldKey,
          requestHash: 'hash1',
          responseStatus: null,
          responseBody: Prisma.DbNull,
          createdAt: oldCreatedAt,
        },
      });

      // Create a key from 1 hour ago
      const recentKey = 'recent-key';
      const recentCreatedAt = new Date(Date.now() - 1 * 60 * 60 * 1000);
      await prisma.idempotencyKey.create({
        data: {
          userId,
          operation,
          key: recentKey,
          requestHash: 'hash2',
          responseStatus: null,
          responseBody: Prisma.DbNull,
          createdAt: recentCreatedAt,
        },
      });

      const deletedCount = await service.cleanup(24);

      expect(deletedCount).toBe(1);

      // Verify old key is gone
      const oldRecord = await prisma.idempotencyKey.findUnique({
        where: {
          userId_operation_key: {
            userId,
            operation,
            key: oldKey,
          },
        },
      });
      expect(oldRecord).toBeNull();

      // Verify recent key still exists
      const recentRecord = await prisma.idempotencyKey.findUnique({
        where: {
          userId_operation_key: {
            userId,
            operation,
            key: recentKey,
          },
        },
      });
      expect(recentRecord).toBeDefined();
    });

    it('should return 0 when no keys are old enough', async () => {
      const userId = '123e4567-e89b-12d3-a456-426614174000';
      const operation = 'test-operation';
      const key = 'recent-key';
      const requestBody = { action: 'test' };

      await service.store(userId, operation, key, requestBody);

      const deletedCount = await service.cleanup(24);

      expect(deletedCount).toBe(0);
    });
  });

  describe('different users and operations', () => {
    it('should isolate keys by userId', async () => {
      const user1 = '123e4567-e89b-12d3-a456-426614174000';
      const user2 = '223e4567-e89b-12d3-a456-426614174000';
      const operation = 'test-operation';
      const key = 'shared-key';
      const requestBody = { action: 'create' };

      // Same operation and key, different users
      await service.store(user1, operation, key, requestBody);
      await service.store(user2, operation, key, requestBody);

      const result1 = await service.check(user1, operation, key, requestBody);
      const result2 = await service.check(user2, operation, key, requestBody);

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
    });

    it('should isolate keys by operation', async () => {
      const userId = '123e4567-e89b-12d3-a456-426614174000';
      const operation1 = 'create-errand';
      const operation2 = 'cancel-errand';
      const key = 'shared-key';
      const requestBody = { action: 'test' };

      // Same user and key, different operations
      await service.store(userId, operation1, key, requestBody);
      await service.store(userId, operation2, key, requestBody);

      const result1 = await service.check(userId, operation1, key, requestBody);
      const result2 = await service.check(userId, operation2, key, requestBody);

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
    });
  });

  describe('request hashing', () => {
    const userId = '123e4567-e89b-12d3-a456-426614174000';

    it('treats key order as irrelevant at every depth', async () => {
      await service.store(userId, 'op', 'key-order-1', { a: 1, nested: { x: 1, y: 2 } });

      await expect(
        service.check(userId, 'op', 'key-order-1', { nested: { y: 2, x: 1 }, a: 1 }),
      ).resolves.not.toBeNull();
    });

    it('detects a change in a NESTED value (old replacer-array bug)', async () => {
      await service.store(userId, 'op', 'key-nested-1', { payment: { amount: 100 } });

      await expect(
        service.check(userId, 'op', 'key-nested-1', { payment: { amount: 999999 } }),
      ).rejects.toThrow(IdempotencyConflictError);
    });

    it('detects a change inside an array', async () => {
      await service.store(userId, 'op', 'key-array-1', { items: [{ id: 1 }] });

      await expect(
        service.check(userId, 'op', 'key-array-1', { items: [{ id: 2 }] }),
      ).rejects.toThrow(IdempotencyConflictError);
    });
  });

  describe('failure handling', () => {
    const userId = '123e4567-e89b-12d3-a456-426614174000';
    const body = { action: 'create' };

    it('marks an in-flight key as failed and lets the same body claim it again', async () => {
      await service.store(userId, 'op', 'fail-1', body);
      await service.markFailed(userId, 'op', 'fail-1');

      const failed = await service.check(userId, 'op', 'fail-1', body);
      expect(failed?.failed).toBe(true);

      expect(await service.store(userId, 'op', 'fail-1', body)).toBe(true);
      const reclaimed = await service.check(userId, 'op', 'fail-1', body);
      expect(reclaimed?.failed).toBe(false);
    });

    it('does not let a different body claim a failed key', async () => {
      await service.store(userId, 'op', 'fail-2', body);
      await service.markFailed(userId, 'op', 'fail-2');

      expect(await service.store(userId, 'op', 'fail-2', { action: 'other' })).toBe(false);
    });

    it('lets exactly one of several concurrent retries claim a failed key', async () => {
      await service.store(userId, 'op', 'fail-3', body);
      await service.markFailed(userId, 'op', 'fail-3');

      const results = await Promise.all(
        [1, 2, 3, 4].map(() => service.store(userId, 'op', 'fail-3', body)),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('leaves a completed key untouched when markFailed is called', async () => {
      await service.store(userId, 'op', 'done-1', body);
      await service.updateResponse(userId, 'op', 'done-1', 201, { ok: true });
      await service.markFailed(userId, 'op', 'done-1');

      const result = await service.check(userId, 'op', 'done-1', body);
      expect(result?.responseStatus).toBe(201);
      expect(result?.failed).toBe(false);
    });

    it('does not claim a completed key', async () => {
      await service.store(userId, 'op', 'done-2', body);
      await service.updateResponse(userId, 'op', 'done-2', 201, { ok: true });

      expect(await service.store(userId, 'op', 'done-2', body)).toBe(false);
    });
  });
});
