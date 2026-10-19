import { defineConfig } from 'vitest/config';

// Live sandbox tests: opt-in only, never part of `npm test`. See test/sandbox/README.md.
export default defineConfig({
  test: {
    include: ['test/sandbox/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
