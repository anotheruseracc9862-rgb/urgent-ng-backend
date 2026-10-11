import { Injectable } from '@nestjs/common';
import { BaseSweeper } from './base-sweeper.js';
import { PrismaService } from '../database/prisma.service.js';
import { TrustedContactService } from '../trusted-contact/trusted-contact.service.js';

/** Marks trusted-contact links EXPIRED once their cap or the post-errand window passed (Backend PRD 17.5). */
@Injectable()
export class TrustedLinkExpirySweeper extends BaseSweeper {
  constructor(
    prisma: PrismaService,
    private readonly shares: TrustedContactService,
  ) {
    super(prisma, 'TrustedLinkExpirySweeper');
  }

  protected async processBatch(): Promise<number> {
    return this.shares.expireDue();
  }
}
