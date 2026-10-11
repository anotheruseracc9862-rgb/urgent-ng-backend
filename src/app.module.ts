import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import type { ConnectionOptions } from 'bullmq';
import { LoggerModule } from 'nestjs-pino';
import configuration from './config/configuration.js';
import { validateEnv } from './config/env.validation.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter.js';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor.js';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware.js';
import { resolveRequestId } from './common/middleware/request-id.js';
import { CommonModule } from './common/common.module.js';
import { ProvidersModule } from './common/providers/providers.module.js';
import { RedisModule } from './common/redis/redis.module.js';
import { redisOptionsFromUrl } from './common/redis/redis.config.js';
import { AppThrottlerModule } from './common/throttler/throttler.module.js';
import { AppThrottlerGuard } from './common/throttler/app-throttler.guard.js';
import { AuditModule } from './audit/audit.module.js';
import { ConfigStoreModule } from './config/config-store.module.js';
import { QueueModule } from './queue/queue.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AdminModule } from './admin/admin.module.js';
import { MediaModule } from './media/media.module.js';
import { VerificationModule } from './verification/verification.module.js';
import { RunnerModule } from './runner/runner.module.js';
import { ReferenceDataModule } from './reference-data/reference-data.module.js';
import { ErrandsModule } from './errands/errands.module.js';
import { EntitlementsModule } from './entitlements/entitlements.module.js';
import { MarketplaceModule } from './marketplace/marketplace.module.js';
import { OffersModule } from './offers/offers.module.js';
import { AssignmentsModule } from './assignments/assignments.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { ExecutionModule } from './execution/execution.module.js';
import { RatingsModule } from './ratings/ratings.module.js';
import { ReliabilityModule } from './reliability/reliability.module.js';
import { DisputesModule } from './disputes/disputes.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { EnforcementModule } from './enforcement/enforcement.module.js';
import { BadgesModule } from './badges/badges.module.js';
import { LocationsModule } from './locations/locations.module.js';
import { TrustedContactModule } from './trusted-contact/trusted-contact.module.js';
import { RiskModule } from './risk/risk.module.js';

const isDev = process.env.NODE_ENV !== 'production';
const isTest = process.env.NODE_ENV === 'test';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validate: validateEnv,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: isTest ? 'silent' : isDev ? 'debug' : 'info',
        transport: isDev && !isTest
          ? { target: 'pino-pretty', options: { singleLine: true } }
          : undefined,
        // Same ID in the log line, the x-request-id response header and the error envelope
        genReqId: (req, res) => {
          const id = resolveRequestId(req.headers['x-request-id']);
          req.headers['x-request-id'] = id;
          res.setHeader('x-request-id', id);
          return id;
        },
        redact: ['req.headers.authorization', 'req.headers.cookie'],
        autoLogging: {
          ignore: (req) =>
            typeof req.url === 'string' && req.url.includes('/health'),
        },
      },
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: redisOptionsFromUrl(
          config.getOrThrow<string>('redis.url'),
        ) as ConnectionOptions,
      }),
    }),
    RedisModule,
    AppThrottlerModule,
    CommonModule,
    ProvidersModule.forRoot(),
    DatabaseModule,
    AuditModule,
    ConfigStoreModule,
    QueueModule,
    HealthModule,
    AuthModule,
    AdminModule,
    ReferenceDataModule,
    MediaModule,
    VerificationModule,
    RunnerModule,
    ErrandsModule,
    EntitlementsModule,
    OffersModule,
    AssignmentsModule,
    ExecutionModule,
    RealtimeModule,
    NotificationsModule,
    MessagingModule,
    MarketplaceModule,
    RatingsModule,
    ReliabilityModule,
    DisputesModule,
    ReportsModule,
    EnforcementModule,
    BadgesModule,
    LocationsModule,
    TrustedContactModule,
    RiskModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('{*path}');
  }
}
