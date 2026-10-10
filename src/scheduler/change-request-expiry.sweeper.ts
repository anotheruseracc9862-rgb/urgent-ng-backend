import { Injectable } from '@nestjs/common';
import { BaseSweeper } from './base-sweeper.js';
import { PrismaService } from '../database/prisma.service.js';
import { ChangeRequestService } from '../assignments/change-request.service.js';

/** Expires pending change requests past their deadline (Backend PRD 15.6, 25.3). */
@Injectable()
export class ChangeRequestExpirySweeper extends BaseSweeper {
  constructor(
    prisma: PrismaService,
    private readonly changes: ChangeRequestService,
  ) {
    super(prisma, 'ChangeRequestExpirySweeper');
  }

  protected async processBatch(): Promise<number> {
    return this.changes.expireDue();
  }
}
