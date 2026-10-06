/**
 * Business configuration service (P1-02)
 * Typed access to the ConfigValue table with a 60s Redis cache and write-time invalidation.
 * Redis is only a cache: when it is down, reads fall back to PostgreSQL.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditActorType } from '@prisma/client';
import { Redis } from 'ioredis';
import { PrismaService } from '../database/prisma.service.js';
import { REDIS_CLIENT } from '../common/redis/redis.module.js';
import { AuditService } from '../audit/audit.service.js';

export interface BusinessConfig {
  // 32.1 Marketplace rules
  ERRAND_EXPIRY_HOURS: number;
  SCHEDULED_ERRAND_MAX_OPEN_DAYS: number;
  SCHEDULE_MIN_LEAD_HOURS: number;
  SCHEDULE_MAX_DAYS_AHEAD: number;
  SCHEDULED_EXPIRY_BUFFER_MINUTES: number;
  ASSIGNMENT_ACCEPTANCE_MINUTES: number;
  DELIVERY_AUTO_COMPLETION_HOURS: number;
  MAX_OFFER_PER_RUNNER_PER_ERRAND: number;
  OFFER_MIN_AMOUNT: number;
  OFFER_MAX_AMOUNT: number;
  OFFER_DURATION_MIN_MINUTES: number;
  OFFER_DURATION_MAX_MINUTES: number;
  FREE_RUNNER_DAILY_OFFER_LIMIT: number;
  PRO_DAILY_OFFER_CAP: number;
  MAX_OPEN_OFFERS_PER_RUNNER: number;
  MAX_CONCURRENT_ASSIGNMENTS_PER_RUNNER: number;
  MAX_OPEN_ERRANDS_PER_REQUESTER: number;
  MAX_DRAFTS_PER_REQUESTER: number;
  CHANGE_REQUEST_EXPIRY_HOURS: number;
  MAX_DELAY_NOTICES_PER_ASSIGNMENT: number;
  CHAT_POST_COMPLETION_DAYS: number;
  RATING_WINDOW_DAYS: number;
  RATING_EDIT_HOURS: number;
  RATING_MIN_COUNT_FOR_AVERAGE: number;
  RATING_SCALE_MAX: number;
  FEED_MAX_PINNED_BOOSTS_PER_PAGE: number;

  // 32.2 Location and notifications
  LOCATION_FRESH_MINUTES: number;
  LOCATION_STALE_MINUTES: number;
  LOCATION_UPDATE_MIN_SECONDS: number;
  LOCATION_MOVEMENT_THRESHOLD_METERS: number;
  LOCATION_HISTORY_RETENTION_DAYS: number;
  APPROX_GRID_METERS: number;
  APPROX_MAX_OFFSET_METERS: number;
  RUNNER_AREA_MIN_KM: number;
  RUNNER_AREA_MAX_KM: number;
  RUNNER_AREA_DEFAULT_KM: number;
  NEARBY_FIRST_WAVE_SIZE: number;
  NEARBY_BOOST_WAVE_SIZE: number;
  NEARBY_PUSH_CAP_PER_HOUR: number;
  QUIET_HOURS_DEFAULT: string;
  PRO_NOTIFICATION_HEAD_START_MINUTES: number;
  TRUSTED_LINK_MAX_ACTIVE_PER_ERRAND: number;
  TRUSTED_LINK_MAX_HOURS: number;
  TRUSTED_LINK_POST_TERMINAL_HOURS: number;

  // 32.3 Identity and security
  OTP_TTL_MINUTES: number;
  OTP_MAX_ATTEMPTS: number;
  OTP_RESEND_COOLDOWN_SECONDS: number;
  OTP_MAX_PER_DESTINATION_PER_HOUR: number;
  OTP_MAX_PER_IP_PER_HOUR: number;
  ACCESS_TOKEN_MINUTES: number;
  REFRESH_TOKEN_DAYS: number;
  LOGIN_LOCKOUT_FAILURES: number;
  LOGIN_LOCKOUT_WINDOW_MINUTES: number;
  ACCOUNT_DELETION_GRACE_DAYS: number;
  ANONYMISATION_DAYS: number;
  VERIFICATION_ATTEMPTS_PER_FEE: number;
  VERIFICATION_RETRY_COOLDOWN_HOURS: number;
  STAGED_SELFIE_RETENTION_DAYS: number;
  KYC_SELFIE_MATCH_THRESHOLD: number;
  KYC_REQUEST_TIMEOUT_SECONDS: number;
  IDEMPOTENCY_TTL_HOURS: number;

  // 32.4 Commercial
  VERIFICATION_FEE: number;
  RUNNER_PRO_PRICE: number;
  RUNNER_PRO_PERIOD_DAYS: number;
  RUNNER_PRO_GRACE_DAYS: number;
  PRIORITY_BOOST_PRICE: number;
  PRIORITY_BOOST_MAX_HOURS: number;
  REFUND_FOUR_EYES_THRESHOLD: number;
  VAT_RATE: number;

  // 32.5 Trust and safety
  RELIABILITY_WINDOW_DAYS: number;
  LADDER_WARNING_POINTS: number;
  LADDER_RESTRICTION_POINTS: number;
  LADDER_SUSPENSION_POINTS: number;
  LADDER_ADMIN_REVIEW_POINTS: number;
  NO_SHOW_PROMPT_MINUTES: number;
  NO_SHOW_EARLIEST_REPORT_MINUTES: number;
  BADGE_MIN_AGREED_AMOUNT: number;
  TRUSTED_CANCELLATION_WINDOW: number;
  FAST_RESPONDER_WINDOW: number;
  RESPONSE_TIME_WINDOW: number;
  DISPUTE_FIRST_RESPONSE_HOURS: number;
  DISPUTE_RESOLUTION_DAYS: number;
  REPORT_FIRST_RESPONSE_HOURS: number;
  APPEAL_RESPONSE_DAYS: number;

  // 32.6 Media and rate limits
  MAX_UPLOAD_BYTES: number;
  SERVER_HARD_UPLOAD_BYTES: number;
  MAX_ERRAND_PHOTOS: number;
  MAX_CHAT_IMAGES_PER_MESSAGE: number;
  RATE_LOGIN_PER_MIN: number;
  RATE_FEED_PER_MIN: number;
  RATE_GLOBAL_PER_MIN: number;

  // Kill switches
  FEATURE_REGISTRATIONS_ENABLED: boolean;
  FEATURE_ERRAND_POSTING_ENABLED: boolean;
  FEATURE_OFFERS_ENABLED: boolean;
  FEATURE_BILLING_ENABLED: boolean;
}

const DEFAULTS: BusinessConfig = {
  // 32.1 Marketplace rules
  ERRAND_EXPIRY_HOURS: 24,
  SCHEDULED_ERRAND_MAX_OPEN_DAYS: 7,
  SCHEDULE_MIN_LEAD_HOURS: 1,
  SCHEDULE_MAX_DAYS_AHEAD: 7,
  SCHEDULED_EXPIRY_BUFFER_MINUTES: 30,
  ASSIGNMENT_ACCEPTANCE_MINUTES: 30,
  DELIVERY_AUTO_COMPLETION_HOURS: 24,
  MAX_OFFER_PER_RUNNER_PER_ERRAND: 1,
  OFFER_MIN_AMOUNT: 20000, // ₦200 in kobo
  OFFER_MAX_AMOUNT: 50000000, // ₦500,000 in kobo
  OFFER_DURATION_MIN_MINUTES: 5,
  OFFER_DURATION_MAX_MINUTES: 1440,
  FREE_RUNNER_DAILY_OFFER_LIMIT: 10,
  PRO_DAILY_OFFER_CAP: 100,
  MAX_OPEN_OFFERS_PER_RUNNER: 20,
  MAX_CONCURRENT_ASSIGNMENTS_PER_RUNNER: 3,
  MAX_OPEN_ERRANDS_PER_REQUESTER: 10,
  MAX_DRAFTS_PER_REQUESTER: 20,
  CHANGE_REQUEST_EXPIRY_HOURS: 2,
  MAX_DELAY_NOTICES_PER_ASSIGNMENT: 3,
  CHAT_POST_COMPLETION_DAYS: 7,
  RATING_WINDOW_DAYS: 7,
  RATING_EDIT_HOURS: 24,
  RATING_MIN_COUNT_FOR_AVERAGE: 3,
  RATING_SCALE_MAX: 5,
  FEED_MAX_PINNED_BOOSTS_PER_PAGE: 3,

  // 32.2 Location and notifications
  LOCATION_FRESH_MINUTES: 5,
  LOCATION_STALE_MINUTES: 30,
  LOCATION_UPDATE_MIN_SECONDS: 30,
  LOCATION_MOVEMENT_THRESHOLD_METERS: 100,
  LOCATION_HISTORY_RETENTION_DAYS: 30,
  APPROX_GRID_METERS: 500,
  APPROX_MAX_OFFSET_METERS: 250,
  RUNNER_AREA_MIN_KM: 1,
  RUNNER_AREA_MAX_KM: 20,
  RUNNER_AREA_DEFAULT_KM: 5,
  NEARBY_FIRST_WAVE_SIZE: 50,
  NEARBY_BOOST_WAVE_SIZE: 50,
  NEARBY_PUSH_CAP_PER_HOUR: 10,
  QUIET_HOURS_DEFAULT: '22:00–06:00 Africa/Lagos',
  PRO_NOTIFICATION_HEAD_START_MINUTES: 2,
  TRUSTED_LINK_MAX_ACTIVE_PER_ERRAND: 5,
  TRUSTED_LINK_MAX_HOURS: 48,
  TRUSTED_LINK_POST_TERMINAL_HOURS: 2,

  // 32.3 Identity and security
  OTP_TTL_MINUTES: 10,
  OTP_MAX_ATTEMPTS: 5,
  OTP_RESEND_COOLDOWN_SECONDS: 60,
  OTP_MAX_PER_DESTINATION_PER_HOUR: 5,
  OTP_MAX_PER_IP_PER_HOUR: 10,
  ACCESS_TOKEN_MINUTES: 15,
  REFRESH_TOKEN_DAYS: 30,
  LOGIN_LOCKOUT_FAILURES: 10,
  LOGIN_LOCKOUT_WINDOW_MINUTES: 15,
  ACCOUNT_DELETION_GRACE_DAYS: 14,
  ANONYMISATION_DAYS: 30,
  VERIFICATION_ATTEMPTS_PER_FEE: 3,
  VERIFICATION_RETRY_COOLDOWN_HOURS: 24,
  STAGED_SELFIE_RETENTION_DAYS: 30,
  KYC_SELFIE_MATCH_THRESHOLD: 90,
  KYC_REQUEST_TIMEOUT_SECONDS: 30,
  IDEMPOTENCY_TTL_HOURS: 24,

  // 32.4 Commercial
  VERIFICATION_FEE: 0, // ₦0 in kobo
  RUNNER_PRO_PRICE: 500000, // ₦5,000 in kobo
  RUNNER_PRO_PERIOD_DAYS: 30,
  RUNNER_PRO_GRACE_DAYS: 3,
  PRIORITY_BOOST_PRICE: 100000, // ₦1,000 in kobo
  PRIORITY_BOOST_MAX_HOURS: 24,
  REFUND_FOUR_EYES_THRESHOLD: 2000000, // ₦20,000 in kobo
  VAT_RATE: 7.5,

  // 32.5 Trust and safety
  RELIABILITY_WINDOW_DAYS: 90,
  LADDER_WARNING_POINTS: 4,
  LADDER_RESTRICTION_POINTS: 8,
  LADDER_SUSPENSION_POINTS: 12,
  LADDER_ADMIN_REVIEW_POINTS: 16,
  NO_SHOW_PROMPT_MINUTES: 15,
  NO_SHOW_EARLIEST_REPORT_MINUTES: 30,
  BADGE_MIN_AGREED_AMOUNT: 50000, // ₦500 in kobo
  TRUSTED_CANCELLATION_WINDOW: 20,
  FAST_RESPONDER_WINDOW: 20,
  RESPONSE_TIME_WINDOW: 20,
  DISPUTE_FIRST_RESPONSE_HOURS: 48,
  DISPUTE_RESOLUTION_DAYS: 7,
  REPORT_FIRST_RESPONSE_HOURS: 72,
  APPEAL_RESPONSE_DAYS: 7,

  // 32.6 Media and rate limits
  MAX_UPLOAD_BYTES: 5 * 1024 * 1024, // 5 MB
  SERVER_HARD_UPLOAD_BYTES: 8 * 1024 * 1024, // 8 MB
  MAX_ERRAND_PHOTOS: 6,
  MAX_CHAT_IMAGES_PER_MESSAGE: 1,
  RATE_LOGIN_PER_MIN: 5,
  RATE_FEED_PER_MIN: 60,
  RATE_GLOBAL_PER_MIN: 300,

  // Kill switches
  FEATURE_REGISTRATIONS_ENABLED: true,
  FEATURE_ERRAND_POSTING_ENABLED: true,
  FEATURE_OFFERS_ENABLED: true,
  FEATURE_BILLING_ENABLED: true,
};


const CACHE_TTL_SECONDS = 60;
const CACHE_KEY_PREFIX = 'config:';

type ConfigKey = keyof BusinessConfig;

@Injectable()
export class BusinessConfigService {
  private readonly logger = new Logger(BusinessConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly audit: AuditService,
  ) {}

  /**
   * Get a config value: cache, then database, then built-in default.
   * A stored value of the wrong type is ignored (default used) and logged.
   */
  async get<K extends ConfigKey>(key: K): Promise<BusinessConfig[K]> {
    const cached = await this.readCache(key);
    if (cached !== undefined) {
      return cached;
    }

    const rows = await this.prisma.$queryRaw<Array<{ value_json: unknown }>>`
      SELECT value_json
      FROM config_values
      WHERE key = ${key}
        AND deleted_at IS NULL
        AND effective_from <= NOW()
      ORDER BY effective_from DESC, version DESC
      LIMIT 1
    `;

    const value = this.resolve(key, rows.length > 0 ? rows[0].value_json : undefined);
    await this.writeCache(key, value);
    return value;
  }

  /**
   * Set a config value (new version row). Invalidates the cache.
   * Only callable by admin operations. Throws if the value type does not match
   * the key's type. The change is audited in the same transaction.
   */
  async set<K extends ConfigKey>(
    key: K,
    value: BusinessConfig[K],
    effectiveFrom?: Date,
    updatedByAdminId?: string,
  ): Promise<void> {
    if (!this.isValidType(key, value)) {
      throw new Error(
        `Config ${key} expects a ${typeof DEFAULTS[key]}, got ${typeof value}`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // Serialise concurrent writers of the same key so versions never collide.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;

      const current = await tx.$queryRaw<Array<{ version: number }>>`
        SELECT COALESCE(MAX(version), 0) AS version
        FROM config_values
        WHERE key = ${key} AND deleted_at IS NULL
      `;
      const nextVersion = Number(current[0].version) + 1;

      // Without an explicit time the change takes effect now (database clock),
      // but strictly after the latest existing version, because effective_from
      // is unique per key.
      const inserted = await tx.$queryRaw<Array<{ id: string; effective_from: Date }>>`
        INSERT INTO config_values (key, value_json, version, effective_from, updated_by_admin_id)
        VALUES (
          ${key},
          ${JSON.stringify(value)}::jsonb,
          ${nextVersion},
          COALESCE(
            ${effectiveFrom ?? null}::timestamptz,
            GREATEST(
              clock_timestamp(),
              (SELECT MAX(effective_from) + INTERVAL '1 millisecond'
                 FROM config_values WHERE key = ${key} AND deleted_at IS NULL)
            )
          ),
          ${updatedByAdminId ?? null}::uuid
        )
        RETURNING id, effective_from
      `;

      await this.audit.recordInTransaction(tx, {
        actorType: updatedByAdminId ? AuditActorType.ADMIN : AuditActorType.SYSTEM,
        actorId: updatedByAdminId,
        action: 'config.set',
        entityType: 'config_value',
        entityId: inserted[0].id,
        after: { key, value, version: nextVersion, effectiveFrom: inserted[0].effective_from },
        metadata: { key, version: nextVersion },
      });
    });

    await this.invalidate(key);
  }

  /**
   * Invalidate cache for a specific key
   */
  async invalidate<K extends ConfigKey>(key: K): Promise<void> {
    try {
      await this.redis.del(`${CACHE_KEY_PREFIX}${key}`);
    } catch (error) {
      this.logger.warn(`Config cache invalidation failed for ${key}: ${String(error)}`);
    }
  }

  /**
   * Get all config values (useful for admin UI): one cache read plus at most
   * one database query.
   */
  async getAll(): Promise<BusinessConfig> {
    const keys = Object.keys(DEFAULTS) as ConfigKey[];
    const result: Record<string, unknown> = {};

    let cached: Array<string | null> = keys.map(() => null);
    try {
      cached = await this.redis.mget(keys.map((key) => `${CACHE_KEY_PREFIX}${key}`));
    } catch {
      // Redis down: read from the database
    }

    const missing: ConfigKey[] = [];
    keys.forEach((key, index) => {
      const raw = cached[index];
      if (raw !== null && raw !== undefined) {
        result[key] = JSON.parse(raw);
      } else {
        missing.push(key);
      }
    });

    if (missing.length > 0) {
      const rows = await this.prisma.$queryRaw<Array<{ key: string; value_json: unknown }>>`
        SELECT DISTINCT ON (key) key, value_json
        FROM config_values
        WHERE deleted_at IS NULL AND effective_from <= NOW()
        ORDER BY key, effective_from DESC, version DESC
      `;
      const stored = new Map(rows.map((row) => [row.key, row.value_json]));

      for (const key of missing) {
        const value = this.resolve(key, stored.get(key));
        result[key] = value;
        await this.writeCache(key, value);
      }
    }

    return result as unknown as BusinessConfig;
  }

  /**
   * Get default value for a key (without database or cache)
   */
  getDefault<K extends ConfigKey>(key: K): BusinessConfig[K] {
    return DEFAULTS[key];
  }

  private isValidType(key: ConfigKey, value: unknown): boolean {
    return typeof value === typeof DEFAULTS[key];
  }

  private resolve<K extends ConfigKey>(key: K, stored: unknown): BusinessConfig[K] {
    if (stored === undefined) {
      return DEFAULTS[key];
    }
    if (!this.isValidType(key, stored)) {
      this.logger.warn(
        `Stored config ${key} has type ${typeof stored}, expected ${typeof DEFAULTS[key]}; using default`,
      );
      return DEFAULTS[key];
    }
    return stored as BusinessConfig[K];
  }

  private async readCache<K extends ConfigKey>(
    key: K,
  ): Promise<BusinessConfig[K] | undefined> {
    try {
      const raw = await this.redis.get(`${CACHE_KEY_PREFIX}${key}`);
      return raw === null ? undefined : (JSON.parse(raw) as BusinessConfig[K]);
    } catch {
      return undefined; // Redis down or corrupt entry: fall back to the database
    }
  }

  private async writeCache(key: ConfigKey, value: unknown): Promise<void> {
    try {
      await this.redis.setex(
        `${CACHE_KEY_PREFIX}${key}`,
        CACHE_TTL_SECONDS,
        JSON.stringify(value),
      );
    } catch {
      // cache only
    }
  }
}
