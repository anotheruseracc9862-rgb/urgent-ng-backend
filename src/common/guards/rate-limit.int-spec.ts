import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import { RateLimit } from '../decorators/rate-limit.decorator.js';
import { RedisModule } from '../redis/redis.module.js';
import { AppThrottlerModule } from '../throttler/throttler.module.js';
import { AppThrottlerGuard } from '../throttler/app-throttler.guard.js';
import { DomainExceptionFilter } from '../filters/domain-exception.filter.js';
import { cleanRedis, getTestRedis } from '../../test/database.helper.js';
import { testConfigModule } from '../../test/test-modules.js';

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

  @Get('location')
  @RateLimit('location')
  location() {
    return { success: true };
  }

  @Get('global')
  global() {
    return { success: true };
  }
}

describe('Rate limiting (integration, Redis-backed)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [testConfigModule(), RedisModule, AppThrottlerModule],
      controllers: [TestRateLimitController],
      providers: [
        { provide: APP_GUARD, useClass: AppThrottlerGuard },
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  beforeEach(async () => {
    await cleanRedis();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);

  it('auth policy: allows 5 per minute, then answers 429 RATE_LIMITED', async () => {
    for (let i = 0; i < 5; i++) {
      await get('/test-rate-limit/auth').expect(200);
    }

    const blocked = await get('/test-rate-limit/auth').expect(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('location policy: allows 2 per minute', async () => {
    await get('/test-rate-limit/location').expect(200);
    await get('/test-rate-limit/location').expect(200);
    await get('/test-rate-limit/location').expect(429);
  });

  it('otp policy: allows 10 per hour', async () => {
    for (let i = 0; i < 10; i++) {
      await get('/test-rate-limit/otp').expect(200);
    }
    await get('/test-rate-limit/otp').expect(429);
  });

  it('keeps a separate counter per route', async () => {
    for (let i = 0; i < 5; i++) {
      await get('/test-rate-limit/auth').expect(200);
    }
    await get('/test-rate-limit/auth').expect(429);

    await get('/test-rate-limit/otp').expect(200);
    await get('/test-rate-limit/global').expect(200);
  });

  it('keeps the global default at 300 per minute (normal traffic is not blocked)', async () => {
    for (let i = 0; i < 20; i++) {
      await get('/test-rate-limit/global').expect(200);
    }
  });

  it('stores the counters in Redis, so they survive an API restart', async () => {
    await get('/test-rate-limit/auth').expect(200);

    const keys = await getTestRedis().keys('throttle:*');
    expect(keys.length).toBeGreaterThan(0);
  });

  it('resets when the Redis counters are cleared', async () => {
    for (let i = 0; i < 5; i++) {
      await get('/test-rate-limit/auth').expect(200);
    }
    await get('/test-rate-limit/auth').expect(429);

    await cleanRedis();

    await get('/test-rate-limit/auth').expect(200);
  });
});
