import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@rooster/core',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
