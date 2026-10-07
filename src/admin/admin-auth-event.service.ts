import { Injectable, Logger } from '@nestjs/common';
import type { AdminAuthEventType } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';

export interface AdminRequestContext {
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

/**
 * Every admin authentication event, successful or not (Backend PRD 24.1). The table is
 * append-only. A failure to write an event is logged, not thrown, so an outage of the
 * audit table cannot lock every admin out.
 */
@Injectable()
export class AdminAuthEventService {
  private readonly logger = new Logger(AdminAuthEventService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: {
    event: AdminAuthEventType;
    adminId?: string | null;
    email?: string | null;
    reason?: string;
    ctx: AdminRequestContext;
  }): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO admin_auth_events (admin_id, event, email, reason, ip, user_agent, request_id)
        VALUES (${input.adminId ?? null}::uuid, ${input.event}::"AdminAuthEventType", ${input.email ?? null},
                ${input.reason ?? null}, ${input.ctx.ip ?? null}::inet, ${input.ctx.userAgent ?? null},
                ${input.ctx.requestId ?? null})
      `;
    } catch (error) {
      this.logger.error(`Could not record admin auth event ${input.event}: ${String(error)}`);
    }
  }
}
