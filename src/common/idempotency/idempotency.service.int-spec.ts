import { Test, TestingModule } from '@nestjs/testing';
import { IdempotencyService, IdempotencyConflictError } from './idempotency.service.js';
import { DatabaseModule } from '../../database/database.module.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '@prisma/client';

describe('IdempotencyService (integration)', () => {
  let service: IdempotencyService;
  let prisma: PrismaService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [IdempotencyService],
    }).compile();

    service = module.get<IdempotencyService>(IdempotencyService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  beforeEach(async () => {
    // Clean up idempotency keys
    await prisma.idempotencyKey.deleteMany({});
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
      expect(record!.responseBody).toEqual(Prisma.DbNull);
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
      expect(result!.responseBody).toEqual(Prisma.DbNull);
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
});
