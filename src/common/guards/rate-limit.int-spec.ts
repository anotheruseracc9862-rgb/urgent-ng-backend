import { Test, TestingModule } from '@nestjs/testing';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import { RateLimit } from '../decorators/rate-limit.decorator.js';

/**
 * Test controller with different rate limit policies
 */
@Controller('test-rate-limit')
class TestRateLimitController {
  @Get('auth')
  @RateLimit('auth')
  auth() {
    return { success: true };
  }

  @Get('otp')
  @RateLimit('otp')
  otp() {
    return { success: true };
  }

  @Get('global')
  global() {
    return { success: true };
  }
}

describe('RateLimit (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          { ttl: 60_000, limit: 300 }, // Global default
        ]),
      ],
      controllers: [TestRateLimitController],
      providers: [
        {
          provide: APP_GUARD,
          useClass: ThrottlerGuard,
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('auth policy (5 per 15 min)', () => {
    it('should allow requests within limit', async () => {
      // Make 5 requests (the limit)
      for (let i = 0; i < 5; i++) {
        const response = await request(app.getHttpServer())
          .get('/test-rate-limit/auth')
          .expect(200);

        expect(response.body.success).toBe(true);
      }
    });

    it('should block requests exceeding limit', async () => {
      // Exhaust the limit
      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer()).get('/test-rate-limit/auth');
      }

      // 6th request should be blocked
      await request(app.getHttpServer())
        .get('/test-rate-limit/auth')
        .expect(429);
    });
  });

  describe('otp policy (3 per hour)', () => {
    it('should allow requests within limit', async () => {
      // Make 3 requests (the limit)
      for (let i = 0; i < 3; i++) {
        const response = await request(app.getHttpServer())
          .get('/test-rate-limit/otp')
          .expect(200);

        expect(response.body.success).toBe(true);
      }
    });

    it('should block requests exceeding limit', async () => {
      // Exhaust the limit
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer()).get('/test-rate-limit/otp');
      }

      // 4th request should be blocked
      await request(app.getHttpServer())
        .get('/test-rate-limit/otp')
        .expect(429);
    });
  });

  describe('global policy (300 per minute)', () => {
    it('should apply to routes without explicit policy', async () => {
      const response = await request(app.getHttpServer())
        .get('/test-rate-limit/global')
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('rate limit headers', () => {
    it('should include X-RateLimit headers', async () => {
      const response = await request(app.getHttpServer())
        .get('/test-rate-limit/auth')
        .expect(200);

      // NestJS throttler includes these headers
      expect(response.headers).toHaveProperty('x-ratelimit-limit');
      expect(response.headers).toHaveProperty('x-ratelimit-remaining');
      expect(response.headers).toHaveProperty('x-ratelimit-reset');
    });
  });
});
