import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@rooster/i18n',
    include: ['test/**/*.test.ts'],
    // CI runners are UTC; pin it so a local run in another zone can't hide a host-zone bug.
    env: { TZ: 'UTC' },
  },
});
