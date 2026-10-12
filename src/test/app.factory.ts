/**
 * Test application factory
 * Creates configured NestJS app with supertest for integration tests
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import supertest from 'supertest';
import { AppModule } from '../app.module.js';
import { configureApp } from '../app.setup.js';

/**
 * Create a fully configured test application
 * Applies the same setup as main.ts (versioning, validation, etc.)
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication({ rawBody: true });
  
  // Apply the same configuration as production
  configureApp(app);
  
  await app.init();
  
  return app;
}

/**
 * Create a supertest request instance for the app
 */
export function createTestRequest(app: INestApplication): supertest.Agent {
  return supertest(app.getHttpServer());
}

/**
 * Close the test application and release resources
 */
export async function closeTestApp(app: INestApplication): Promise<void> {
  await app.close();
}
