import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { PasswordService } from '../auth/password.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RESOURCE_CONFLICT, RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';
import type { AdminPermissionKey } from './admin.permissions.js';

export interface AdminView {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: AdminPermissionKey[];
}

/** Admin accounts. There is no public registration: admins are created by the CLI or by another admin. */
@Injectable()
export class AdminUserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
  ) {}

  /** Create an ACTIVE admin with the named roles. MFA is enrolled at the first login. */
  async create(input: { email: string; displayName: string; password: string; roles: string[] }): Promise<string> {
    const email = input.email.trim().toLowerCase();
    const roles = await this.prisma.client.adminRole.findMany({ where: { name: { in: input.roles } } });
    if (roles.length !== new Set(input.roles).size) {
      throw DomainException.of(RESOURCE_NOT_FOUND, { message: 'One of the roles does not exist.' });
    }
    if (await this.prisma.client.admin.findFirst({ where: { email } })) {
      throw DomainException.of(RESOURCE_CONFLICT, { message: 'An admin with this email already exists.' });
    }

    const passwordHash = await this.passwords.hash(input.password);
    const admin = await this.prisma.$transaction(async (tx) => {
      const created = await tx.admin.create({
        data: { email, displayName: input.displayName.trim(), passwordHash, status: 'ACTIVE' },
        select: { id: true },
      });
      await tx.adminRoleAssignment.createMany({
        data: roles.map((role) => ({ adminId: created.id, roleId: role.id })),
      });
      return created;
    });
    return admin.id;
  }

  findByEmail(email: string) {
    return this.prisma.client.admin.findFirst({ where: { email: email.trim().toLowerCase() } });
  }

  findById(id: string) {
    return this.prisma.client.admin.findFirst({ where: { id } });
  }

  /** Roles and permissions of an admin, read live so a permission change applies on the next request. */
  async rolesAndPermissions(adminId: string): Promise<{ roles: string[]; permissions: AdminPermissionKey[] }> {
    const rows = await this.prisma.$queryRaw<Array<{ role: string; permission: AdminPermissionKey | null }>>`
      SELECT r.name AS role, rp.permission_key AS permission
      FROM admin_role_assignments a
      JOIN admin_roles r ON r.id = a.role_id AND r.deleted_at IS NULL
      LEFT JOIN admin_role_permissions rp ON rp.role_id = r.id AND rp.deleted_at IS NULL
      WHERE a.admin_id = ${adminId}::uuid AND a.deleted_at IS NULL
    `;
    return {
      roles: [...new Set(rows.map((row) => row.role))],
      permissions: [...new Set(rows.flatMap((row) => (row.permission ? [row.permission] : [])))],
    };
  }

  async view(adminId: string): Promise<AdminView> {
    const admin = await this.findById(adminId);
    if (!admin) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    return { id: admin.id, email: admin.email, displayName: admin.displayName, ...(await this.rolesAndPermissions(adminId)) };
  }
}
