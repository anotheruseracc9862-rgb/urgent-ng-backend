import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { RatingService } from './rating.service.js';
import { RatingsController } from './ratings.controller.js';
import { UserStatsEventHandler } from './user-stats.handler.js';
import { UserStatsService } from './user-stats.service.js';

/**
 * Ratings and derived user statistics (Backend PRD 20). Other modules read a user's figures
 * through UserStatsService; nothing else writes `user_stats`.
 */
@Module({
  imports: [AuthModule, AuditModule, ConfigStoreModule, DatabaseModule, IdempotencyModule, QueueModule],
  controllers: [RatingsController],
  providers: [RatingService, UserStatsService, UserStatsEventHandler],
  exports: [RatingService, UserStatsService],
})
export class RatingsModule {}
