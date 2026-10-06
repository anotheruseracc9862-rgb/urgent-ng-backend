// Per-file setup for integration and e2e tests: decorator metadata polyfill,
// the test database and Redis URLs, and connection cleanup.
import 'reflect-metadata';
import { afterAll } from 'vitest';
import { closeTestConnections } from '../src/test/database.helper.js';
import { applyTestEnv } from '../src/test/test-env.js';

applyTestEnv();

afterAll(async () => {
  await closeTestConnections();
});
