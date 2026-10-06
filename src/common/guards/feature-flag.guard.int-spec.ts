import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import request from 'supertest';
import { RequiresFlag } from '../decorators/requires-flag.decorator.js';
import { DatabaseModule } from '../../database/database.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { ConfigStoreModule } from '../../config/config-store.module.js';
import { BusinessConfigService } from '../../config/business-config.service.js';
import { DomainExceptionFilter } from '../filters/domain-exception.filter.js';
import { cleanAll } from '../../test/database.helper.js';
import { testConfigModule } from '../../test/test-modules.js';

@Controller('test-flags')
class TestFlagController {
  @Get('registrations')
  @RequiresFlag('FEATURE_REGISTRATIONS_ENABLED')
  registrations() {
    return { success: true };
  }

  @Get('errands')
  @RequiresFlag('FEATURE_ERRAND_POSTING_ENABLED')
  errands() {
    return { success: true };
  }

  @Get('no-flag')
  noFlag() {
    return { success: true };
  }
}

@Controller('test-class-flag')
@RequiresFlag('FEATURE_OFFERS_ENABLED')
class ClassFlagController {
  @Get()
  list() {
    return { success: true };
  }
}

describe('FeatureFlagGuard (integration)', () => {
  let app: INestApplication;
  let config: BusinessConfigService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [testConfigModule(), RedisModule, DatabaseModule, ConfigStoreModule],
      controllers: [TestFlagController, ClassFlagController],
      providers: [{ provide: APP_FILTER, useClass: DomainExceptionFilter }],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    config = moduleRef.get(BusinessConfigService);
  });

  beforeEach(async () => {
    await cleanAll();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);

  it('allows a route whose flag is on by default', async () => {
    const res = await get('/test-flags/registrations').expect(200);
    expect(res.body.success).toBe(true);
  });

  it('allows a route with no flag', async () => {
    await get('/test-flags/no-flag').expect(200);
  });

  it('blocks a route when its flag is switched off, with the standard error and no flag name', async () => {
    await config.set('FEATURE_REGISTRATIONS_ENABLED', false);

    const res = await get('/test-flags/registrations').expect(503);

    expect(res.body.error.code).toBe('FEATURE_DISABLED');
    expect(JSON.stringify(res.body)).not.toContain('FEATURE_REGISTRATIONS_ENABLED');
    expect(JSON.stringify(res.body)).not.toContain('flagKey');
  });

  it('only blocks the route that owns the flag', async () => {
    await config.set('FEATURE_REGISTRATIONS_ENABLED', false);

    await get('/test-flags/errands').expect(200);
    await get('/test-flags/no-flag').expect(200);
  });

  it('takes effect immediately after the flag changes (cache invalidated on write)', async () => {
    await get('/test-flags/errands').expect(200);

    await config.set('FEATURE_ERRAND_POSTING_ENABLED', false);
    await get('/test-flags/errands').expect(503);

    await config.set('FEATURE_ERRAND_POSTING_ENABLED', true);
    await get('/test-flags/errands').expect(200);
  });

  it('supports the decorator on a whole controller class', async () => {
    await get('/test-class-flag').expect(200);

    await config.set('FEATURE_OFFERS_ENABLED', false);
    const res = await get('/test-class-flag').expect(503);
    expect(res.body.error.code).toBe('FEATURE_DISABLED');
  });
});
