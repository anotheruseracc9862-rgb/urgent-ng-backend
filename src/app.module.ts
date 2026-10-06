import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
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
import { SchedulerModule } from './scheduler/scheduler.module.js';

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
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = new URL(config.getOrThrow<string>('redis.url'));
        return {
          connection: {
            host: url.hostname,
            port: Number.parseInt(url.port || '6379', 10),
            ...(url.password ? { password: url.password } : {}),
          },
        };
      },
    }),
    CommonModule,
    ProvidersModule.forRoot(),
    DatabaseModule,
    HealthModule,
    SchedulerModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('{*path}');
  }
}
