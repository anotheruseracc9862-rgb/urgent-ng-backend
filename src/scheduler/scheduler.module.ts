import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

// Cron and sweeper jobs live here and run only in the scheduler process
// (npm run start:scheduler), never in the API process (PRD 1 section 61).
@Module({
  imports: [ScheduleModule.forRoot()],
})
export class SchedulerModule {}
