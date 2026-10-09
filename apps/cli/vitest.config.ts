import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@rooster/cli',
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: 30_000,
  },
});
