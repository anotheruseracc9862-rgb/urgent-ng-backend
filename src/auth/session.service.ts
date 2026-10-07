import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { hmacSign } from '../common/utils/crypto.helper.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { AUTH_REQUIRED, RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';
import { AuthAuditService, type RequestContext } from './auth-audit.service.js';

/**
 * Sessions (Backend PRD 9.3).
 *
 * - Access token: JWT, audience `urgent-consumer`, 15 minutes (config).
 *   Claims: sub = user id, sid = session family id.
 * - Refresh token: opaque random value, 30 days (config), stored only as a keyed hash.
 *   Every refresh REPLACES the token: the old row is revoked and points at its
 *   replacement, the new row keeps the same family. Replaying an already-rotated
 *   token revokes the whole family.
 * - A "session" the user sees is a family (one login on one device).
 *
 * Expiry and revocation are decided by the database clock (`now()`).
 */

export const ACCESS_TOKEN_AUDIENCE = 'urgent-consumer';

/** A second use of a just-rotated token this soon is a double click or a second tab, not theft. */
const ROTATION_GRACE_SECONDS = 10;

export interface AccessTokenPayload {
  sub: string;
  sid: string;
  aud: string;
  type: 'access';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** Seconds until the refresh token expires. */
  refreshExpiresIn: number;
  familyId: string;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  userAgent: string | null;
  ip: string | null;
  startedAt: Date;
  lastRefreshedAt: Date;
  expiresAt: Date;
}

interface SessionRow {
  id: string;
  user_id: string;
  family_id: string;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly businessConfig: BusinessConfigService,
    private readonly audit: AuthAuditService,
  ) {}

  /** Start a new login (a new family). */
  async create(userId: string, ctx: RequestContext = {}): Promise<TokenPair> {
    const familyId = randomUUID();
    const refreshToken = this.newRefreshToken();
    const refreshSeconds = await this.refreshSeconds();

    await this.prisma.$executeRaw`
      INSERT INTO auth_sessions (user_id, family_id, token_hash, user_agent, ip, expires_at)
      VALUES (
        ${userId}::uuid, ${familyId}::uuid, ${this.hashToken(refreshToken)},
        ${ctx.userAgent ?? null}, ${ctx.ip ?? null}::inet,
        now() + make_interval(secs => ${refreshSeconds})
      )
    `;

    return this.pair(userId, familyId, refreshToken, refreshSeconds);
  }

  /**
   * Exchange a refresh token for a new pair. Atomic: of two parallel requests with
   * the same token at most one succeeds.
   */
  async refresh(refreshToken: string, ctx: RequestContext = {}): Promise<TokenPair & { userId: string }> {
    const oldHash = this.hashToken(refreshToken);
    const newToken = this.newRefreshToken();
    const refreshSeconds = await this.refreshSeconds();

    const rotated = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<SessionRow[]>`
        UPDATE auth_sessions
        SET revoked_at = now(), replaced_by_token_hash = ${this.hashToken(newToken)}
        WHERE token_hash = ${oldHash}
          AND revoked_at IS NULL
          AND replaced_by_token_hash IS NULL
          AND expires_at > now()
        RETURNING id, user_id, family_id
      `;
      if (rows.length === 0) {
        return null;
      }

      const user = await tx.user.findFirst({
        where: { id: rows[0].user_id, deletedAt: null },
        select: { status: true },
      });
      if (!user || user.status === 'DELETED') {
        // Account is gone: the whole login ends here.
        await tx.$executeRaw`
          UPDATE auth_sessions SET revoked_at = now()
          WHERE family_id = ${rows[0].family_id}::uuid AND revoked_at IS NULL
        `;
        return 'gone' as const;
      }

      await tx.$executeRaw`
        INSERT INTO auth_sessions (user_id, family_id, token_hash, user_agent, ip, expires_at)
        VALUES (
          ${rows[0].user_id}::uuid, ${rows[0].family_id}::uuid, ${this.hashToken(newToken)},
          ${ctx.userAgent ?? null}, ${ctx.ip ?? null}::inet,
          now() + make_interval(secs => ${refreshSeconds})
        )
      `;
      return rows[0];
    });

    if (rotated === 'gone') {
      throw DomainException.of(AUTH_REQUIRED);
    }
    if (rotated) {
      const pair = await this.pair(rotated.user_id, rotated.family_id, newToken, refreshSeconds);
      return { ...pair, userId: rotated.user_id };
    }

    await this.handleRejectedRefresh(oldHash, ctx);
    throw DomainException.of(AUTH_REQUIRED);
  }

  /** End the login that owns this refresh token (logout). Unknown tokens are ignored. */
  async revokeByRefreshToken(refreshToken: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE auth_sessions SET revoked_at = now()
      WHERE revoked_at IS NULL
        AND family_id = (SELECT family_id FROM auth_sessions WHERE token_hash = ${this.hashToken(refreshToken)})
    `;
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE auth_sessions SET revoked_at = now()
      WHERE family_id = ${familyId}::uuid AND revoked_at IS NULL
    `;
  }

  /** Revoke one of the user's own sessions. Another user's id looks the same as an unknown one. */
  async revokeUserSession(userId: string, sessionId: string): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ family_id: string }>>`
      SELECT family_id FROM auth_sessions
      WHERE id = ${sessionId}::uuid AND user_id = ${userId}::uuid AND revoked_at IS NULL
    `;
    if (rows.length === 0) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    await this.revokeFamily(rows[0].family_id);
  }

  /** Revoke every login of a user, optionally keeping the current one. */
  async revokeAllForUser(userId: string, exceptFamilyId?: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE auth_sessions SET revoked_at = now()
      WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
        AND (${exceptFamilyId ?? null}::uuid IS NULL OR family_id <> ${exceptFamilyId ?? null}::uuid)
    `;
  }

  async list(userId: string, currentFamilyId?: string): Promise<SessionInfo[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        family_id: string;
        user_agent: string | null;
        ip: string | null;
        created_at: Date;
        expires_at: Date;
        started_at: Date;
      }>
    >`
      SELECT s.id, s.family_id, s.user_agent, host(s.ip) AS ip, s.created_at, s.expires_at,
             (SELECT min(f.created_at) FROM auth_sessions f WHERE f.family_id = s.family_id) AS started_at
      FROM auth_sessions s
      WHERE s.user_id = ${userId}::uuid AND s.revoked_at IS NULL AND s.expires_at > now()
      ORDER BY s.created_at DESC
    `;

    return rows.map((row) => ({
      id: row.id,
      current: row.family_id === currentFamilyId,
      userAgent: row.user_agent,
      ip: row.ip,
      startedAt: row.started_at,
      lastRefreshedAt: row.created_at,
      expiresAt: row.expires_at,
    }));
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.getOrThrow<string>('jwt.secret'),
        audience: ACCESS_TOKEN_AUDIENCE,
      });
      if (payload.type !== 'access' || !payload.sub || !payload.sid) {
        throw new Error('Wrong token shape');
      }
      return payload;
    } catch {
      throw DomainException.of(AUTH_REQUIRED);
    }
  }

  private async pair(
    userId: string,
    familyId: string,
    refreshToken: string,
    refreshSeconds: number,
  ): Promise<TokenPair> {
    const minutes = await this.businessConfig.get('ACCESS_TOKEN_MINUTES');
    const expiresIn = minutes * 60;
    const payload: Omit<AccessTokenPayload, 'aud'> = { sub: userId, sid: familyId, type: 'access' };

    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('jwt.secret'),
      audience: ACCESS_TOKEN_AUDIENCE,
      expiresIn,
    });

    return { accessToken, refreshToken, expiresIn, refreshExpiresIn: refreshSeconds, familyId };
  }

  /**
   * The presented refresh token was not usable. If it was already rotated long
   * enough ago it is a replay (stolen token): end the whole family.
   */
  private async handleRejectedRefresh(tokenHash: string, ctx: RequestContext): Promise<void> {
    const rows = await this.prisma.$queryRaw<
      Array<{ user_id: string; family_id: string; replaced: boolean; recent: boolean }>
    >`
      SELECT user_id, family_id,
             replaced_by_token_hash IS NOT NULL AS replaced,
             COALESCE(revoked_at > now() - make_interval(secs => ${ROTATION_GRACE_SECONDS}), false) AS recent
      FROM auth_sessions WHERE token_hash = ${tokenHash}
    `;
    const row = rows[0];
    if (!row || !row.replaced || row.recent) {
      return;
    }

    await this.revokeFamily(row.family_id);
    this.logger.warn(`Refresh token reuse detected, family ${row.family_id} revoked`);
    await this.audit.record({
      action: 'auth.refresh.reuse_detected',
      actorId: row.user_id,
      entityType: 'auth_session_family',
      entityId: row.family_id,
      ctx,
    });
  }

  private newRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private hashToken(token: string): string {
    return hmacSign(`refresh:${token}`, this.config.getOrThrow<string>('security.hmacSecret'));
  }

  private async refreshSeconds(): Promise<number> {
    return (await this.businessConfig.get('REFRESH_TOKEN_DAYS')) * 24 * 3600;
  }
}
