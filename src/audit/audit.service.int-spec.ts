/**
 * Audit service integration tests (P1-03)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../database/database.module.js';
import { AuditService } from './audit.service.js';
import {
  getTestPrisma,
  cleanDatabase,
} from '../test/database.helper.js';
import { testConfigModule } from '../test/test-modules.js';
import { AuditActorType } from '@prisma/client';

describe('AuditService (Integration)', () => {
  let service: AuditService;
  let module: TestingModule;
  const prisma = getTestPrisma();

  beforeEach(async () => {
    await cleanDatabase();

    module = await Test.createTestingModule({
      imports: [testConfigModule(), DatabaseModule],
      providers: [AuditService],
    }).compile();

    service = module.get<AuditService>(AuditService);
  });

  afterEach(async () => {
    await module?.close();
  });

  describe('record()', () => {
    it('should create an audit log entry', async () => {
      const actorId = '00000000-0000-0000-0000-000000000001';
      const entityId = '00000000-0000-0000-0000-000000000002';

      await service.record({
        actorType: AuditActorType.USER,
        actorId,
        action: 'USER_LOGIN',
        entityType: 'User',
        entityId,
        requestId: 'req-123',
        ip: '192.168.1.1',
      });

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].actorType).toBe(AuditActorType.USER);
      expect(logs[0].actorId).toBe(actorId);
      expect(logs[0].action).toBe('USER_LOGIN');
      expect(logs[0].entityType).toBe('User');
      expect(logs[0].entityId).toBe(entityId);
      expect(logs[0].requestId).toBe('req-123');
      expect(logs[0].ip).toBe('192.168.1.1');
    });

    it('should hash before and after snapshots', async () => {
      const before = { status: 'DRAFT', amount: 1000 };
      const after = { status: 'OPEN', amount: 1000 };

      await service.record({
        actorType: AuditActorType.USER,
        action: 'ERRAND_PUBLISHED',
        before,
        after,
      });

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].beforeHash).toBeDefined();
      expect(logs[0].afterHash).toBeDefined();
      expect(logs[0].beforeHash).not.toBe(logs[0].afterHash);
    });

    it('should handle SYSTEM actor type without actorId', async () => {
      await service.record({
        actorType: AuditActorType.SYSTEM,
        action: 'ERRAND_EXPIRED',
        entityType: 'Errand',
        entityId: '00000000-0000-0000-0000-000000000001',
      });

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].actorType).toBe(AuditActorType.SYSTEM);
      expect(logs[0].actorId).toBeNull();
    });

    it('should store metadata as JSON', async () => {
      const metadata = {
        ipCountry: 'NG',
        userAgent: 'Mozilla/5.0',
        attemptCount: 3,
      };

      await service.record({
        actorType: AuditActorType.USER,
        action: 'LOGIN_FAILED',
        metadata,
      });

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].metadata).toEqual(metadata);
    });

    it('should record admin actions with reason code', async () => {
      await service.record({
        actorType: AuditActorType.ADMIN,
        actorId: '00000000-0000-0000-0000-000000000001',
        action: 'USER_SUSPENDED',
        entityType: 'User',
        entityId: '00000000-0000-0000-0000-000000000002',
        reasonCode: 'FRAUD_SUSPECTED',
        metadata: { caseId: 'CASE-123' },
      });

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].actorType).toBe(AuditActorType.ADMIN);
      expect(logs[0].reasonCode).toBe('FRAUD_SUSPECTED');
      expect(logs[0].metadata).toEqual({ caseId: 'CASE-123' });
    });
  });

  describe('recordInTransaction()', () => {
    it('should record audit log within a transaction', async () => {
      await prisma.$transaction(async (tx) => {
        await service.recordInTransaction(tx, {
          actorType: AuditActorType.USER,
          action: 'CONFIG_CHANGED',
          entityType: 'ConfigValue',
          entityId: '00000000-0000-0000-0000-000000000001',
        });
      });

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe('CONFIG_CHANGED');
    });

    it('should roll back audit log if transaction fails', async () => {
      try {
        await prisma.$transaction(async (tx) => {
          await service.recordInTransaction(tx, {
            actorType: AuditActorType.USER,
            action: 'PAYMENT_PROCESSED',
          });

          // Force transaction to fail
          throw new Error('Transaction failed');
        });
      } catch {
        // Expected
      }

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(0);
    });
  });

  describe('snapshot hashes', () => {
    it('is stable for the same snapshot regardless of key order', async () => {
      await service.record({
        actorType: AuditActorType.USER,
        action: 'A',
        after: { a: 1, nested: { x: 1, y: 2 } },
      });
      await service.record({
        actorType: AuditActorType.USER,
        action: 'B',
        after: { nested: { y: 2, x: 1 }, a: 1 },
      });

      const logs = await prisma.auditLog.findMany({ orderBy: { action: 'asc' } });
      expect(logs[0].afterHash).toBe(logs[1].afterHash);
    });

    it('changes when a NESTED value changes', async () => {
      await service.record({
        actorType: AuditActorType.ADMIN,
        action: 'A',
        before: { price: { amount: 100 } },
        after: { price: { amount: 999999 } },
      });

      const [log] = await prisma.auditLog.findMany();
      expect(log.beforeHash).not.toBe(log.afterHash);
    });
  });

  describe('append-only enforcement', () => {
    async function createLog(): Promise<string> {
      await service.record({ actorType: AuditActorType.USER, action: 'TEST_ACTION' });
      const [log] = await prisma.auditLog.findMany();
      return log.id;
    }

    it('rejects UPDATE on audit_logs (trigger)', async () => {
      const id = await createLog();

      await expect(
        prisma.$executeRaw`UPDATE audit_logs SET action = 'MODIFIED' WHERE id = ${id}::uuid`,
      ).rejects.toThrow(/append-only/i);
    });

    it('rejects DELETE on audit_logs (trigger)', async () => {
      const id = await createLog();

      await expect(
        prisma.$executeRaw`DELETE FROM audit_logs WHERE id = ${id}::uuid`,
      ).rejects.toThrow(/append-only|Hard deletes are not allowed/i);
    });

    it('allows INSERT (append) operations', async () => {
      await service.record({ actorType: AuditActorType.USER, action: 'FIRST_ACTION' });
      await service.record({ actorType: AuditActorType.USER, action: 'SECOND_ACTION' });

      const logs = await prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });

      expect(logs).toHaveLength(2);
      expect(logs[0].action).toBe('FIRST_ACTION');
      expect(logs[1].action).toBe('SECOND_ACTION');
    });
  });
});
