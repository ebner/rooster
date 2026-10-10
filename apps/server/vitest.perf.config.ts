import { defineProject } from 'vitest/config';

/** The AC-11.4 timing budgets, run on their own (`pnpm --filter @rooster/server test:perf`). */
export default defineProject({
  test: {
    name: '@rooster/server-perf',
    environment: 'node',
    include: ['test/**/*.perf.test.ts'],
    fileParallelism: false,
    // CI runners are UTC; pin it so a local run in another zone can't hide a host-zone bug.
    env: { TZ: 'UTC' },
  },
});
