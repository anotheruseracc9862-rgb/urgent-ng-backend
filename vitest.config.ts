import { defineConfig } from 'vitest/config';

// Unit tests: pure and fast, no database or Redis required.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
