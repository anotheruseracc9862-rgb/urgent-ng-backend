import { Injectable } from '@nestjs/common';
import { AuditActorType, type EntitlementType } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RESOURCE_CONFLICT, RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../common/constants/error-codes.js';

export interface EntitlementView {
  id: string;
  type: EntitlementType;
  source: string;
  quantity: number;
  validFrom: Date;
  validUntil: Date | null;
  revokedAt: Date | null;
  active: boolean;
}

/**
 * Entitlements an admin grants or takes back (Backend PRD 24.4 area 11). A grant is a row with
 * source ADMIN; a revocation sets `revoked_at` (nothing is deleted), and the rule that reads
 * entitlements ignores a revoked row at once.
 */
@Injectable()
export class EntitlementAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string): Promise<EntitlementView[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; type: EntitlementType; source: string; quantity: number; valid_from: Date; valid_until: Date | null; revoked_at: Date | null; active: boolean }>
    >`
      SELECT id::text, type, source, quantity, valid_from, valid_until, revoked_at,
             (revoked_at IS NULL AND valid_from <= clock_timestamp() AND (valid_until IS NULL OR valid_until > clock_timestamp())) AS active
      FROM entitlements WHERE user_id = ${userId}::uuid ORDER BY created_at DESC, id DESC LIMIT 100
    `;
    return rows.map((r) => ({
      id: r.id, type: r.type, source: r.source, quantity: r.quantity, validFrom: r.valid_from, validUntil: r.valid_until,
      revokedAt: r.revoked_at, active: r.active,
    }));
  }

  /** Grant `days` of an entitlement from now (Runner Pro, or a number of verification attempts). */
  async grant(
    input: { userId: string; type: 'RUNNER_PRO' | 'VERIFICATION_ATTEMPT_ALLOWANCE'; days?: number; quantity?: number },
    adminId: string,
  ): Promise<EntitlementView> {
    if (input.type === 'RUNNER_PRO' && !input.days) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'Runner Pro needs a number of days.', details: { field: 'days' } });
    }
    const user = await this.prisma.user.findFirst({ where: { id: input.userId }, select: { id: true } });
    if (!user) throw DomainException.of(RESOURCE_NOT_FOUND);
    const quantity = input.type === 'VERIFICATION_ATTEMPT_ALLOWANCE' ? (input.quantity ?? 1) : 1;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO entitlements (user_id, type, source, quantity, valid_from, valid_until)
      VALUES (${input.userId}::uuid, ${input.type}::"EntitlementType", 'ADMIN', ${quantity}::int, clock_timestamp(),
              CASE WHEN ${input.days ?? null}::int IS NULL THEN NULL
                   ELSE clock_timestamp() + make_interval(days => ${input.days ?? 0}::int) END)
      RETURNING id::text
    `;
    await this.audit.record({
      actorType: AuditActorType.ADMIN,
      actorId: adminId,
      action: 'entitlement.granted_by_admin',
      entityType: 'entitlement',
      entityId: rows[0].id,
      metadata: { userId: input.userId, type: input.type, days: input.days, quantity },
    });
    return (await this.list(input.userId)).find((e) => e.id === rows[0].id) as EntitlementView;
  }

  async revoke(entitlementId: string, adminId: string): Promise<EntitlementView> {
    const rows = await this.prisma.$queryRaw<Array<{ user_id: string; revoked_at: Date | null }>>`
      SELECT user_id::text, revoked_at FROM entitlements WHERE id = ${entitlementId}::uuid FOR UPDATE
    `;
    if (!rows[0]) throw DomainException.of(RESOURCE_NOT_FOUND);
    if (rows[0].revoked_at) throw DomainException.of(RESOURCE_CONFLICT, { message: 'This entitlement is already revoked.' });
    await this.prisma.$executeRaw`UPDATE entitlements SET revoked_at = clock_timestamp() WHERE id = ${entitlementId}::uuid`;
    await this.audit.record({
      actorType: AuditActorType.ADMIN,
      actorId: adminId,
      action: 'entitlement.revoked_by_admin',
      entityType: 'entitlement',
      entityId: entitlementId,
      metadata: { userId: rows[0].user_id },
    });
    return (await this.list(rows[0].user_id)).find((e) => e.id === entitlementId) as EntitlementView;
  }
}
