import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@rooster/server',
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Timing budgets (AC-11.4) are meaningless under coverage and parallel workers: they run
    // alone in their own CI step (`pnpm --filter @rooster/server test:perf`).
    exclude: ['test/**/*.perf.test.ts', '**/node_modules/**'],
    // CI runners are UTC; pin it so a local run in another zone can't hide a host-zone bug.
    env: { TZ: 'UTC' },
  },
});
