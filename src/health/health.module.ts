import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { QueueModule } from '../queue/queue.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [TerminusModule, QueueModule],
  controllers: [HealthController],
})
export class HealthModule {}
