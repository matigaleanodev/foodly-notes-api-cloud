import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { reporters: ['verbose'], testTimeout: 15000, hookTimeout: 120000, fileParallelism: false },
});
