import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module.js';
import { hmacSign, hmacVerify } from '../common/utils/crypto.helper.js';

export const TICKET_TTL_SECONDS = 60;

/**
 * A short-lived, single-use ticket for clients that cannot send cookies or headers on an
 * EventSource (Backend PRD 19.5: "a short-lived signed query token" for mobile). `POST /events/ticket`
 * issues it to a signed-in user; `GET /events?ticket=...` redeems it once within 60 seconds.
 * Format: `<userId>.<expiresAtMs>.<hmac>`.
 */
@Injectable()
export class RealtimeTicketService {
  constructor(
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  issue(userId: string, now: number = Date.now()): { ticket: string; expiresInSeconds: number } {
    const expires = now + TICKET_TTL_SECONDS * 1000;
    const payload = `${userId}.${expires}`;
    return { ticket: `${payload}.${hmacSign(payload, this.secret())}`, expiresInSeconds: TICKET_TTL_SECONDS };
  }

  /** The user id the ticket was issued to, or null when it is forged, expired or already used. */
  async redeem(ticket: string, now: number = Date.now()): Promise<string | null> {
    const parts = ticket.split('.');
    if (parts.length !== 3) return null;
    const [userId, expires, signature] = parts;
    if (!hmacVerify(`${userId}.${expires}`, signature, this.secret())) return null;
    if (!Number.isFinite(Number(expires)) || Number(expires) <= now) return null;
    // Single use: the first redemption sets the key, every later one finds it.
    const first = await this.redis.set(`rt:ticket:${signature}`, '1', 'EX', TICKET_TTL_SECONDS, 'NX');
    return first === 'OK' ? userId : null;
  }

  private secret(): string {
    return this.config.getOrThrow<string>('security.hmacSecret');
  }
}
