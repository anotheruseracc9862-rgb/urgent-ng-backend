import { defineConfig } from 'vitest/config';

// Integration tests: real PostgreSQL + PostGIS and Redis (run `npm run db:up`).
// They use the `<database>_test` database and Redis database 15, never the
// development ones. Files run one at a time because they share those stores.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.int-spec.ts'],
    setupFiles: ['./test/setup.db.ts'],
    globalSetup: ['./src/test/setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
