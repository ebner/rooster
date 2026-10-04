import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@rooster/i18n',
    include: ['test/**/*.test.ts'],
  },
});
