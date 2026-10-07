import { Injectable, Logger } from '@nestjs/common';
import { AuditActorType } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';

export interface RequestContext {
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export interface AuthAuditEvent {
  action: string;
  actorType?: AuditActorType;
  actorId?: string;
  entityType?: string;
  entityId?: string;
  reasonCode?: string;
  metadata?: Record<string, unknown>;
  ctx?: RequestContext;
}

/**
 * Authentication audit trail (Backend PRD 9.2: every OTP issue and verification,
 * every login, lockout, logout and password reset).
 *
 * Never put secrets, OTP values or full phone numbers / emails in `metadata`.
 * A failure to write the audit row is logged and does not break the login flow:
 * an audit outage must not lock every user out.
 */
@Injectable()
export class AuthAuditService {
  private readonly logger = new Logger(AuthAuditService.name);

  constructor(private readonly audit: AuditService) {}

  async record(event: AuthAuditEvent): Promise<void> {
    try {
      await this.audit.record({
        actorType: event.actorType ?? (event.actorId ? AuditActorType.USER : AuditActorType.SYSTEM),
        actorId: event.actorId,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        reasonCode: event.reasonCode,
        metadata: event.metadata,
        requestId: event.ctx?.requestId,
        ip: event.ctx?.ip,
      });
    } catch (error) {
      this.logger.error(
        `Could not write audit event ${event.action}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
