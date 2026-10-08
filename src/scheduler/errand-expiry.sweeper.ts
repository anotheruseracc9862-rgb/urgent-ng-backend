import { Injectable } from '@nestjs/common';
import { BaseSweeper } from './base-sweeper.js';
import { PrismaService } from '../database/prisma.service.js';
import { ErrandExpiryService } from '../errands/errand-expiry.service.js';

/** Expires OPEN errands whose deadline has passed (Backend PRD 11.4, 25.3). */
@Injectable()
export class ErrandExpirySweeper extends BaseSweeper {
  constructor(
    prisma: PrismaService,
    private readonly expiry: ErrandExpiryService,
  ) {
    super(prisma, 'ErrandExpirySweeper');
  }

  protected async processBatch(): Promise<number> {
    return this.expiry.expireDue();
  }
}
