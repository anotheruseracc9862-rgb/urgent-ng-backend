import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../app.module.js';
import { SchedulerModule } from './scheduler.module.js';

@Module({ imports: [AppModule, SchedulerModule] })
class SchedulerRootModule {}

// Scheduler entry point: boots the shared modules plus cron jobs as a
// standalone application context (no HTTP listener).
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(SchedulerRootModule, {
    bufferLogs: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);
  logger.log('Urgent.ng scheduler context started');
}
await bootstrap();
