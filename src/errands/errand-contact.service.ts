import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { decrypt, encrypt } from '../common/utils/crypto.helper.js';
import { isValidNigerianPhone, normalizePhone } from '../common/utils/phone.helper.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { VALIDATION_ERROR } from '../common/constants/error-codes.js';
import type { ErrandContactInputDto } from './errand.dto.js';
import type { PrismaService } from '../database/prisma.service.js';

export type ContactSide = 'pickup' | 'dropoff';

export interface ContactValue {
  name: string | null;
  phone: string | null;
}

const KEY_ID = 'primary';

type Client = Prisma.TransactionClient | PrismaService;

/**
 * Pickup and drop-off contacts (Backend PRD 11.1). Every name and number is encrypted with
 * AES-256-GCM bound to the errand and the field, so a value copied from one row to another does
 * not decrypt. Contacts never appear in feed, offer or marketplace views.
 */
@Injectable()
export class ErrandContactService {
  private readonly logger = new Logger(ErrandContactService.name);

  constructor(private readonly appConfig: ConfigService) {}

  /** Set (object) or clear (null) one side. The other side is untouched. */
  async save(tx: Prisma.TransactionClient, errandId: string, side: ContactSide, input: ErrandContactInputDto | null): Promise<void> {
    const name = input?.name?.trim() || null;
    const phone = input?.phone?.trim() ? this.cleanPhone(input.phone, side) : null;
    const data = {
      [`${side}Name`]: this.seal(errandId, `${side}_name`, name),
      [`${side}Phone`]: this.seal(errandId, `${side}_phone`, phone),
    };
    await tx.errandContact.upsert({
      where: { errandId },
      create: { errandId, encryptionKeyId: KEY_ID, ...data },
      update: { ...data, deletedAt: null },
    });
  }

  async read(client: Client, errandId: string): Promise<Record<ContactSide, ContactValue | null>> {
    const row = await client.errandContact.findFirst({ where: { errandId, deletedAt: null } });
    if (!row) {
      return { pickup: null, dropoff: null };
    }
    return {
      pickup: this.open(errandId, 'pickup', row.pickupName, row.pickupPhone),
      dropoff: this.open(errandId, 'dropoff', row.dropoffName, row.dropoffPhone),
    };
  }

  private cleanPhone(phone: string, side: ContactSide): string {
    if (!isValidNigerianPhone(phone)) {
      throw DomainException.of(VALIDATION_ERROR, {
        message: 'Enter a valid Nigerian phone number.',
        details: { field: `${side}Contact.phone` },
      });
    }
    return normalizePhone(phone);
  }

  private seal(errandId: string, field: string, value: string | null): string | null {
    return value
      ? encrypt(value, this.appConfig.getOrThrow<string>('security.dataEncryptionKey'), { keyId: KEY_ID, aad: `errand:${errandId}:${field}` })
      : null;
  }

  private open(errandId: string, side: ContactSide, name: string | null, phone: string | null): ContactValue | null {
    if (!name && !phone) {
      return null;
    }
    const secret = this.appConfig.getOrThrow<string>('security.dataEncryptionKey');
    const unseal = (field: string, value: string | null): string | null => {
      if (!value) return null;
      try {
        return decrypt(value, secret, { aad: `errand:${errandId}:${side}_${field}` });
      } catch {
        this.logger.error(`Could not decrypt ${side} ${field} of errand ${errandId}`);
        return null;
      }
    };
    const opened = { name: unseal('name', name), phone: unseal('phone', phone) };
    return opened.name || opened.phone ? opened : null;
  }
}
