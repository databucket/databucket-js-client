import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // the integration tests share rows of one bucket: run the files one after another
    fileParallelism: false,
  },
});
