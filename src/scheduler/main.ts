import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../app.module.js';
import { SchedulerModule } from './scheduler.module.js';
import { SweeperRegistry } from './sweeper.registry.js';

@Module({ imports: [AppModule, SchedulerModule] })
class SchedulerRootModule {}

// Scheduler entry point: boots the shared modules and runs the sweepers as a
// standalone application context (no HTTP listener).
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(SchedulerRootModule, {
    bufferLogs: true,
  });
  app.enableShutdownHooks();
  const logger = app.get(Logger);
  app.useLogger(logger);

  app.get(SweeperRegistry).startAll();
  logger.log('Urgent.ng scheduler started');
}
await bootstrap();
