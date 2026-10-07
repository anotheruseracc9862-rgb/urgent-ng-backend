import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { BusinessConfigService } from '../config/business-config.service.js';
import { hmacSign } from '../common/utils/crypto.helper.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { AUTH_REQUIRED } from '../common/constants/error-codes.js';
import type { AdminRequestContext } from './admin-auth-event.service.js';
import { AdminAuthEventService } from './admin-auth-event.service.js';

/**
 * Admin sessions (Backend PRD 24.1): the same rotating-refresh design as consumer
 * sessions, but a separate signing key, audience (`urgent-admin`), cookies and table, and
 * a session is only created after MFA. Admin sessions are shorter (ADMIN_SESSION_HOURS).
 */
export const ADMIN_AUDIENCE = 'urgent-admin';
export const ADMIN_MFA_AUDIENCE = 'urgent-admin-mfa';
const MFA_TOKEN_SECONDS = 5 * 60;
const ROTATION_GRACE_SECONDS = 10;

export interface AdminTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
}

export interface AdminAccessPayload {
  sub: string;
  sid: string;
  aud: string;
  type: 'admin-access';
}

@Injectable()
export class AdminSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly businessConfig: BusinessConfigService,
    private readonly events: AdminAuthEventService,
  ) {}

  /** A short-lived token that proves the password step passed. It only works on the MFA endpoints. */
  signMfaToken(adminId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: adminId, type: 'admin-mfa' },
      { secret: this.secret(), audience: ADMIN_MFA_AUDIENCE, expiresIn: MFA_TOKEN_SECONDS },
    );
  }

  async verifyMfaToken(token: string): Promise<string> {
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; type: string }>(token, {
        secret: this.secret(),
        audience: ADMIN_MFA_AUDIENCE,
      });
      if (payload.type !== 'admin-mfa' || !payload.sub) {
        throw new Error('wrong token');
      }
      return payload.sub;
    } catch {
      throw DomainException.of(AUTH_REQUIRED);
    }
  }

  /** New login (after password and MFA). */
  async create(adminId: string, ctx: AdminRequestContext): Promise<AdminTokenPair & { familyId: string }> {
    const familyId = randomUUID();
    const refreshToken = this.newToken();
    const refreshSeconds = await this.refreshSeconds();

    await this.prisma.$executeRaw`
      INSERT INTO admin_sessions (admin_id, family_id, token_hash, user_agent, ip, mfa_verified_at, expires_at)
      VALUES (${adminId}::uuid, ${familyId}::uuid, ${this.hash(refreshToken)}, ${ctx.userAgent ?? null},
              ${ctx.ip ?? null}::inet, now(), now() + make_interval(secs => ${refreshSeconds}))
    `;
    return { ...(await this.pair(adminId, familyId, refreshToken, refreshSeconds)), familyId };
  }

  async refresh(refreshToken: string, ctx: AdminRequestContext): Promise<AdminTokenPair> {
    const oldHash = this.hash(refreshToken);
    const newToken = this.newToken();
    const refreshSeconds = await this.refreshSeconds();

    const rotated = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ admin_id: string; family_id: string }>>`
        UPDATE admin_sessions s
        SET revoked_at = now(), replaced_by_token_hash = ${this.hash(newToken)}
        WHERE s.token_hash = ${oldHash} AND s.revoked_at IS NULL AND s.replaced_by_token_hash IS NULL
          AND s.expires_at > now()
          AND EXISTS (SELECT 1 FROM admins a WHERE a.id = s.admin_id AND a.status = 'ACTIVE'::"AdminStatus" AND a.deleted_at IS NULL)
        RETURNING s.admin_id, s.family_id
      `;
      if (rows.length === 0) {
        return null;
      }
      await tx.$executeRaw`
        INSERT INTO admin_sessions (admin_id, family_id, token_hash, user_agent, ip, mfa_verified_at, expires_at)
        VALUES (${rows[0].admin_id}::uuid, ${rows[0].family_id}::uuid, ${this.hash(newToken)}, ${ctx.userAgent ?? null},
                ${ctx.ip ?? null}::inet, now(), now() + make_interval(secs => ${refreshSeconds}))
      `;
      return rows[0];
    });

    if (!rotated) {
      await this.handleRejectedRefresh(oldHash, ctx);
      throw DomainException.of(AUTH_REQUIRED);
    }
    return this.pair(rotated.admin_id, rotated.family_id, newToken, refreshSeconds);
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE admin_sessions SET revoked_at = now() WHERE family_id = ${familyId}::uuid AND revoked_at IS NULL
    `;
  }

  async revokeAllForAdmin(adminId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = ${adminId}::uuid AND revoked_at IS NULL
    `;
  }

  async revokeByRefreshToken(refreshToken: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE admin_sessions SET revoked_at = now()
      WHERE revoked_at IS NULL
        AND family_id = (SELECT family_id FROM admin_sessions WHERE token_hash = ${this.hash(refreshToken)})
    `;
  }

  /** True while the login (family) has a live, un-revoked, un-expired session row. */
  async isFamilyActive(familyId: string, adminId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ one: number }>>`
      SELECT 1 AS one FROM admin_sessions
      WHERE family_id = ${familyId}::uuid AND admin_id = ${adminId}::uuid
        AND revoked_at IS NULL AND expires_at > now()
      LIMIT 1
    `;
    return rows.length > 0;
  }

  async verifyAccessToken(token: string): Promise<AdminAccessPayload> {
    try {
      const payload = await this.jwt.verifyAsync<AdminAccessPayload>(token, {
        secret: this.secret(),
        audience: ADMIN_AUDIENCE,
      });
      if (payload.type !== 'admin-access' || !payload.sub || !payload.sid) {
        throw new Error('wrong token');
      }
      return payload;
    } catch {
      throw DomainException.of(AUTH_REQUIRED);
    }
  }

  private async pair(
    adminId: string,
    familyId: string,
    refreshToken: string,
    refreshSeconds: number,
  ): Promise<AdminTokenPair> {
    const expiresIn = Math.min(await this.businessConfig.get('ACCESS_TOKEN_MINUTES'), 15) * 60;
    const accessToken = await this.jwt.signAsync(
      { sub: adminId, sid: familyId, type: 'admin-access' },
      { secret: this.secret(), audience: ADMIN_AUDIENCE, expiresIn },
    );
    return { accessToken, refreshToken, expiresIn, refreshExpiresIn: refreshSeconds };
  }

  private async handleRejectedRefresh(tokenHash: string, ctx: AdminRequestContext): Promise<void> {
    const rows = await this.prisma.$queryRaw<
      Array<{ admin_id: string; family_id: string; replaced: boolean; recent: boolean }>
    >`
      SELECT admin_id, family_id, replaced_by_token_hash IS NOT NULL AS replaced,
             COALESCE(revoked_at > now() - make_interval(secs => ${ROTATION_GRACE_SECONDS}), false) AS recent
      FROM admin_sessions WHERE token_hash = ${tokenHash}
    `;
    const row = rows[0];
    if (!row || !row.replaced || row.recent) {
      return;
    }
    await this.revokeFamily(row.family_id);
    await this.events.record({ event: 'TOKEN_REUSE', adminId: row.admin_id, ctx });
  }

  private secret(): string {
    return this.config.getOrThrow<string>('jwt.adminSecret');
  }

  private newToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private hash(token: string): string {
    return hmacSign(`admin-refresh:${token}`, this.config.getOrThrow<string>('security.hmacSecret'));
  }

  private async refreshSeconds(): Promise<number> {
    return (await this.businessConfig.get('ADMIN_SESSION_HOURS')) * 3600;
  }
}
