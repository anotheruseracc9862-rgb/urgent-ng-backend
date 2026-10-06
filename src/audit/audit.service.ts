/**
 * Audit service (P1-03)
 * Appends audit log entries for compliance and security tracking
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { AuditActorType, Prisma } from '@prisma/client';
import { createHmac } from 'crypto';

export interface RecordAuditInput {
  actorType: AuditActorType;
  actorId?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  requestId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reasonCode?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record an audit log entry
   * Can be called with or without an existing transaction
   */
  async record(input: RecordAuditInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorType: input.actorType,
        actorId: input.actorId || null,
        action: input.action,
        entityType: input.entityType || null,
        entityId: input.entityId || null,
        requestId: input.requestId || null,
        beforeHash: input.before ? this.hashSnapshot(input.before) : null,
        afterHash: input.after ? this.hashSnapshot(input.after) : null,
        reasonCode: input.reasonCode || null,
        metadata: input.metadata ? (input.metadata as Prisma.JsonObject) : Prisma.DbNull,
        ip: input.ip || null,
      },
    });
  }

  /**
   * Record an audit log entry within an existing transaction
   * Use this when the audit must be atomic with business logic
   */
  async recordInTransaction(
    tx: Prisma.TransactionClient,
    input: RecordAuditInput,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorType: input.actorType,
        actorId: input.actorId || null,
        action: input.action,
        entityType: input.entityType || null,
        entityId: input.entityId || null,
        requestId: input.requestId || null,
        beforeHash: input.before ? this.hashSnapshot(input.before) : null,
        afterHash: input.after ? this.hashSnapshot(input.after) : null,
        reasonCode: input.reasonCode || null,
        metadata: input.metadata ? (input.metadata as Prisma.JsonObject) : Prisma.DbNull,
        ip: input.ip || null,
      },
    });
  }

  /**
   * Hash a snapshot for before/after comparison
   * Sensitive values should be pre-hashed by the caller
   */
  private hashSnapshot(snapshot: Record<string, unknown>): string {
    const normalized = JSON.stringify(snapshot, Object.keys(snapshot).sort());
    return createHmac('sha256', process.env.HMAC_SECRET || 'dev-secret')
      .update(normalized)
      .digest('hex');
  }
}
