import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@rooster/cli',
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: 30_000,
    // CI runners are UTC; pin it so a local run in another zone can't hide a host-zone bug.
    env: { TZ: 'UTC' },
  },
});
