import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { OutboxService } from './outbox.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class QueueModule {}
