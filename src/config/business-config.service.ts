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
import { DEFAULTS, type BusinessConfig } from './business-config.defaults.js';

export type { BusinessConfig } from './business-config.defaults.js';

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
