import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@rooster/tokens',
    include: ['test/**/*.test.ts'],
  },
});
