/**
 * Scheduler process entrypoint.
 * Runs sweeper jobs in an infinite loop.
 * Per PRD §25.3.
 * 
 * Usage: npm run start:scheduler
 */

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { IdempotencyCleanupSweeper } from './scheduler/idempotency-cleanup.sweeper.js';

const logger = new Logger('Scheduler');

async function bootstrap() {
  logger.log('Starting scheduler process...');

  // Create app context (no HTTP listener)
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  // Get sweeper instances and start them
  const idempotencyCleanupSweeper = app.get(IdempotencyCleanupSweeper);
  idempotencyCleanupSweeper.start();

  logger.log('All sweepers started');

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.log(`${signal} received, stopping sweepers...`);
    idempotencyCleanupSweeper.stop();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((error) => {
  logger.error('Failed to start scheduler', error);
  process.exit(1);
});
