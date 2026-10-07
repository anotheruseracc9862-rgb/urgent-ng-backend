import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../app.module.js';
import { MediaWorker } from '../media/media.worker.js';
import { OutboxPublisher } from '../queue/outbox.publisher.js';

// Worker entry point: same modules as the API, booted as a standalone
// application context for BullMQ processors and the outbox publisher.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.enableShutdownHooks();
  const logger = app.get(Logger);
  app.useLogger(logger);

  app.get(OutboxPublisher).start();
  app.get(MediaWorker).start();
  logger.log('Urgent.ng worker started');
}
await bootstrap();
