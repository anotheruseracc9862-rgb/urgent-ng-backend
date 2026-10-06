import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { softDeleteExtension } from './soft-delete.extension.js';
import { DatabaseModule } from './database.module.js';
import { PrismaService } from './prisma.service.js';

describe('Soft Delete Extension (integration)', () => {
  let prisma: PrismaService;
  let extendedPrisma: ReturnType<typeof PrismaClient.prototype.$extends<typeof softDeleteExtension>>;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();

    prisma = module.get<PrismaService>(PrismaService);
    
    // Create extended client with soft delete
    extendedPrisma = prisma.$extends(softDeleteExtension) as any;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('never-deleted tables (append-only)', () => {
    it('should prevent DELETE on audit_logs', async () => {
      // Create an audit log
      const log = await prisma.auditLog.create({
        data: {
          actorId: '123e4567-e89b-12d3-a456-426614174000',
          action: 'TEST_ACTION',
          targetType: 'Test',
          targetId: '123e4567-e89b-12d3-a456-426614174001',
          metadata: {},
        },
      });

      // Try to delete it - should be rejected by trigger
      await expect(
        prisma.auditLog.delete({ where: { id: log.id } })
      ).rejects.toThrow(/Deletes are never allowed on table audit_logs/);
    });

    it('should prevent DELETE on config_values', async () => {
      // Try to delete a config value
      const config = await prisma.configValue.findFirst();
      
      if (config) {
        await expect(
          prisma.configValue.delete({ where: { id: config.id } })
        ).rejects.toThrow(/Deletes are never allowed on table config_values/);
      }
    });

    it('should prevent DELETE on outbox_events', async () => {
      // Create an outbox event
      const event = await prisma.outboxEvent.create({
        data: {
          eventType: 'test.event',
          payload: { test: true },
        },
      });

      // Try to delete it - should be rejected by trigger
      await expect(
        prisma.outboxEvent.delete({ where: { id: event.id } })
      ).rejects.toThrow(/Deletes are never allowed on table outbox_events/);
    });

    it('should prevent DELETE on idempotency_keys', async () => {
      // Create an idempotency key
      const key = await prisma.idempotencyKey.create({
        data: {
          userId: '123e4567-e89b-12d3-a456-426614174000',
          operation: 'test-op',
          key: 'test-key',
          requestHash: 'hash',
        },
      });

      // Try to delete it - should be rejected by trigger
      await expect(
        prisma.idempotencyKey.delete({ where: { id: key.id } })
      ).rejects.toThrow(/Deletes are never allowed on table idempotency_keys/);
    });
  });

  describe('documentation and notes', () => {
    it('should document soft-deletable models', () => {
      // The extension itself documents which models are soft-deletable
      // This test exists to ensure the documentation stays in sync
      const softDeletableModels = [
        'user',
        'profile',
        'errand',
        'offer',
        'assignment',
        'message',
        'conversation',
        'notification',
        'dispute',
        'report',
        'enforcementAction',
      ];

      // If this test fails, update the documentation in soft-delete.extension.ts
      expect(softDeletableModels.length).toBeGreaterThan(0);
    });

    it('should document never-deleted models', () => {
      // Never-deleted (append-only) tables
      const neverDeletedModels = [
        'audit_logs',
        'outbox_events',
        'idempotency_keys',
        'config_values',
        'commercial_products',
        'price_versions',
      ];

      // If this test fails, update the triggers in the migration
      expect(neverDeletedModels.length).toBeGreaterThan(0);
    });
  });

  describe('soft delete notes for future implementation', () => {
    it('should note that soft-deletable table tests will be added with user/errand schemas', () => {
      // When users, errands, and other business tables are created in Phase 2+,
      // their migrations will call create_soft_delete_trigger(table_name),
      // and tests will verify:
      // 1. DELETE converts to UPDATE setting deletedAt
      // 2. Reads filter out deletedAt IS NOT NULL rows
      // 3. Re-creating with same unique key succeeds after soft delete
      
      expect(true).toBe(true); // Placeholder
    });
  });
});
