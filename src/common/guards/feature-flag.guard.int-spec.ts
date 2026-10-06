import { Test, TestingModule } from '@nestjs/testing';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import { FeatureFlagGuard } from './feature-flag.guard.js';
import { RequiresFlag } from '../decorators/requires-flag.decorator.js';
import { DatabaseModule } from '../../database/database.module.js';
import { ConfigModule } from '@nestjs/config';
import configuration from '../../config/configuration.js';
import { BusinessConfigService } from '../../config/business-config.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import Redis from 'ioredis';

/**
 * Test controller with feature flags
 */
@Controller('test-flags')
class TestFlagController {
  @Get('registrations')
  @RequiresFlag('registrations_enabled')
  registrations() {
    return { success: true };
  }

  @Get('errands')
  @RequiresFlag('errand_posting_enabled')
  errands() {
    return { success: true };
  }

  @Get('no-flag')
  noFlag() {
    return { success: true };
  }
}

describe('FeatureFlagGuard (integration)', () => {
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
      ],
      controllers: [TestFlagController],
      providers: [
        BusinessConfigService,
        {
          provide: APP_GUARD,
          useClass: FeatureFlagGuard,
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();

    prisma = module.get<PrismaService>(PrismaService);
    
    const configService = module.get(BusinessConfigService);
    redis = configService['redis'];
  });

  beforeEach(async () => {
    // Clear Redis cache
    await redis.flushdb();

    // Reset flags to enabled
    await prisma.$executeRaw`
      UPDATE config_values 
      SET value = 'true' 
      WHERE key IN ('registrations_enabled', 'errand_posting_enabled')
    `;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('flag enabled', () => {
    it('should allow access when flag is true', async () => {
      const response = await request(app.getHttpServer())
        .get('/test-flags/registrations')
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('flag disabled', () => {
    it('should block access when flag is false', async () => {
      // Disable registrations
      await prisma.$executeRaw`
        UPDATE config_values 
        SET value = 'false' 
        WHERE key = 'registrations_enabled'
      `;

      // Clear cache to pick up new value
      await redis.flushdb();

      const response = await request(app.getHttpServer())
        .get('/test-flags/registrations')
        .expect(503);

      expect(response.body.error).toHaveProperty('code', 'FEATURE_DISABLED');
    });

    it('should return stable error code', async () => {
      await prisma.$executeRaw`
        UPDATE config_values 
        SET value = 'false' 
        WHERE key = 'errand_posting_enabled'
      `;

      await redis.flushdb();

      const response = await request(app.getHttpServer())
        .get('/test-flags/errands')
        .expect(503);

      expect(response.body.error.code).toBe('FEATURE_DISABLED');
    });
  });

  describe('no flag requirement', () => {
    it('should always allow access without @RequiresFlag decorator', async () => {
      const response = await request(app.getHttpServer())
        .get('/test-flags/no-flag')
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('flag toggle without restart', () => {
    it('should immediately block after flag is disabled', async () => {
      // First request succeeds
      await request(app.getHttpServer())
        .get('/test-flags/registrations')
        .expect(200);

      // Disable flag
      await prisma.$executeRaw`
        UPDATE config_values 
        SET value = 'false' 
        WHERE key = 'registrations_enabled'
      `;

      // Clear cache (simulates TTL expiry or invalidation)
      await redis.flushdb();

      // Second request blocked
      await request(app.getHttpServer())
        .get('/test-flags/registrations')
        .expect(503);
    });

    it('should immediately allow after flag is re-enabled', async () => {
      // Disable flag
      await prisma.$executeRaw`
        UPDATE config_values 
        SET value = 'false' 
        WHERE key = 'registrations_enabled'
      `;
      await redis.flushdb();

      // Request blocked
      await request(app.getHttpServer())
        .get('/test-flags/registrations')
        .expect(503);

      // Re-enable flag
      await prisma.$executeRaw`
        UPDATE config_values 
        SET value = 'true' 
        WHERE key = 'registrations_enabled'
      `;
      await redis.flushdb();

      // Request allowed
      await request(app.getHttpServer())
        .get('/test-flags/registrations')
        .expect(200);
    });
  });

  describe('multiple flags', () => {
    it('should independently control different features', async () => {
      // Disable only registrations
      await prisma.$executeRaw`
        UPDATE config_values 
        SET value = 'false' 
        WHERE key = 'registrations_enabled'
      `;
      await redis.flushdb();

      // Registrations blocked
      await request(app.getHttpServer())
        .get('/test-flags/registrations')
        .expect(503);

      // Errands still allowed
      await request(app.getHttpServer())
        .get('/test-flags/errands')
        .expect(200);
    });
  });
});
