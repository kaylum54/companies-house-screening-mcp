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
      // bin.ts is covered by tests/bin.test.ts, which spawns it as a real
      // process — the only way to exercise the shebang, the stdio framing and
      // the config exit code. In-process v8 instrumentation cannot see a
      // subprocess, so leaving it in would report 0% for a file that is
      // tested, and the number would push everyone towards deleting the
      // better test.
      exclude: ['src/bin.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85
      }
    }
  }
});
