import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The live smoke test hits the real API and is opt-in via CH_LIVE_SMOKE=1.
    // It is excluded from the default run so that `npm test` works offline
    // and without an API key.
    exclude: process.env['CH_LIVE_SMOKE'] ? [] : ['tests/live.smoke.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85
      }
    }
  }
});
