import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import express from 'express';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './config/configuration.js';

/** `backend/assets`, next to `src` and `dist`: the files the backend itself hands out, such as the email logo. */
const ASSETS_DIR = fileURLToPath(new URL('../assets', import.meta.url));

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

  app.use(cookieParser());

  // Behind the web app's proxy or a load balancer the socket address is the proxy's. Trusting the
  // configured number of hops makes `req.ip` the real client, which the rate limits, the audit log
  // and consent records depend on.
  const hops = config.get('trustProxyHops') ?? 0;
  if (hops > 0) {
    (app.getHttpAdapter().getInstance() as { set: (key: string, value: unknown) => void }).set('trust proxy', hops);
  }

  app.enableCors({
    origin: config.getOrThrow('corsOrigins'),
    credentials: true,
  });

  // Public images for emails: no login, long cache. Cross-origin on purpose, so a mail app that loads
  // the image straight from here (not through its own proxy) is allowed to show it.
  app.use(
    '/assets',
    (_request: unknown, response: { setHeader: (name: string, value: string) => void }, next: () => void) => {
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      next();
    },
    express.static(ASSETS_DIR, { maxAge: '7d', index: false, dotfiles: 'ignore' }),
  );

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
