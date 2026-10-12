import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { REDIS_CLIENT } from '../common/redis/redis.module.js';
import { OTP_PROVIDER, type IOtpProvider } from '../common/providers/otp.provider.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import {
  OTP_DELIVERY_FAILED,
  OTP_EXPIRED,
  OTP_INVALID,
  OTP_RATE_LIMITED,
} from '../common/constants/error-codes.js';
import { hmacSign } from '../common/utils/crypto.helper.js';
import { RiskFlagService } from '../risk/risk-flag.service.js';
import { AuthAuditService, type RequestContext } from './auth-audit.service.js';
import { maskIdentifier, type Identifier } from './identifier.js';

/**
 * OTP service (Backend PRD 9.2).
 *
 * - 6-digit code from a cryptographic RNG, hashed (keyed HMAC bound to the
 *   destination and purpose) before it is stored in Redis. The code itself is
 *   never returned, logged or audited.
 * - Every limit is enforced inside one Lua script, so concurrent requests cannot
 *   slip past the resend cooldown, the hourly caps or the attempt cap.
 * - Limits come from admin-editable config (OTP_* keys).
 * - Sending is refused (not silently allowed) when Redis is down: OTP state lives
 *   only in Redis by design.
 */

export enum OtpPurpose {
  REGISTRATION = 'REGISTRATION',
  PASSWORD_RESET = 'PASSWORD_RESET',
  CONTACT_CHANGE = 'CONTACT_CHANGE',
}

/**
 * KEYS: 1 code, 2 cooldown, 3 destination counter, 4 ip counter (may be the empty key)
 * ARGV: hash, ttl, cooldown, destLimit, ipLimit, useIp(0/1)
 * Returns { status, retryAfterSeconds }  status 0 = issued, 1 = cooldown, 2 = destination cap, 3 = ip cap
 */
const ISSUE_SCRIPT = `
local cooldown = redis.call('PTTL', KEYS[2])
if cooldown > 0 then
  return { 1, math.ceil(cooldown / 1000) }
end
local dest = redis.call('INCR', KEYS[3])
if dest == 1 then redis.call('EXPIRE', KEYS[3], 3600) end
if dest > tonumber(ARGV[4]) then
  return { 2, redis.call('TTL', KEYS[3]) }
end
if ARGV[6] == '1' then
  local ip = redis.call('INCR', KEYS[4])
  if ip == 1 then redis.call('EXPIRE', KEYS[4], 3600) end
  if ip > tonumber(ARGV[5]) then
    return { 3, redis.call('TTL', KEYS[4]) }
  end
end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'hash', ARGV[1], 'attempts', 0)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[3]))
return { 0, 0 }
`;

/**
 * KEYS: 1 code
 * ARGV: hash, maxAttempts
 * Returns { status, remainingAttempts }  status 0 = ok, 1 = wrong, 2 = missing/expired, 3 = attempts used up
 */
const VERIFY_SCRIPT = `
local stored = redis.call('HGET', KEYS[1], 'hash')
if not stored then return { 2, 0 } end
local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
if attempts > tonumber(ARGV[2]) then return { 3, 0 } end
if stored == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return { 0, tonumber(ARGV[2]) - attempts }
end
return { 1, tonumber(ARGV[2]) - attempts }
`;

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly businessConfig: BusinessConfigService,
    private readonly audit: AuthAuditService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(OTP_PROVIDER) private readonly provider: IOtpProvider,
    private readonly risk: RiskFlagService,
  ) {}

  /**
   * Issue and deliver a code. Throws OTP_RATE_LIMITED (cooldown or hourly caps)
   * or OTP_DELIVERY_FAILED. Nothing is returned: the code only goes to the provider.
   *
   * `deliver: false` runs the same counters and cooldown but sends nothing and stores
   * a code nobody knows. Used for destinations that have no account, so a caller
   * cannot tell a registered number from an unregistered one by the rate-limit answers.
   */
  async send(
    identifier: Identifier,
    purpose: OtpPurpose,
    ctx: RequestContext = {},
    options: { deliver?: boolean } = {},
  ): Promise<void> {
    const [ttlMinutes, cooldown, destLimit, ipLimit] = await Promise.all([
      this.businessConfig.get('OTP_TTL_MINUTES'),
      this.businessConfig.get('OTP_RESEND_COOLDOWN_SECONDS'),
      this.businessConfig.get('OTP_MAX_PER_DESTINATION_PER_HOUR'),
      this.businessConfig.get('OTP_MAX_PER_IP_PER_HOUR'),
    ]);

    const deliver = options.deliver !== false;
    const code = deliver
      ? randomInt(0, 1_000_000).toString().padStart(6, '0')
      : randomBytes(16).toString('hex');
    const keys = this.keys(identifier, purpose, ctx.ip);

    let result: [number, number];
    try {
      result = (await this.redis.eval(
        ISSUE_SCRIPT,
        4,
        keys.code,
        keys.cooldown,
        keys.destination,
        keys.ip,
        this.hash(identifier, purpose, code),
        ttlMinutes * 60,
        cooldown,
        destLimit,
        ipLimit,
        ctx.ip ? '1' : '0',
      )) as [number, number];
    } catch (error) {
      this.logger.error(`OTP store unavailable: ${String(error)}`);
      throw DomainException.of(OTP_DELIVERY_FAILED);
    }

    const [status, retryAfterSeconds] = result;
    if (status !== 0) {
      const reason = (['', 'cooldown', 'destination_limit', 'ip_limit'] as const)[status];
      await this.audit.record({
        action: 'auth.otp.rate_limited',
        metadata: { purpose, destination: maskIdentifier(identifier.value), reason },
        ctx,
      });
      // A cooldown is normal use. Hitting an hourly cap is not: signal it, never block on it.
      if (reason !== 'cooldown') {
        await this.risk.raiseQuietly({
          signal: 'OTP_ABUSE',
          subjectKey: reason === 'ip_limit' ? `ip:${this.digest(`ip:${ctx.ip ?? 'none'}`)}` : `dest:${keys.destination}`,
          details: { reason, purpose },
        });
      }
      throw DomainException.of(OTP_RATE_LIMITED, { details: { reason, retryAfterSeconds } });
    }

    if (!deliver) {
      return;
    }

    const delivery =
      identifier.kind === 'phone'
        ? await this.provider.sendSms(identifier.value, code)
        : await this.provider.sendEmail(identifier.value, code);

    if (!delivery.success) {
      // Let the user try again straight away: the failure was not theirs.
      await this.redis.del(keys.code, keys.cooldown).catch(() => undefined);
      this.logger.error(
        `OTP delivery failed (${purpose}, ${maskIdentifier(identifier.value)}): ${delivery.error ?? 'unknown'}`,
      );
      throw DomainException.of(OTP_DELIVERY_FAILED);
    }

    await this.audit.record({
      action: 'auth.otp.issued',
      metadata: { purpose, destination: maskIdentifier(identifier.value), channel: identifier.kind },
      ctx,
    });
  }

  /**
   * Check a code. Resolves on success and burns the code. Throws OTP_INVALID
   * (with the attempts left), OTP_EXPIRED, or OTP_RATE_LIMITED when the 5 attempts
   * are used up.
   */
  async verify(
    identifier: Identifier,
    code: string,
    purpose: OtpPurpose,
    ctx: RequestContext = {},
  ): Promise<void> {
    const maxAttempts = await this.businessConfig.get('OTP_MAX_ATTEMPTS');
    const keys = this.keys(identifier, purpose);

    let result: [number, number];
    try {
      result = (await this.redis.eval(
        VERIFY_SCRIPT,
        1,
        keys.code,
        this.hash(identifier, purpose, code),
        maxAttempts,
      )) as [number, number];
    } catch (error) {
      this.logger.error(`OTP store unavailable: ${String(error)}`);
      throw DomainException.of(OTP_EXPIRED);
    }

    const [status, remainingAttempts] = result;
    const metadata = { purpose, destination: maskIdentifier(identifier.value) };

    if (status === 0) {
      await this.audit.record({ action: 'auth.otp.verified', metadata, ctx });
      return;
    }

    await this.audit.record({
      action: 'auth.otp.failed',
      reasonCode: ['', 'WRONG_CODE', 'EXPIRED', 'ATTEMPTS_EXCEEDED'][status],
      metadata,
      ctx,
    });

    if (status === 1) {
      throw DomainException.of(OTP_INVALID, { details: { remainingAttempts } });
    }
    if (status === 3) {
      await this.risk.raiseQuietly({
        signal: 'OTP_ABUSE',
        subjectKey: `verify:${keys.code}`,
        details: { reason: 'attempts_exceeded', purpose },
      });
      throw DomainException.of(OTP_RATE_LIMITED, { details: { reason: 'attempts_exceeded' } });
    }
    throw DomainException.of(OTP_EXPIRED);
  }

  private keys(identifier: Identifier, purpose: OtpPurpose, ip?: string) {
    const dest = this.digest(`dest:${identifier.value}`);
    return {
      code: `otp:code:${purpose}:${dest}`,
      cooldown: `otp:cooldown:${purpose}:${dest}`,
      destination: `otp:dest-hour:${dest}`,
      ip: `otp:ip-hour:${this.digest(`ip:${ip ?? 'none'}`)}`,
    };
  }

  /** Short digest so phone numbers, emails and IPs never appear in Redis keys. */
  private digest(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 32);
  }

  /** Keyed hash bound to destination and purpose: a code is useless anywhere else. */
  private hash(identifier: Identifier, purpose: OtpPurpose, code: string): string {
    return hmacSign(
      `otp:${purpose}:${identifier.value}:${code}`,
      this.config.getOrThrow<string>('security.hmacSecret'),
    );
  }
}
