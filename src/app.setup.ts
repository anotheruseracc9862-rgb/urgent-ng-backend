import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import type { AppConfig } from './config/configuration.js';

/**
 * Global HTTP configuration shared by the real server (main.ts) and the e2e
 * tests, so tests exercise the same prefix, versioning, CORS and validation.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<AppConfig>);

  app.use(
    helmet({
      contentSecurityPolicy: process.env.NODE_ENV === 'production',
    }),
  );

  app.enableCors({
    origin: config.getOrThrow('corsOrigins'),
    credentials: true,
  });

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
