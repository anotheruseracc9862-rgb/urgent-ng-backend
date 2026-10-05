import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../app.module.js';

// Worker entry point: same modules as the API, booted as a standalone
// application context for BullMQ processors and background jobs.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);
  logger.log('Urgent.ng worker context started');
}
await bootstrap();
