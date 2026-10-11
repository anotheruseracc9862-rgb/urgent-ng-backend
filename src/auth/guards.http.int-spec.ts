import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { configureApp } from '../app.setup.js';
import { AuthModule } from './auth.module.js';
import {
  ConsumerAuth,
  RequireNoRestriction,
  RequiresPolicyAcceptance,
} from './decorators/consumer-auth.decorator.js';
import { cleanAll, enforcementActionFor, getTestPrisma } from '../test/database.helper.js';
import { API, bearer, seedPolicies, signedInUser } from '../test/auth.helper.js';
import { PolicyService } from './policy.service.js';

process.env.RATE_LIMIT_DISABLED = 'true';

/** Routes a later module would write, to prove the guards do their job. */
@Controller('t')
class GuardProbeController {
  @Get('active')
  @ConsumerAuth()
  active() {
    return { ok: true };
  }

  @Get('allow-deactivated')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  allowDeactivated() {
    return { ok: true };
  }

  @Post('posting')
  @ConsumerAuth()
  @RequireNoRestriction('POSTING')
  posting() {
    return { ok: true };
  }

  @Post('offering')
  @ConsumerAuth()
  @RequireNoRestriction('OFFERING')
  offering() {
    return { ok: true };
  }

  @Get('policy')
  @ConsumerAuth()
  @RequiresPolicyAcceptance()
  policy() {
    return { ok: true };
  }
}

describe('Consumer guards (HTTP)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  const call = (method: 'get' | 'post', path: string, token?: string) => {
    const req = request(app.getHttpServer())[method](`${API}${path}`);
    return token ? req.set(...bearer(token)) : req;
  };
  const setStatus = (userId: string, status: string) =>
    prisma.$executeRaw`UPDATE users SET status = ${status}::"UserStatus" WHERE id = ${userId}::uuid`;
  const restrict = async (
    userId: string,
    type: string,
    options: { status?: string; starts?: string; ends?: string | null } = {},
  ) => {
    const ends = options.ends === undefined ? "now() + interval '1 hour'" : options.ends;
    const action = await enforcementActionFor(userId);
    return prisma.$executeRawUnsafe(
      `INSERT INTO user_restrictions (user_id, type, status, starts_at, ends_at, enforcement_action_id, updated_at)
       VALUES ('${userId}'::uuid, '${type}'::"UserRestrictionType", '${options.status ?? 'ACTIVE'}'::"RestrictionStatus",
               ${options.starts ?? "now() - interval '1 hour'"}, ${ends ?? 'NULL'}, '${action}'::uuid, now())`,
    );
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, AuthModule],
      controllers: [GuardProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('authentication and account status', () => {
    it('answers 401 AUTH_REQUIRED without a token', async () => {
      const res = await call('get', '/t/active').expect(401);

      expect(res.body.error.code).toBe('AUTH_REQUIRED');
    });

    it('lets an active user through', async () => {
      const user = await signedInUser(app);

      await call('get', '/t/active', user.accessToken).expect(200);
    });

    it('blocks DEACTIVATED, SUSPENDED and DELETION_PENDING users by default, with distinct codes', async () => {
      const user = await signedInUser(app);

      await setStatus(user.userId, 'DEACTIVATED');
      expect((await call('get', '/t/active', user.accessToken).expect(403)).body.error.code).toBe('ACCOUNT_DEACTIVATED');
      await setStatus(user.userId, 'SUSPENDED');
      expect((await call('get', '/t/active', user.accessToken).expect(403)).body.error.code).toBe('ACCOUNT_SUSPENDED');
      await setStatus(user.userId, 'DELETION_PENDING');
      expect((await call('get', '/t/active', user.accessToken).expect(403)).body.error.code).toBe('ACCOUNT_DELETION_PENDING');
    });

    it('lets a route opt in specific statuses, and only those', async () => {
      const user = await signedInUser(app);

      await setStatus(user.userId, 'DEACTIVATED');
      await call('get', '/t/allow-deactivated', user.accessToken).expect(200);
      await setStatus(user.userId, 'SUSPENDED');
      await call('get', '/t/allow-deactivated', user.accessToken).expect(403);
    });

    it('never lets a DELETED account through, even if a route allows it', async () => {
      const user = await signedInUser(app);
      await prisma.$executeRaw`UPDATE users SET status = 'DELETED'::"UserStatus" WHERE id = ${user.userId}::uuid`;

      await call('get', '/t/allow-deactivated', user.accessToken).expect(401);
    });

    it('reads the status fresh on every request (no stale token claims)', async () => {
      const user = await signedInUser(app);
      await call('get', '/t/active', user.accessToken).expect(200);

      await setStatus(user.userId, 'SUSPENDED');

      await call('get', '/t/active', user.accessToken).expect(403);
    });
  });

  describe('restrictions', () => {
    it('blocks a user with an active restriction of that type', async () => {
      const user = await signedInUser(app);
      await restrict(user.userId, 'POSTING');

      const res = await call('post', '/t/posting', user.accessToken).expect(403);

      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.details.restriction).toBe('POSTING');
    });

    it('does not block a different action', async () => {
      const user = await signedInUser(app);
      await restrict(user.userId, 'POSTING');

      await call('post', '/t/offering', user.accessToken).expect(201);
    });

    it('ALL_MARKETPLACE blocks every marketplace action', async () => {
      const user = await signedInUser(app);
      await restrict(user.userId, 'ALL_MARKETPLACE', { ends: null });

      await call('post', '/t/posting', user.accessToken).expect(403);
      await call('post', '/t/offering', user.accessToken).expect(403);
    });

    it('ignores revoked, expired and not-yet-started restrictions', async () => {
      const user = await signedInUser(app);
      await restrict(user.userId, 'POSTING', { status: 'REVOKED' });
      await restrict(user.userId, 'POSTING', { status: 'EXPIRED' });
      await restrict(user.userId, 'POSTING', { starts: "now() - interval '2 hours'", ends: "now() - interval '1 hour'" });
      await restrict(user.userId, 'POSTING', { starts: "now() + interval '1 hour'", ends: "now() + interval '2 hours'" });

      await call('post', '/t/posting', user.accessToken).expect(201);
    });

    it('a restriction ends the moment its end time passes', async () => {
      const user = await signedInUser(app);
      await restrict(user.userId, 'POSTING');
      await call('post', '/t/posting', user.accessToken).expect(403);

      await prisma.$executeRaw`UPDATE user_restrictions SET ends_at = now() - interval '1 second'`;

      await call('post', '/t/posting', user.accessToken).expect(201);
    });

    it('ignores soft-deleted restrictions', async () => {
      const user = await signedInUser(app);
      await restrict(user.userId, 'POSTING');
      await prisma.$executeRaw`UPDATE user_restrictions SET deleted_at = now()`;

      await call('post', '/t/posting', user.accessToken).expect(201);
    });

    it('one user’s restriction does not affect another', async () => {
      const a = await signedInUser(app);
      const b = await signedInUser(app);
      await restrict(a.userId, 'POSTING');

      await call('post', '/t/posting', b.accessToken).expect(201);
    });
  });

  describe('policy acceptance', () => {
    it('lets a user who accepted the required policies through', async () => {
      const user = await signedInUser(app);

      await call('get', '/t/policy', user.accessToken).expect(200);
    });

    it('does not check anything on a route that did not ask for it', async () => {
      const user = await signedInUser(app);
      await app.get(PolicyService).publish('TERMS_OF_SERVICE', '2.0', 'x', { requiresReacceptance: true });

      await call('get', '/t/active', user.accessToken).expect(200);
    });

    it('blocks until a new version that requires re-acceptance is accepted', async () => {
      const user = await signedInUser(app);
      await app.get(PolicyService).publish('TERMS_OF_SERVICE', '2.0', 'x', { requiresReacceptance: true });

      const res = await call('get', '/t/policy', user.accessToken).expect(403);

      expect(res.body.error.code).toBe('POLICY_ACCEPTANCE_REQUIRED');
      expect(res.body.error.details.requiredPolicies).toEqual([
        expect.objectContaining({ type: 'TERMS_OF_SERVICE', version: '2.0' }),
      ]);

      await call('post', '/me/consents', user.accessToken).send({ type: 'TERMS_OF_SERVICE', version: '2.0' }).expect(200);
      await call('get', '/t/policy', user.accessToken).expect(200);
    });

    it('does not block for a new version that does not require re-acceptance', async () => {
      const user = await signedInUser(app);
      await app.get(PolicyService).publish('PRIVACY_POLICY', '1.1', 'x', { requiresReacceptance: false });

      await call('get', '/t/policy', user.accessToken).expect(200);
    });

    it('does not block for a version that is not published yet', async () => {
      const user = await signedInUser(app);
      await app.get(PolicyService).publish('TERMS_OF_SERVICE', '3.0', 'x', {
        requiresReacceptance: true,
        publishedAt: new Date(Date.now() + 3600_000),
      });

      await call('get', '/t/policy', user.accessToken).expect(200);
    });

    it('a withdrawn required acceptance blocks again', async () => {
      const user = await signedInUser(app);
      await prisma.$executeRaw`UPDATE consent_records SET withdrawn_at = now() WHERE consent_type = 'SAFETY_POLICY'::"ConsentType"`;

      const res = await call('get', '/t/policy', user.accessToken).expect(403);

      expect(res.body.error.details.requiredPolicies[0].type).toBe('SAFETY_POLICY');
    });
  });
});
