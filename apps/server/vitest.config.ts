import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@rooster/server',
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
