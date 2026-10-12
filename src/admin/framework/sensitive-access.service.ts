import { Injectable } from '@nestjs/common';
import { AuditActorType } from '@prisma/client';
import { AuditService } from '../../audit/audit.service.js';
import { DomainException } from '../../common/exceptions/domain.exception.js';
import { FORBIDDEN } from '../../common/constants/error-codes.js';
import type { AuthenticatedAdmin } from '../decorators/admin-auth.decorator.js';
import type { AdminPermissionKey } from '../admin.permissions.js';
import type { AdminRequestContext } from './admin-action.service.js';

/**
 * Sensitive reads (Backend PRD 24.3): NIN and verification data, exact addresses, exact location
 * history, private chat content and account security information each need their own permission,
 * and every such read leaves an audit record (admin, permission, target, request id).
 *
 * Call `record` BEFORE returning the data. If the audit write fails the read fails: sensitive data
 * is never shown without a record that it was.
 */
@Injectable()
export class SensitiveAccessService {
  constructor(private readonly audit: AuditService) {}

  async record(input: {
    admin: AuthenticatedAdmin;
    permission: AdminPermissionKey;
    /** What is being looked at: `chat.conversation`, `errand.exact_location`, `verification.submission`... */
    resource: string;
    entityType: string;
    entityId: string;
    reasonText?: string;
    ctx?: AdminRequestContext;
  }): Promise<void> {
    if (!input.admin.permissions.includes(input.permission)) {
      throw DomainException.of(FORBIDDEN, { details: { requiredPermission: input.permission } });
    }
    await this.audit.record({
      actorType: AuditActorType.ADMIN,
      actorId: input.admin.adminId,
      action: 'admin.sensitive_view',
      entityType: input.entityType,
      entityId: input.entityId,
      reasonCode: input.permission,
      requestId: input.ctx?.requestId,
      ip: input.ctx?.ip,
      metadata: { resource: input.resource, ...(input.reasonText ? { reasonText: input.reasonText } : {}) },
    });
  }
}
