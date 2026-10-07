import { Injectable } from '@nestjs/common';
import { BaseSweeper } from './base-sweeper.js';
import { PrismaService } from '../database/prisma.service.js';
import { VerificationExpiryService } from '../verification/verification-expiry.service.js';

/** Expires old verifications, fails abandoned attempts and deletes staged selfies. */
@Injectable()
export class VerificationSweeper extends BaseSweeper {
  constructor(
    prisma: PrismaService,
    private readonly expiry: VerificationExpiryService,
  ) {
    super(prisma, 'VerificationSweeper');
  }

  protected async processBatch(): Promise<number> {
    const expired = await this.expiry.expireDue();
    const abandoned = await this.expiry.failStalePending();
    const selfies = await this.expiry.deleteStagedSelfies();
    return expired + abandoned + selfies;
  }
}
