import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.js'],
    setupFiles: ['./tests/setup.js'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true }
    }
  }
});
