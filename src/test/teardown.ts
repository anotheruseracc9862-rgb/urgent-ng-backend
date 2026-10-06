/**
 * Global test teardown
 * Runs once after all tests complete
 */

import { closeTestConnections } from './database.helper.js';

export async function teardown() {
  console.log('Closing test database connections...');
  await closeTestConnections();
  console.log('Test connections closed');
}
