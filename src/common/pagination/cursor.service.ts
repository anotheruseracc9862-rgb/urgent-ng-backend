import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { VALIDATION_ERROR } from '../constants/error-codes.js';
import { DomainException } from '../exceptions/domain.exception.js';

export interface CursorData {
  sort: number | string;
  createdAt: Date | string;
  id: string;
}

@Injectable()
export class CursorService {
  private readonly hmacSecret: string;

  constructor(private readonly config: ConfigService) {
    this.hmacSecret = this.config.getOrThrow<string>('security.hmacSecret');
  }

  /**
   * Encode cursor data with HMAC signature
   */
  encode(data: CursorData): string {
    const payload = JSON.stringify({
      sort: data.sort,
      createdAt:
        data.createdAt instanceof Date
          ? data.createdAt.toISOString()
          : data.createdAt,
      id: data.id,
    });

    const signature = this.sign(payload);
    const combined = JSON.stringify({ payload, signature });

    return Buffer.from(combined).toString('base64url');
  }

  /**
   * Decode and verify cursor. Any problem is a 400 VALIDATION_ERROR, never a 500.
   */
  decode(cursor: string): CursorData {
    const invalid = () =>
      DomainException.of(VALIDATION_ERROR, {
        message: 'Invalid pagination cursor.',
        details: { field: 'cursor' },
      });

    let payload: string;
    let signature: string;
    try {
      const combined = Buffer.from(cursor, 'base64url').toString('utf-8');
      ({ payload, signature } = JSON.parse(combined));
    } catch {
      throw invalid();
    }

    if (typeof payload !== 'string' || typeof signature !== 'string') {
      throw invalid();
    }
    if (!this.verify(payload, signature)) {
      throw invalid();
    }

    try {
      const data = JSON.parse(payload);
      const createdAt = new Date(data.createdAt);
      if (
        Number.isNaN(createdAt.getTime()) ||
        typeof data.id !== 'string' ||
        (typeof data.sort !== 'number' && typeof data.sort !== 'string')
      ) {
        throw invalid();
      }
      return { sort: data.sort, createdAt, id: data.id };
    } catch {
      throw invalid();
    }
  }

  private sign(data: string): string {
    return createHmac('sha256', this.hmacSecret).update(data).digest('hex');
  }

  private verify(data: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(data));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
