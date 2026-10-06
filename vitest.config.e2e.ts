import { defineConfig } from 'vitest/config';

// End-to-end tests: the whole app over HTTP against the test database and Redis.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    setupFiles: ['./test/setup.db.ts'],
    globalSetup: ['./src/test/setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
