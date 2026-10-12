import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { RetentionService } from './retention.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
