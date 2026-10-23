import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { NODE_ENV: 'test' },
    globalSetup: ['./tests/globalSetup.js'],
    // Tests share one MySQL test database, so files run one at a time.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
