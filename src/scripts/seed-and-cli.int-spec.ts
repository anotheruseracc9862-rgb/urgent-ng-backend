import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as argon2 from 'argon2';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import { ADMIN_PERMISSIONS } from '../admin/admin.permissions.js';
import { DEFAULTS } from '../config/business-config.defaults.js';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../test/app.factory.js';
import { API, bearer } from '../test/auth.helper.js';
import { demoId, demoRequesters, demoRunners, DEMO_PASSWORD, errandId } from '../../prisma/seed/demo-data.js';

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

  describe('local demo seed', () => {
    const seed = (stage?: string, env: Record<string, string> = {}) => run('prisma/seed/demo.ts', stage ? ['--stage', stage] : [], env);

    it('refuses production, remote databases and identifier collisions without touching existing accounts', async () => {
      expect(seed(undefined, { NODE_ENV: 'production' }).stderr).toContain('Refusing demo seed');
      const remote = new URL(process.env.DATABASE_URL!);
      remote.hostname = 'never-connect.example.test';
      expect(seed(undefined, { DATABASE_URL: remote.toString() }).stderr).toContain('Refusing demo seed');
      expect(await prisma.user.count()).toBe(0);
      const unrelated = await prisma.user.create({ data: { name: 'Existing user', firstName: 'Existing', lastName: 'User', email: demoRunners[0].email, passwordHash: 'not-a-demo-hash' } });
      const collision = seed();
      expect(collision.status, collision.stderr).toBe(1);
      expect(collision.stderr).toContain('belongs to a different');
      expect(await prisma.user.count()).toBe(1);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: unrelated.id } })).passwordHash).toBe('not-a-demo-hash');
      expect(await prisma.errand.count()).toBe(0);
    }, 120_000);

    it('seeds all stages, supports real logins and journeys, and preserves tester changes on rerun', async () => {
      let result = seed('accounts');
      expect(result.status, result.stderr).toBe(0);
      expect(await prisma.user.count()).toBe(20);
      expect(await prisma.runnerProfile.count()).toBe(10);
      expect(await prisma.verificationAttempt.count({ where: { status: 'VERIFIED' } })).toBe(20);
      expect(await prisma.errand.count()).toBe(0);
      result = seed('errands');
      expect(result.status, result.stderr).toBe(0);
      expect(await prisma.errand.count()).toBe(110);
      expect(await prisma.assignment.count({ where: { status: 'COMPLETED' } })).toBe(40);
      expect(await prisma.rating.count()).toBe(0);
      result = seed('activity');
      expect(result.status, result.stderr).toBe(0);
      expect(await prisma.rating.count()).toBe(60);
      expect(await prisma.conversation.count()).toBe(100);
      expect(await prisma.message.count()).toBe(200);
      expect(await prisma.notification.count()).toBe(80);
      expect(await prisma.outboxEvent.count()).toBe(0);
      expect(await prisma.notificationDelivery.count({ where: { channel: { not: 'IN_APP' } } })).toBe(0);
      expect(await prisma.payment.count({ where: { provider: 'LOCAL_DEMO', status: 'SUCCEEDED' } })).toBe(3);
      const stats = await prisma.userStats.findUniqueOrThrow({ where: { userId: demoRunners[0].id } });
      expect(stats.completedAsRunner).toBe(4);
      expect(stats.runnerRatingCount).toBe(3);
      expect(Number(stats.runnerRatingAvg)).toBe(4);

      process.env.RATE_LIMIT_DISABLED = 'true';
      const app = await createTestApp();
      try {
        const login = async (email: string) => {
          const response = await request(app.getHttpServer()).post(`${API}/auth/login`).set('X-Client', 'mobile').send({ email, password: DEMO_PASSWORD }).expect(200);
          return response.body.data.accessToken as string;
        };
        const runnerToken = await login(demoRunners[5].email);
        const requesterToken = await login(demoRequesters[0].email);
        const get = (path: string, token = runnerToken) => request(app.getHttpServer()).get(`${API}${path}`).set(...bearer(token));
        expect((await get('/runner/eligibility').expect(200)).body.data.canOffer).toBe(true);
        const feed = await get('/marketplace/errands').expect(200);
        expect(feed.body.data.length).toBeGreaterThan(0);
        expect(feed.body.data.every((item: { pickup: { state: string } }) => item.pickup.state === 'Lagos')).toBe(true);
        expect((await get('/notifications').expect(200)).body.data).toHaveLength(4);
        expect((await get('/me/ratings').expect(200)).body.data).toHaveLength(3);
        await request(app.getHttpServer()).post(`${API}/errands/${errandId(demoRequesters[0], 'open')}/offers`).set(...bearer(runnerToken)).set('Idempotency-Key', randomUUID()).send({ amountMinor: 300000, durationMinutes: 30, availabilityConfirmed: true }).expect(201);
        const unreviewed = demoId(`assignment:${errandId(demoRequesters[0], 'completed-unreviewed')}`);
        await request(app.getHttpServer()).post(`${API}/assignments/${unreviewed}/ratings`).set(...bearer(requesterToken)).set('Idempotency-Key', randomUUID()).send({ scores: { overall: 5 }, review: 'A fresh review written after seeding.' }).expect(201);

        const selectedRunnerToken = await login(demoRunners[0].email);
        const pendingId = errandId(demoRequesters[0], 'pending');
        const assignmentId = demoId(`assignment:${pendingId}`);
        const post = (path: string, token: string) => request(app.getHttpServer()).post(`${API}${path}`).set(...bearer(token)).set('Idempotency-Key', randomUUID()).send({});
        await post(`/assignments/${assignmentId}/accept`, selectedRunnerToken).expect(201);
        await get(`/assignments/${assignmentId}`, selectedRunnerToken).expect(200);
        for (const [step, status] of [['start', 'IN_PROGRESS'], ['pickup', 'PICKED_UP'], ['deliver', 'DELIVERED']]) {
          expect((await post(`/assignments/${assignmentId}/${step}`, selectedRunnerToken).expect(201)).body.data.errandStatus).toBe(status);
        }
        expect((await post(`/errands/${pendingId}/complete`, requesterToken).expect(201)).body.data.errandStatus).toBe('COMPLETED');
      } finally { await app.close(); }

      const edited = errandId(demoRequesters[0], 'draft');
      await prisma.errand.update({ where: { id: edited }, data: { title: 'My edited draft' } });
      const changedPassword = await argon2.hash('ChangedByTester!2026');
      await prisma.user.update({ where: { id: demoRunners[0].id }, data: { passwordHash: changedPassword } });
      await prisma.runnerProfile.update({ where: { userId: demoRunners[0].id }, data: { availability: 'UNAVAILABLE' } });
      const notice = await prisma.notification.findFirstOrThrow({ where: { userId: demoRunners[0].id, readAt: null } });
      await prisma.notification.update({ where: { id: notice.id }, data: { readAt: new Date() } });
      const counters = await prisma.offer.count();
      result = seed();
      expect(result.status, result.stderr).toBe(0);
      expect(await prisma.user.count()).toBe(20);
      expect(await prisma.errand.count()).toBe(110);
      expect(await prisma.offer.count()).toBe(counters);
      expect(await prisma.message.count()).toBe(200);
      expect(await prisma.rating.count()).toBe(61);
      expect((await prisma.errand.findUniqueOrThrow({ where: { id: errandId(demoRequesters[0], 'pending') } })).status).toBe('COMPLETED');
      expect((await prisma.errand.findUniqueOrThrow({ where: { id: edited } })).title).toBe('My edited draft');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: demoRunners[0].id } })).passwordHash).toBe(changedPassword);
      expect((await prisma.runnerProfile.findUniqueOrThrow({ where: { userId: demoRunners[0].id } })).availability).toBe('UNAVAILABLE');
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).readAt).not.toBeNull();
    }, 180_000);
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
      expect(await prisma.category.count()).toBe(8);
      expect(await prisma.prohibitedItemRule.count()).toBeGreaterThan(10);
      expect(await prisma.policyVersion.count()).toBe(7);
    });

    it('seeds the PRD categories with their location rules', async () => {
      run('prisma/seed.ts');

      const categories = await prisma.category.findMany({ orderBy: { sortOrder: 'asc' } });

      expect(categories.map((c) => [c.key, c.flow, c.requiresPickup, c.requiresDestination])).toEqual([
        ['delivery', 'TRANSIT', true, true],
        ['pickup', 'TRANSIT', true, false],
        ['shopping_purchase', 'TRANSIT', false, true],
        ['other', 'TRANSIT', true, false],
        ['home_cleaning', 'SERVICE', false, true],
        ['plumbing', 'SERVICE', false, true],
        ['electrical', 'SERVICE', false, true],
        ['other_service', 'SERVICE', false, true],
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
      expect(await prisma.category.count()).toBe(8);
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
