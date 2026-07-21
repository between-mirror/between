import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 20000,
    // The mock engine is test-only (P0-5). The harness opts in explicitly; production never sets this,
    // so a packaged build cannot run the mock even by accident.
    env: { BETWEEN_ALLOW_MOCK: '1' },
  },
});
