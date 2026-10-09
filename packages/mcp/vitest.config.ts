import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@rooster/mcp',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // CI runners are UTC; pin it so a local run in another zone can't hide a host-zone bug.
    env: { TZ: 'UTC' },
  },
});
