import { Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { DatabaseModule } from '../../database/database.module.js';

@Module({
  imports: [DatabaseModule],
  providers: [IdempotencyService, IdempotencyInterceptor],
  exports: [IdempotencyService, IdempotencyInterceptor],
})
export class IdempotencyModule {}
