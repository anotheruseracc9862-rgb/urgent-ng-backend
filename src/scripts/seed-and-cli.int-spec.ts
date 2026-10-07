import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as argon2 from 'argon2';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { ADMIN_PERMISSIONS } from '../admin/admin.permissions.js';
import { DEFAULTS } from '../config/business-config.defaults.js';

const run = (script: string, args: string[] = [], env: Record<string, string> = {}) =>
  // the shell splits on spaces, so quote any argument that contains one
  spawnSync('npx', ['tsx', script, ...args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))], {
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, ...env },
    timeout: 120_000,
  });

describe('seed script and admin:create (against the test database)', () => {
  const prisma = getTestPrisma();

  beforeEach(async () => {
    await cleanAll();
  });

  describe('prisma/seed.ts', () => {
    it('loads config defaults, products, roles, categories, prohibited items and policies', async () => {
      const result = run('prisma/seed.ts');

      expect(result.status).toBe(0);
      expect(await prisma.configValue.count()).toBe(Object.keys(DEFAULTS).length);
      expect(await prisma.commercialProduct.count()).toBe(3);
      expect(await prisma.priceVersion.count()).toBe(3);
      expect(await prisma.adminPermission.count()).toBe(ADMIN_PERMISSIONS.length);
      expect(await prisma.adminRole.count()).toBe(5);
      expect(await prisma.category.count()).toBe(5);
      expect(await prisma.prohibitedItemRule.count()).toBeGreaterThan(10);
      expect(await prisma.policyVersion.count()).toBe(7);
    });

    it('seeds the PRD categories with their location rules', async () => {
      run('prisma/seed.ts');

      const categories = await prisma.category.findMany({ orderBy: { sortOrder: 'asc' } });

      expect(categories.map((c) => [c.key, c.requiresPickup, c.requiresDestination])).toEqual([
        ['delivery', true, true],
        ['pickup', true, false],
        ['shopping_purchase', false, true],
        ['document', true, true],
        ['other', true, false],
      ]);
    });

    it('seeds the launch prices (verification free, Pro 5,000 naira, boost 1,000 naira)', async () => {
      run('prisma/seed.ts');

      const rows = await prisma.$queryRaw<Array<{ code: string; amount_kobo: bigint }>>`
        SELECT p.code, v.amount_kobo FROM price_versions v JOIN commercial_products p ON p.id = v.product_id ORDER BY p.code
      `;

      expect(rows.map((r) => [r.code, Number(r.amount_kobo)])).toEqual([
        ['PRIORITY_BOOST', 100000],
        ['RUNNER_PRO', 500000],
        ['VERIFICATION_FEE', 0],
      ]);
    });

    it('can run again without duplicating or overwriting an admin change', async () => {
      run('prisma/seed.ts');
      await prisma.$executeRaw`
        INSERT INTO config_values (key, value_json, version, effective_from)
        VALUES ('ERRAND_EXPIRY_HOURS', '48'::jsonb, 2, now())
      `;

      const second = run('prisma/seed.ts');

      expect(second.status).toBe(0);
      expect(await prisma.configValue.count()).toBe(Object.keys(DEFAULTS).length + 1);
      expect(await prisma.commercialProduct.count()).toBe(3);
      expect(await prisma.adminRolePermission.count()).toBe(
        (await prisma.adminRolePermission.findMany()).length,
      );
      expect(await prisma.policyVersion.count()).toBe(7);
      expect(await prisma.category.count()).toBe(5);
    });

    it('gives SUPER_ADMIN every permission and the other roles a subset', async () => {
      run('prisma/seed.ts');

      const counts = await prisma.$queryRaw<Array<{ name: string; n: bigint }>>`
        SELECT r.name, count(*) AS n FROM admin_roles r JOIN admin_role_permissions rp ON rp.role_id = r.id GROUP BY r.name
      `;
      const byName = Object.fromEntries(counts.map((c) => [c.name, Number(c.n)]));

      expect(byName.SUPER_ADMIN).toBe(ADMIN_PERMISSIONS.length);
      expect(byName.SUPPORT_AGENT).toBeLessThan(byName.SUPER_ADMIN);
      expect(byName.FINANCE).toBeLessThan(byName.SUPER_ADMIN);
    });
  });

  describe('npm run admin:create', () => {
    const create = (args: string[], env: Record<string, string> = {}) => run('src/scripts/admin-create.ts', args, env);

    it('creates an active super-admin with a generated password that works', async () => {
      run('prisma/seed.ts');

      const result = create(['--email', 'Boss@Urgent.NG', '--name', 'Ada Obi']);

      expect(result.status).toBe(0);
      const generated = /Generated password \(shown once\): (\S+)/.exec(result.stdout)?.[1];
      expect(generated).toBeDefined();
      const admin = await prisma.admin.findFirstOrThrow({ where: { email: 'boss@urgent.ng' } });
      expect(admin).toMatchObject({ displayName: 'Ada Obi', status: 'ACTIVE', mfaEnabled: false, mfaSecretEncrypted: null });
      expect(await argon2.verify(admin.passwordHash, generated!)).toBe(true);
      const assignments = await prisma.adminRoleAssignment.findMany({ include: { role: true } });
      expect(assignments.map((a) => a.role.name)).toEqual(['SUPER_ADMIN']);
    });

    it('uses ADMIN_PASSWORD when given and does not print it', async () => {
      run('prisma/seed.ts');

      const result = create(['--email', 'a@urgent.ng', '--name', 'A'], { ADMIN_PASSWORD: 'A-very-long-password-1' });

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('A-very-long-password-1');
      const admin = await prisma.admin.findFirstOrThrow({ where: { email: 'a@urgent.ng' } });
      expect(await argon2.verify(admin.passwordHash, 'A-very-long-password-1')).toBe(true);
    });

    it('can assign another role', async () => {
      run('prisma/seed.ts');

      create(['--email', 'f@urgent.ng', '--name', 'Fin', '--role', 'FINANCE']);

      const [assignment] = await prisma.adminRoleAssignment.findMany({ include: { role: true } });
      expect(assignment.role.name).toBe('FINANCE');
    });

    it('refuses a short ADMIN_PASSWORD, a duplicate, an unknown role and missing arguments', async () => {
      run('prisma/seed.ts');
      create(['--email', 'a@urgent.ng', '--name', 'A']);

      expect(create(['--email', 'b@urgent.ng', '--name', 'B'], { ADMIN_PASSWORD: 'short' }).status).toBe(1);
      expect(create(['--email', 'a@urgent.ng', '--name', 'A']).status).toBe(1);
      expect(create(['--email', 'c@urgent.ng', '--name', 'C', '--role', 'NOPE']).status).toBe(1);
      expect(create(['--name', 'No Email']).status).toBe(1);
      expect(create(['--email', 'not-an-email', '--name', 'X']).status).toBe(1);
      expect(await prisma.admin.count()).toBe(1);
    });

    it('fails clearly when the roles were never seeded', async () => {
      const result = create(['--email', 'a@urgent.ng', '--name', 'A']);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('prisma:seed');
    });
  });
});
