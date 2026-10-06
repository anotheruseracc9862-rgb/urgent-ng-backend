/**
 * Global test setup
 * Runs once before all tests
 */

import { execSync } from 'node:child_process';

export async function setup() {
  // Ensure test database has latest migrations
  console.log('Running Prisma migrations on test database...');
  
  try {
    execSync('npx prisma migrate deploy', {
      stdio: 'inherit',
      env: { ...process.env },
    });
    console.log('Migrations applied successfully');
  } catch (error) {
    console.error('Failed to apply migrations:', error);
    throw error;
  }
}
