import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
    globalSetup: ['./src/test/setup.ts'],
    globalTeardown: ['./src/test/teardown.ts'],
    // Run tests serially to avoid race conditions with database cleanup
    // Can be parallelized later with test isolation improvements
    pool: 'threads',
    poolOptions: undefined,
    sequence: {
      concurrent: false,
    },
  },
});
