import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { AdminStatus } from '@prisma/client';
import * as argon2 from 'argon2';

@Injectable()
export class AdminUserService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new admin user
   * Used by CLI and super-admin endpoints
   */
  async createAdmin(email: string, password: string, roleIds: string[]) {
    // Hash password with Argon2id
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536, // 64 MB
      timeCost: 3,
      parallelism: 4,
    });

    // Create admin with role assignments in transaction
    const admin = await this.prisma.admin.create({
      data: {
        email,
        passwordHash,
        status: AdminStatus.ACTIVE,
        roleAssignments: {
          create: roleIds.map((roleId) => ({
            roleId,
            assignedBy: '00000000-0000-0000-0000-000000000000', // System
          })),
        },
      },
      include: {
        roleAssignments: {
          include: {
            role: true,
          },
        },
      },
    });

    return admin;
  }

  /**
   * Find admin by email
   */
  async findByEmail(email: string) {
    return this.prisma.admin.findUnique({
      where: { email, deletedAt: null },
      include: {
        roleAssignments: {
          include: {
            role: {
              include: {
                permissions: {
                  include: {
                    permission: true,
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  /**
   * Find admin by ID
   */
  async findById(id: string) {
    return this.prisma.admin.findUnique({
      where: { id, deletedAt: null },
      include: {
        roleAssignments: {
          include: {
            role: {
              include: {
                permissions: {
                  include: {
                    permission: true,
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  /**
   * Update admin status
   */
  async updateStatus(adminId: string, status: AdminStatus) {
    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
    });

    if (!admin) {
      throw new NotFoundException('Admin not found');
    }

    return this.prisma.admin.update({
      where: { id: adminId },
      data: { status },
    });
  }

  /**
   * Get all permissions for an admin (across all their roles)
   */
  async getAdminPermissions(adminId: string): Promise<string[]> {
    const admin = await this.findById(adminId);
    
    if (!admin) {
      return [];
    }

    const permissions = new Set<string>();
    
    for (const assignment of admin.roleAssignments) {
      for (const rolePermission of assignment.role.permissions) {
        permissions.add(rolePermission.permission.name);
      }
    }

    return Array.from(permissions);
  }
}
