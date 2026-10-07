/**
 * Create an admin account (Backend PRD 24.1: no public admin registration; the first
 * super-admin is created by this one-off command).
 *
 *   npm run admin:create -- --email admin@urgent.ng --name "Ada Obi"
 *   npm run admin:create -- --email support@urgent.ng --name "Tunde" --role SUPPORT_AGENT
 *
 * The password comes from ADMIN_PASSWORD (12+ characters). If it is not set, a random
 * one is generated and printed once. Run `npm run prisma:seed` first so the roles exist.
 * The admin enrols an authenticator app (TOTP) at the first login: MFA is mandatory.
 */

import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { config as loadDotenv } from 'dotenv';
import { ARGON_OPTIONS } from '../auth/argon.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  loadDotenv({ quiet: true });

  const email = arg('email')?.trim().toLowerCase();
  const displayName = arg('name')?.trim();
  const roleName = arg('role') ?? 'SUPER_ADMIN';
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !displayName) {
    throw new Error('Usage: npm run admin:create -- --email <email> --name "<display name>" [--role SUPER_ADMIN]');
  }

  const supplied = process.env.ADMIN_PASSWORD;
  if (supplied !== undefined && supplied.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  }
  const password = supplied ?? randomBytes(15).toString('base64url');

  const prisma = new PrismaClient();
  try {
    const role = await prisma.adminRole.findFirst({ where: { name: roleName, deletedAt: null } });
    if (!role) {
      throw new Error(`Role ${roleName} does not exist. Run "npm run prisma:seed" first.`);
    }
    if (await prisma.admin.findFirst({ where: { email, deletedAt: null } })) {
      throw new Error(`An admin with email ${email} already exists.`);
    }

    const passwordHash = await argon2.hash(password, ARGON_OPTIONS);
    const admin = await prisma.admin.create({
      data: { email, displayName, passwordHash, status: 'ACTIVE' },
      select: { id: true },
    });
    await prisma.adminRoleAssignment.create({ data: { adminId: admin.id, roleId: role.id } });

    console.log(`Admin created: ${email} (${roleName})`);
    if (supplied === undefined) {
      console.log(`Generated password (shown once): ${password}`);
    }
    console.log('At the first login the admin sets up an authenticator app (TOTP).');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
