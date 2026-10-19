import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { AuditActorType, Prisma, type AdminStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PrismaService } from '../../database/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { Paginated } from '../../common/pagination/paginated.js';
import { PaginationQueryDto } from '../../common/pagination/pagination.dto.js';
import { DomainException } from '../../common/exceptions/domain.exception.js';
import { FORBIDDEN, RESOURCE_CONFLICT, RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../../common/constants/error-codes.js';
import { hmacSign } from '../../common/utils/crypto.helper.js';
import { EMAIL_PROVIDER, type IEmailProvider } from '../../common/providers/email.provider.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ApiEnveloped, ApiErrors } from '../../common/api/api-docs.js';
import { ReqCtx } from '../../auth/decorators/request-context.decorator.js';
import type { RequestContext } from '../../auth/auth-audit.service.js';
import { PasswordService } from '../../auth/password.service.js';
import { AdminAuth, CurrentAdmin, type AuthenticatedAdmin } from '../../admin/decorators/admin-auth.decorator.js';
import { AdminSessionService } from '../../admin/admin-session.service.js';
import { AdminUserService } from '../../admin/admin-user.service.js';
import { ADMIN_PERMISSIONS } from '../../admin/admin.permissions.js';
import { AdminActionService } from '../../admin/framework/admin-action.service.js';
import { AdminActionDto } from '../../admin/framework/admin-reasons.js';
import { ApprovalService } from '../../admin/framework/approval.service.js';
import { AdminPager, likePattern } from '../common/admin-page.js';
import { AnyObjectDto } from '../common/any-object.dto.js';
import { renderEmail } from '../../notifications/email/email-layout.js';
import { emailBrand } from '../../notifications/email/email-brand.js';
import { adminInviteEmail } from '../../notifications/email/email-messages.js';

const INVITE_HOURS = 72;
const SUPER_ADMIN = 'SUPER_ADMIN';

// ---- DTOs ----

export class AdminListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'INVITED'] })
  @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'INVITED']) status?: AdminStatus;
  @ApiPropertyOptional({ maxLength: 80 }) @IsOptional() @IsString() @MaxLength(80) q?: string;
}

export class InviteAdminDto extends AdminActionDto {
  @ApiProperty() @IsEmail() @MaxLength(255) email!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(100) displayName!: string;
}

export class AcceptInviteDto {
  @ApiProperty() @IsString() @MinLength(20) @MaxLength(200) token!: string;
  @ApiProperty({ minLength: 12 }) @IsString() @MinLength(12) @MaxLength(128) password!: string;
}

export class SetRolesDto extends AdminActionDto {
  @ApiProperty({ type: String, isArray: true, description: 'The admin\'s complete set of roles. A second admin approves the change.' })
  @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) roles!: string[];
}

export class CreateRoleDto extends AdminActionDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(50) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) description?: string;
}

export class SetRolePermissionsDto extends AdminActionDto {
  @ApiProperty({ enum: ADMIN_PERMISSIONS, isArray: true, description: 'The role\'s complete set of permissions. A second admin approves the change.' })
  @IsArray() @IsIn(ADMIN_PERMISSIONS as unknown as string[], { each: true }) permissions!: string[];
}

export class AdminAccountDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'INVITED'] }) status!: string;
  @ApiProperty() mfaEnabled!: boolean;
  @ApiProperty({ nullable: true, type: Date }) lastLoginAt!: Date | null;
  @ApiProperty({ type: String, isArray: true }) roles!: string[];
  @ApiProperty({ type: Date }) createdAt!: Date;
}

// ---- Service ----

@Injectable()
export class AdminAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pager: AdminPager,
    private readonly appConfig: ConfigService,
    private readonly passwords: PasswordService,
    private readonly users: AdminUserService,
    private readonly sessions: AdminSessionService,
    private readonly audit: AuditService,
    @Inject(EMAIL_PROVIDER) private readonly email: IEmailProvider,
  ) {}

  private inviteHash(token: string): string {
    return hmacSign(`admin-invite:${token}`, this.appConfig.getOrThrow<string>('security.hmacSecret'));
  }

  async list(q: { status?: AdminStatus; q?: string; cursor?: string; limit?: number }): Promise<Paginated<AdminAccountDto>> {
    const limit = q.limit ?? 20;
    const after = this.pager.after(q.cursor);
    const c: Prisma.Sql[] = [Prisma.sql`a.deleted_at IS NULL`];
    if (q.status) c.push(Prisma.sql`a.status = ${q.status}::"AdminStatus"`);
    if (q.q?.trim()) c.push(Prisma.sql`(a.email ILIKE ${likePattern(q.q)} OR a.display_name ILIKE ${likePattern(q.q)})`);
    if (after) c.push(Prisma.sql`(a.created_at, a.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`);
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; email: string; display_name: string; status: string; mfa_enabled: boolean; last_login_at: Date | null; created_at: Date; roles: string[] | null }>
    >`
      SELECT a.id::text AS id, a.email, a.display_name, a.status::text AS status, a.mfa_enabled, a.last_login_at, a.created_at,
             (SELECT array_agg(r.name ORDER BY r.name) FROM admin_role_assignments x JOIN admin_roles r ON r.id = x.role_id
               WHERE x.admin_id = a.id AND x.deleted_at IS NULL AND r.deleted_at IS NULL) AS roles
      FROM admins a WHERE ${Prisma.join(c, ' AND ')}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit + 1}
    `;
    return this.pager.page(rows.map((r) => ({ ...r, createdAt: r.created_at })), limit, (r): AdminAccountDto => ({
      id: r.id, email: r.email, displayName: r.display_name, status: r.status, mfaEnabled: r.mfa_enabled,
      lastLoginAt: r.last_login_at, roles: r.roles ?? [], createdAt: r.created_at,
    }));
  }

  async detail(adminId: string) {
    const admin = await this.prisma.client.admin.findFirst({ where: { id: adminId } });
    if (!admin) throw DomainException.of(RESOURCE_NOT_FOUND);
    const { roles, permissions } = await this.users.rolesAndPermissions(adminId);
    const sessions = await this.prisma.adminSession.count({ where: { adminId, revokedAt: null, expiresAt: { gt: new Date() } } });
    return {
      id: admin.id,
      email: admin.email,
      displayName: admin.displayName,
      status: admin.status,
      mfaEnabled: admin.mfaEnabled,
      lastLoginAt: admin.lastLoginAt,
      lockedUntil: admin.lockedUntil,
      invitePending: admin.inviteTokenHash !== null,
      inviteExpiresAt: admin.inviteExpiresAt,
      roles,
      permissions,
      activeSessions: sessions,
      createdAt: admin.createdAt,
    };
  }

  /**
   * Invite an admin. The account exists with NO roles and cannot sign in until the invitation is
   * accepted; roles are a separate change that a second admin approves. The token is returned once
   * and emailed; only a keyed hash is kept.
   */
  async invite(input: { email: string; displayName: string }, invitedBy: string) {
    const email = input.email.trim().toLowerCase();
    if (await this.prisma.client.admin.findFirst({ where: { email } })) {
      throw DomainException.of(RESOURCE_CONFLICT, { message: 'An admin with this email already exists.' });
    }
    const token = randomBytes(32).toString('base64url');
    const unusable = await this.passwords.hash(randomBytes(32).toString('hex'));
    const created = await this.prisma.$queryRaw<Array<{ id: string; expires: Date }>>`
      INSERT INTO admins (email, display_name, password_hash, status, invite_token_hash, invite_expires_at, invited_by, updated_at)
      VALUES (${email}, ${input.displayName.trim()}, ${unusable}, 'INVITED'::"AdminStatus", ${this.inviteHash(token)},
              clock_timestamp() + make_interval(hours => ${INVITE_HOURS}::int), ${invitedBy}::uuid, clock_timestamp())
      RETURNING id::text, invite_expires_at AS expires
    `;
    const base = this.appConfig.get<string>('ADMIN_APP_URL') ?? process.env.ADMIN_APP_URL ?? '';
    const link = base ? `${base.replace(/\/$/, '')}/accept-invite?token=${token}` : null;
    const message = renderEmail(adminInviteEmail({ link, token, hours: INVITE_HOURS }), emailBrand());
    await this.email
      .send({ to: email, subject: message.subject, text: message.text, html: message.html })
      .catch(() => undefined);
    return { adminId: created[0].id, inviteToken: token, expiresAt: created[0].expires, emailed: true };
  }

  /** The invitee sets a password. The account becomes ACTIVE; MFA is enrolled at the first sign-in. */
  async acceptInvite(token: string, password: string): Promise<{ adminId: string }> {
    const hash = this.inviteHash(token);
    const admin = await this.prisma.client.admin.findFirst({ where: { inviteTokenHash: hash } });
    if (!admin || admin.status !== 'INVITED' || !admin.inviteExpiresAt || admin.inviteExpiresAt.getTime() < Date.now()) {
      throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'This invitation is not valid.' });
    }
    const passwordHash = await this.passwords.hash(password);
    const done = await this.prisma.$executeRaw`
      UPDATE admins SET password_hash = ${passwordHash}, status = 'ACTIVE'::"AdminStatus", invite_token_hash = NULL, invite_expires_at = NULL,
             updated_at = clock_timestamp()
      WHERE id = ${admin.id}::uuid AND invite_token_hash = ${hash} AND status = 'INVITED'::"AdminStatus"
    `;
    if (done === 0) throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'This invitation is not valid.' });
    await this.audit.record({ actorType: AuditActorType.ADMIN, actorId: admin.id, action: 'admin.invite_accepted', entityType: 'admin', entityId: admin.id });
    return { adminId: admin.id };
  }

  // ---- roles ----

  async roles() {
    const roles = await this.prisma.adminRole.findMany({
      where: { deletedAt: null },
      include: { permissions: { where: { deletedAt: null }, select: { permissionKey: true } }, assignments: { where: { deletedAt: null }, select: { adminId: true } } },
      orderBy: { name: 'asc' },
    });
    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      permissions: r.permissions.map((p) => p.permissionKey).sort(),
      admins: new Set(r.assignments.map((a) => a.adminId)).size,
    }));
  }

  async createRole(name: string, description?: string) {
    const key = name.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
    if (key.length < 3) throw DomainException.of(VALIDATION_ERROR, { message: 'Give the role a name.', details: { field: 'name' } });
    if (await this.prisma.adminRole.findFirst({ where: { name: key } })) {
      throw DomainException.of(RESOURCE_CONFLICT, { message: 'A role with this name already exists.' });
    }
    const role = await this.prisma.adminRole.create({ data: { name: key, description: description?.trim() || null } });
    return { id: role.id, name: role.name, description: role.description, permissions: [] as string[], admins: 0 };
  }

  async requireRole(roleId: string) {
    const role = await this.prisma.adminRole.findFirst({ where: { id: roleId, deletedAt: null } });
    if (!role) throw DomainException.of(RESOURCE_NOT_FOUND);
    return role;
  }

  async requireAdmin(adminId: string) {
    const admin = await this.prisma.client.admin.findFirst({ where: { id: adminId } });
    if (!admin) throw DomainException.of(RESOURCE_NOT_FOUND);
    return admin;
  }

  /** At least one active SUPER_ADMIN must remain: nobody can lock the console by removing the last one. */
  async assertSuperAdminRemains(exceptAdminId?: string, removingRoleId?: string): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(DISTINCT a.id)::int AS n
      FROM admins a
      JOIN admin_role_assignments x ON x.admin_id = a.id AND x.deleted_at IS NULL
      JOIN admin_roles r ON r.id = x.role_id AND r.deleted_at IS NULL AND r.name = ${SUPER_ADMIN}
      WHERE a.status = 'ACTIVE'::"AdminStatus" AND a.deleted_at IS NULL
        AND (${exceptAdminId ?? null}::uuid IS NULL OR a.id <> ${exceptAdminId ?? null}::uuid)
        AND (${removingRoleId ?? null}::uuid IS NULL OR r.id <> ${removingRoleId ?? null}::uuid)
    `;
    if ((rows[0]?.n ?? 0) === 0) {
      throw DomainException.of(RESOURCE_CONFLICT, { message: 'There must always be at least one active super admin.', details: { reason: 'LAST_SUPER_ADMIN' } });
    }
  }

  /** Replace an admin's roles. Run by the approval executor, after a second admin approved. */
  async applyRoles(adminId: string, roleNames: string[], byAdminId: string) {
    const admin = await this.requireAdmin(adminId);
    const roles = await this.prisma.adminRole.findMany({ where: { name: { in: roleNames }, deletedAt: null } });
    if (roles.length !== new Set(roleNames).size) {
      throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'One of the roles does not exist.' });
    }
    const current = await this.users.rolesAndPermissions(adminId);
    if (current.roles.includes(SUPER_ADMIN) && !roleNames.includes(SUPER_ADMIN)) {
      await this.assertSuperAdminRemains(adminId);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.adminRoleAssignment.updateMany({
        where: { adminId, deletedAt: null, roleId: { notIn: roles.map((r) => r.id) } },
        data: { deletedAt: new Date() },
      });
      const kept = await tx.adminRoleAssignment.findMany({ where: { adminId, deletedAt: null }, select: { roleId: true } });
      const have = new Set(kept.map((k) => k.roleId));
      const add = roles.filter((r) => !have.has(r.id));
      if (add.length > 0) await tx.adminRoleAssignment.createMany({ data: add.map((r) => ({ adminId, roleId: r.id })) });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.ADMIN,
        actorId: byAdminId,
        action: 'admin.roles_changed',
        entityType: 'admin',
        entityId: adminId,
        metadata: { roles: roleNames, before: current.roles, email: admin.email },
      });
    });
    return { adminId, roles: roleNames };
  }

  /** Replace a role's permissions. Run by the approval executor. */
  async applyRolePermissions(roleId: string, permissions: string[], byAdminId: string) {
    const role = await this.requireRole(roleId);
    const known = new Set<string>(ADMIN_PERMISSIONS);
    const unknown = permissions.filter((p) => !known.has(p));
    if (unknown.length > 0) throw DomainException.of(VALIDATION_ERROR, { message: 'Unknown permission.', details: { unknown } });
    if (role.name === SUPER_ADMIN && permissions.length !== ADMIN_PERMISSIONS.length) {
      throw DomainException.of(FORBIDDEN, { message: 'SUPER_ADMIN always holds every permission.' });
    }
    const wanted = new Set(permissions);
    await this.prisma.$transaction(async (tx) => {
      await tx.adminRolePermission.updateMany({ where: { roleId, deletedAt: null, permissionKey: { notIn: [...wanted] } }, data: { deletedAt: new Date() } });
      const have = new Set((await tx.adminRolePermission.findMany({ where: { roleId, deletedAt: null }, select: { permissionKey: true } })).map((p) => p.permissionKey));
      const add = [...wanted].filter((p) => !have.has(p));
      if (add.length > 0) await tx.adminRolePermission.createMany({ data: add.map((permissionKey) => ({ roleId, permissionKey })) });
      await this.audit.recordInTransaction(tx, {
        actorType: AuditActorType.ADMIN,
        actorId: byAdminId,
        action: 'admin.role_permissions_changed',
        entityType: 'admin_role',
        entityId: roleId,
        metadata: { role: role.name, permissions: [...wanted].sort() },
      });
    });
    return { roleId, permissions: [...wanted].sort() };
  }

  async resetMfa(adminId: string, byAdminId: string) {
    if (adminId === byAdminId) throw DomainException.of(FORBIDDEN, { message: 'Another admin must reset your MFA.' });
    await this.requireAdmin(adminId);
    await this.prisma.$executeRaw`
      UPDATE admins SET mfa_enabled = FALSE, mfa_secret_encrypted = NULL, updated_at = clock_timestamp() WHERE id = ${adminId}::uuid
    `;
    await this.sessions.revokeAllForAdmin(adminId);
    return { adminId, mfaEnabled: false };
  }

  async revokeSessions(adminId: string) {
    await this.requireAdmin(adminId);
    await this.sessions.revokeAllForAdmin(adminId);
    return { adminId, revoked: true };
  }

  async setStatus(adminId: string, to: 'ACTIVE' | 'DEACTIVATED', byAdminId: string) {
    const admin = await this.requireAdmin(adminId);
    if (to === 'DEACTIVATED') {
      if (adminId === byAdminId) throw DomainException.of(FORBIDDEN, { message: 'You cannot deactivate your own account.' });
      const { roles } = await this.users.rolesAndPermissions(adminId);
      if (roles.includes(SUPER_ADMIN)) await this.assertSuperAdminRemains(adminId);
      if (admin.status === 'DEACTIVATED') throw DomainException.of(RESOURCE_CONFLICT, { message: 'This admin is already deactivated.' });
    } else if (admin.status !== 'DEACTIVATED') {
      throw DomainException.of(RESOURCE_CONFLICT, { message: 'Only a deactivated admin can be reactivated.' });
    }
    await this.prisma.$executeRaw`
      UPDATE admins SET status = ${to}::"AdminStatus", deactivated_at = ${to === 'DEACTIVATED' ? new Date() : null}::timestamptz,
             updated_at = clock_timestamp()
      WHERE id = ${adminId}::uuid
    `;
    if (to === 'DEACTIVATED') await this.sessions.revokeAllForAdmin(adminId);
    return { adminId, status: to };
  }
}

// ---- Controller ----

/** Admin accounts (Backend PRD 24.4 area 20). Role and permission changes need a second admin. */
@ApiTags('Admin accounts')
@Controller('admin')
export class AdminAccountsController {
  constructor(
    private readonly service: AdminAccountsService,
    private readonly approvals: ApprovalService,
    private readonly actions: AdminActionService,
  ) {}

  /** Public: the invitee sets a password with the one-time token from the invitation. */
  @Post('auth/accept-invite')
  @HttpCode(200)
  @RateLimit('auth')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 404, 429)
  accept(@Body() dto: AcceptInviteDto) {
    return this.service.acceptInvite(dto.token, dto.password);
  }

  @Get('admins')
  @AdminAuth('ADMIN_ACCOUNTS_MANAGE')
  @ApiEnveloped(AdminAccountDto, { isArray: true })
  @ApiErrors(400, 403)
  list(@Query() query: AdminListQueryDto) {
    return this.service.list(query);
  }

  @Get('admins/:id')
  @AdminAuth('ADMIN_ACCOUNTS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(403, 404)
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }

  @Post('admins/invite')
  @AdminAuth('ADMIN_ACCOUNTS_MANAGE')
  @ApiEnveloped(AnyObjectDto, { status: 201 })
  @ApiErrors(400, 403, 409)
  invite(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: InviteAdminDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'admin.invite',
      entityType: 'admin',
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { email: dto.email.toLowerCase() },
      execute: () => this.service.invite(dto, admin.adminId),
    });
  }

  /** Ask to set an admin's roles. A second admin approves; the roles apply then. */
  @Put('admins/:id/roles')
  @HttpCode(200)
  @AdminAuth('ADMIN_ACCOUNTS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  async setRoles(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetRolesDto, @ReqCtx() ctx: RequestContext) {
    const target = await this.service.requireAdmin(id);
    return {
      approvalRequired: true,
      approval: await this.approvals.request(
        admin,
        {
          kind: 'ADMIN_ROLE_CHANGE',
          reason: { code: dto.reasonCode, text: dto.reasonText },
          summary: `Set the roles of ${target.email} to ${dto.roles.join(', ') || 'none'}`,
          targetType: 'admin',
          targetId: id,
          payload: { type: 'ADMIN_ROLES', adminId: id, roles: dto.roles },
        },
        ctx,
      ),
    };
  }

  @Get('roles')
  @AdminAuth('ADMIN_ACCOUNTS_MANAGE')
  @ApiEnveloped(AnyObjectDto, { isArray: true })
  roles() {
    return this.service.roles();
  }

  /** A new role starts with no permissions; they are set through an approved change. */
  @Post('roles')
  @AdminAuth('ADMIN_ACCOUNTS_MANAGE')
  @ApiEnveloped(AnyObjectDto, { status: 201 })
  @ApiErrors(400, 403, 409)
  createRole(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: CreateRoleDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'admin_role.create',
      entityType: 'admin_role',
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.service.createRole(dto.name, dto.description),
    });
  }

  @Put('roles/:id/permissions')
  @HttpCode(200)
  @AdminAuth('ADMIN_ACCOUNTS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  async setRolePermissions(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetRolePermissionsDto, @ReqCtx() ctx: RequestContext) {
    const role = await this.service.requireRole(id);
    return {
      approvalRequired: true,
      approval: await this.approvals.request(
        admin,
        {
          kind: 'ADMIN_ROLE_CHANGE',
          reason: { code: dto.reasonCode, text: dto.reasonText },
          summary: `Set the permissions of the role ${role.name} (${dto.permissions.length} permissions)`,
          targetType: 'admin_role',
          targetId: id,
          payload: { type: 'ROLE_PERMISSIONS', roleId: id, permissions: dto.permissions },
        },
        ctx,
      ),
    };
  }

  @Post('admins/:id/reset-mfa')
  @HttpCode(200)
  @AdminAuth('ADMIN_ACCOUNTS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  resetMfa(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'admin.reset_mfa',
      entityType: 'admin',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.service.resetMfa(id, admin.adminId),
    });
  }

  @Post('admins/:id/revoke-sessions')
  @HttpCode(200)
  @AdminAuth('ADMIN_ACCOUNTS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  revokeSessions(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'admin.revoke_sessions',
      entityType: 'admin',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.service.revokeSessions(id),
    });
  }

  @Post('admins/:id/deactivate')
  @HttpCode(200)
  @AdminAuth('ADMIN_ACCOUNTS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  deactivate(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'admin.deactivate',
      entityType: 'admin',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.service.setStatus(id, 'DEACTIVATED', admin.adminId),
    });
  }

  @Post('admins/:id/reactivate')
  @HttpCode(200)
  @AdminAuth('ADMIN_ACCOUNTS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  reactivate(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'admin.reactivate',
      entityType: 'admin',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.service.setStatus(id, 'ACTIVE', admin.adminId),
    });
  }
}

