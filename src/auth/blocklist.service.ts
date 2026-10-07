import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlocklistType } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { hmacSign } from '../common/utils/crypto.helper.js';
import { normaliseEmail } from './identifier.js';

/**
 * Blocklist (Backend PRD 21.7). Entries hold only a keyed hash of the phone, email
 * or identity, never the value itself. Removing an entry is a soft delete.
 */
@Injectable()
export class BlocklistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  isPhoneBlocked(phoneE164: string): Promise<boolean> {
    return this.exists(BlocklistType.PHONE, this.hash('phone', phoneE164));
  }

  isEmailBlocked(email: string): Promise<boolean> {
    return this.exists(BlocklistType.EMAIL, this.hash('email', normaliseEmail(email)));
  }

  isIdentityBlocked(identityHash: string): Promise<boolean> {
    return this.exists(BlocklistType.IDENTITY_HMAC, identityHash);
  }

  /** Add (idempotent): blocking the same value twice keeps one live entry. */
  blockPhone(phoneE164: string, reason: string): Promise<void> {
    return this.add(BlocklistType.PHONE, this.hash('phone', phoneE164), reason);
  }

  blockEmail(email: string, reason: string): Promise<void> {
    return this.add(BlocklistType.EMAIL, this.hash('email', normaliseEmail(email)), reason);
  }

  blockIdentity(identityHash: string, reason: string): Promise<void> {
    return this.add(BlocklistType.IDENTITY_HMAC, identityHash, reason);
  }

  async unblockPhone(phoneE164: string): Promise<void> {
    await this.remove(BlocklistType.PHONE, this.hash('phone', phoneE164));
  }

  async unblockEmail(email: string): Promise<void> {
    await this.remove(BlocklistType.EMAIL, this.hash('email', normaliseEmail(email)));
  }

  private async exists(type: BlocklistType, valueHash: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ one: number }>>`
      SELECT 1 AS one FROM blocklist_entries
      WHERE type = ${type}::"BlocklistType" AND value_hash = ${valueHash}
        AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    `;
    return rows.length > 0;
  }

  private async add(type: BlocklistType, valueHash: string, reason: string): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO blocklist_entries (type, value_hash, reason)
      VALUES (${type}::"BlocklistType", ${valueHash}, ${reason})
      ON CONFLICT (type, value_hash) WHERE deleted_at IS NULL DO NOTHING
    `;
  }

  private async remove(type: BlocklistType, valueHash: string): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE blocklist_entries SET deleted_at = now()
      WHERE type = ${type}::"BlocklistType" AND value_hash = ${valueHash} AND deleted_at IS NULL
    `;
  }

  private hash(kind: 'phone' | 'email', value: string): string {
    return hmacSign(`blocklist:${kind}:${value}`, this.config.getOrThrow<string>('security.hmacSecret'));
  }
}
