import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';

/**
 * Blocklist Service (P2-02)
 * Per PRD §21.7:
 * - Blocklist prevents registration, verification, and OTP flows
 * - Stores phone, email, and identity HMAC (hashed)
 * - Prevents duplicate runner accounts for same verified phone/identity
 */

export enum BlocklistEntryType {
  PHONE = 'PHONE',
  EMAIL = 'EMAIL',
  IDENTITY_HMAC = 'IDENTITY_HMAC',
}

export enum BlocklistReason {
  PERMANENT_SUSPENSION = 'PERMANENT_SUSPENSION',
  DUPLICATE_IDENTITY = 'DUPLICATE_IDENTITY',
  FRAUD = 'FRAUD',
  ABUSE = 'ABUSE',
  OTHER = 'OTHER',
}

@Injectable()
export class BlocklistService {
  private readonly hmacSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.hmacSecret = this.config.getOrThrow<string>('security.blocklistHmacSecret');
  }

  /**
   * Check if a phone number is blocklisted
   */
  async isPhoneBlocked(phone: string): Promise<boolean> {
    const valueHash = this.hashValue(phone);
    const entry = await this.prisma.blocklistEntry.findFirst({
      where: {
        type: BlocklistEntryType.PHONE,
        valueHash,
        deletedAt: null,
      },
    });
    return entry !== null;
  }

  /**
   * Check if an email is blocklisted
   */
  async isEmailBlocked(email: string): Promise<boolean> {
    const valueHash = this.hashValue(email.toLowerCase());
    const entry = await this.prisma.blocklistEntry.findFirst({
      where: {
        type: BlocklistEntryType.EMAIL,
        valueHash,
        deletedAt: null,
      },
    });
    return entry !== null;
  }

  /**
   * Check if an identity hash is blocklisted
   */
  async isIdentityBlocked(identityHash: string): Promise<boolean> {
    const entry = await this.prisma.blocklistEntry.findFirst({
      where: {
        type: BlocklistEntryType.IDENTITY_HMAC,
        valueHash: identityHash,
        deletedAt: null,
      },
    });
    return entry !== null;
  }

  /**
   * Add a phone to the blocklist
   */
  async blockPhone(phone: string, reason: BlocklistReason, adminId?: string): Promise<void> {
    const valueHash = this.hashValue(phone);
    await this.prisma.blocklistEntry.create({
      data: {
        type: BlocklistEntryType.PHONE,
        valueHash,
        reason,
      },
    });
  }

  /**
   * Add an email to the blocklist
   */
  async blockEmail(email: string, reason: BlocklistReason, adminId?: string): Promise<void> {
    const valueHash = this.hashValue(email.toLowerCase());
    await this.prisma.blocklistEntry.create({
      data: {
        type: BlocklistEntryType.EMAIL,
        valueHash,
        reason,
      },
    });
  }

  /**
   * Add an identity hash to the blocklist
   */
  async blockIdentity(identityHash: string, reason: BlocklistReason, adminId?: string): Promise<void> {
    await this.prisma.blocklistEntry.create({
      data: {
        type: BlocklistEntryType.IDENTITY_HMAC,
        valueHash: identityHash,
        reason,
      },
    });
  }

  /**
   * Hash a value using HMAC-SHA256
   */
  private hashValue(value: string): string {
    return createHmac('sha256', this.hmacSecret)
      .update(value)
      .digest('hex');
  }
}
