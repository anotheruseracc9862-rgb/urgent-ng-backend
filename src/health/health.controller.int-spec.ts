import { describe, it, expect, afterEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import type { ConnectionOptions } from 'bullmq';
import request from 'supertest';
import { HealthModule } from './health.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { PrismaService } from '../database/prisma.service.js';
import { RedisModule, REDIS_CLIENT } from '../common/redis/redis.module.js';
import { redisOptionsFromUrl } from '../common/redis/redis.config.js';
import { QUEUE_NAMES } from '../queue/queue.registry.js';
import { testConfigModule } from '../test/test-modules.js';

async function buildApp(
  overrides: Array<{ token: unknown; value: unknown }> = [],
): Promise<INestApplication> {
  const builder = Test.createTestingModule({
    imports: [
      testConfigModule(),
      BullModule.forRoot({
        connection: redisOptionsFromUrl(process.env.REDIS_URL as string) as ConnectionOptions,
      }),
      RedisModule,
      DatabaseModule,
      HealthModule,
    ],
  });
  for (const { token, value } of overrides) {
    builder.overrideProvider(token as never).useValue(value);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('HealthController (integration)', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);

  describe('GET /health/live', () => {
    it('returns 200 and checks only the process', async () => {
      app = await buildApp();

      const response = await get('/health/live').expect(200);

      expect(response.body.status).toBe('ok');
      expect(Object.keys(response.body.info)).toEqual(['process']);
      expect(response.body.info.process.status).toBe('up');
      expect(response.body.info.process).toHaveProperty('uptime');
    });

    it('stays up when Redis is down', async () => {
      app = await buildApp([{ token: REDIS_CLIENT, value: failingRedis() }]);

      await get('/health/live').expect(200);
    });
  });

  describe('GET /health/ready', () => {
    it('returns 200 when database, Redis and queues are healthy', async () => {
      app = await buildApp();

      const response = await get('/health/ready').expect(200);

      expect(response.body.status).toBe('ok');
      expect(response.body.info.database.status).toBe('up');
      expect(response.body.info.redis.status).toBe('up');
      expect(response.body.info.queue.status).toBe('up');
    });

    it('reports the depth of every queue', async () => {
      app = await buildApp();

      const response = await get('/health/ready').expect(200);

      const depths = response.body.info.queue.depths;
      for (const name of Object.values(QUEUE_NAMES)) {
        expect(depths[name]).toEqual({ waiting: expect.any(Number), failed: expect.any(Number) });
      }
    });

    it('also answers on plain GET /health', async () => {
      app = await buildApp();

      const response = await get('/health').expect(200);

      expect(response.body.info).toHaveProperty('database');
      expect(response.body.info).toHaveProperty('redis');
      expect(response.body.info).toHaveProperty('queue');
    });

    it('returns 503 when Redis is down', async () => {
      app = await buildApp([{ token: REDIS_CLIENT, value: failingRedis() }]);

      const response = await get('/health/ready').expect(503);

      expect(response.body.status).toBe('error');
      expect(response.body.error.redis.status).toBe('down');
      expect(response.body.info.database.status).toBe('up');
    });

    it('returns 503 when the database is down', async () => {
      app = await buildApp([
        {
          token: PrismaService,
          value: {
            $queryRaw: () => Promise.reject(new Error('database is down')),
            onModuleInit: () => undefined,
            onModuleDestroy: () => undefined,
          },
        },
      ]);

      const response = await get('/health/ready').expect(503);

      expect(response.body.error.database.status).toBe('down');
    });

    it('follows the Terminus response format', async () => {
      app = await buildApp();

      const response = await get('/health/ready').expect(200);

      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('info');
      expect(response.body).toHaveProperty('details');
    });
  });
});

function failingRedis() {
  const fail = () => Promise.reject(new Error('Redis is down'));
  return { ping: fail, get: fail, mget: fail, setex: fail, del: fail, disconnect: () => undefined };
}
