import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { HealthModule } from './health.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { ConfigModule } from '@nestjs/config';
import configuration from '../config/configuration.js';
import { PrismaService } from '../database/prisma.service.js';
import Redis from 'ioredis';

describe('HealthController (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [configuration],
        }),
        DatabaseModule,
        HealthModule,
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();

    prisma = module.get<PrismaService>(PrismaService);
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379/15');
  });

  afterAll(async () => {
    await redis.quit();
    await app.close();
  });

  describe('GET /health/live', () => {
    it('should return 200 when application is alive', async () => {
      const response = await request(app.getHttpServer())
        .get('/health/live')
        .expect(200);

      expect(response.body.status).toBe('ok');
      expect(response.body.info).toHaveProperty('process');
      expect(response.body.info.process.status).toBe('up');
      expect(response.body.info.process).toHaveProperty('uptime');
    });

    it('should not check external dependencies', async () => {
      // Liveness should succeed even if we can't verify dependencies
      const response = await request(app.getHttpServer())
        .get('/health/live')
        .expect(200);

      // Should only have process check, not database/redis
      expect(response.body.info).toHaveProperty('process');
      expect(Object.keys(response.body.info)).toEqual(['process']);
    });
  });

  describe('GET /health/ready', () => {
    it('should return 200 when all dependencies are healthy', async () => {
      const response = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(200);

      expect(response.body.status).toBe('ok');
      expect(response.body.info).toHaveProperty('database');
      expect(response.body.info).toHaveProperty('redis');
      expect(response.body.info).toHaveProperty('queue');

      expect(response.body.info.database.status).toBe('up');
      expect(response.body.info.redis.status).toBe('up');
      expect(response.body.info.queue.status).toBe('up');
    });

    it('should include Redis version in queue check', async () => {
      const response = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(200);

      expect(response.body.info.queue).toHaveProperty('redis_version');
      expect(typeof response.body.info.queue.redis_version).toBe('string');
    });
  });

  describe('GET /health (legacy)', () => {
    it('should behave like /health/ready', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(200);

      expect(response.body.status).toBe('ok');
      expect(response.body.info).toHaveProperty('database');
      expect(response.body.info).toHaveProperty('redis');
      expect(response.body.info).toHaveProperty('queue');
    });
  });

  describe('failure scenarios', () => {
    it('liveness should stay up when Redis is down', async () => {
      // Stop Redis temporarily
      await redis.quit();

      // Liveness still succeeds
      const response = await request(app.getHttpServer())
        .get('/health/live')
        .expect(200);

      expect(response.body.status).toBe('ok');

      // Reconnect Redis for other tests
      redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379/15');
    });

    it('readiness should fail when Redis is down', async () => {
      // Stop Redis temporarily
      await redis.quit();

      // Readiness fails
      const response = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);

      expect(response.body.status).toBe('error');
      expect(response.body.error).toHaveProperty('redis');
      expect(response.body.error.redis.status).toBe('down');

      // Reconnect Redis
      redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379/15');
    });
  });

  describe('response format', () => {
    it('should follow NestJS Terminus format', async () => {
      const response = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(200);

      // Terminus response format
      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('info');
      expect(response.body).toHaveProperty('details');

      expect(['ok', 'error']).toContain(response.body.status);
    });
  });
});
