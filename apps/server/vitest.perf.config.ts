import { defineProject } from 'vitest/config';

/** The AC-11.4 timing budgets, run on their own (`pnpm --filter @rooster/server test:perf`). */
export default defineProject({
  test: {
    name: '@rooster/server-perf',
    environment: 'node',
    include: ['test/**/*.perf.test.ts'],
    fileParallelism: false,
  },
});
