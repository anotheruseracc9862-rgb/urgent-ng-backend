import { Injectable } from '@nestjs/common';
import { BaseSweeper } from './base-sweeper.js';
import { PrismaService } from '../database/prisma.service.js';
import { EnforcementService } from '../enforcement/enforcement.service.js';

/** Ends enforcement actions whose period passed: restrictions expire and a suspension lifts (Backend PRD 21.4). */
@Injectable()
export class EnforcementExpirySweeper extends BaseSweeper {
  constructor(
    prisma: PrismaService,
    private readonly enforcement: EnforcementService,
  ) {
    super(prisma, 'EnforcementExpirySweeper');
  }

  protected async processBatch(): Promise<number> {
    return this.enforcement.expireDue();
  }
}
