import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';

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
      createdAt: data.createdAt instanceof Date ? data.createdAt.toISOString() : data.createdAt,
      id: data.id,
    });
    
    const signature = this.sign(payload);
    const combined = JSON.stringify({ payload, signature });
    
    return Buffer.from(combined).toString('base64url');
  }

  /**
   * Decode and verify cursor
   */
  decode(cursor: string): CursorData {
    try {
      const combined = Buffer.from(cursor, 'base64url').toString('utf-8');
      const { payload, signature } = JSON.parse(combined);
      
      if (!this.verify(payload, signature)) {
        throw new Error('Invalid cursor signature');
      }
      
      const data = JSON.parse(payload);
      
      return {
        sort: data.sort,
        createdAt: new Date(data.createdAt),
        id: data.id,
      };
    } catch (error) {
      throw new Error('Invalid cursor format');
    }
  }

  private sign(data: string): string {
    return createHmac('sha256', this.hmacSecret)
      .update(data)
      .digest('hex');
  }

  private verify(data: string, signature: string): boolean {
    const expected = this.sign(data);
    return signature === expected;
  }
}
