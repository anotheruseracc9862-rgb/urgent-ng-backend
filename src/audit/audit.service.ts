/**
 * Audit service (P1-03)
 * Appends audit log entries for compliance and security tracking
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service.js';
import { AuditActorType, Prisma } from '@prisma/client';
import { hmacSign } from '../common/utils/crypto.helper.js';
import { stableStringify } from '../common/utils/stable-json.js';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Record an audit log entry (own transaction).
   */
  async record(input: RecordAuditInput): Promise<void> {
    await this.prisma.auditLog.create({ data: this.toData(input) });
  }

  /**
   * Record an audit log entry within an existing transaction.
   * Use this when the audit must be atomic with the business change.
   */
  async recordInTransaction(
    tx: Prisma.TransactionClient,
    input: RecordAuditInput,
  ): Promise<void> {
    await tx.auditLog.create({ data: this.toData(input) });
  }

  private toData(input: RecordAuditInput): Prisma.AuditLogUncheckedCreateInput {
    return {
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      requestId: input.requestId ?? null,
      beforeHash: input.before ? this.hashSnapshot(input.before) : null,
      afterHash: input.after ? this.hashSnapshot(input.after) : null,
      reasonCode: input.reasonCode ?? null,
      metadata: input.metadata
        ? (input.metadata as Prisma.InputJsonObject)
        : Prisma.DbNull,
      ip: input.ip ?? null,
    };
  }

  /**
   * Keyed hash of a snapshot, so a before/after change (at any depth) shows up
   * as a different hash without storing sensitive values in the log.
   */
  private hashSnapshot(snapshot: Record<string, unknown>): string {
    return hmacSign(
      stableStringify(snapshot),
      this.config.getOrThrow<string>('security.hmacSecret'),
    );
  }
}
