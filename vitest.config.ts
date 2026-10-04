import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/server', 'apps/web'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**'],
      thresholds: {
        'packages/core/src/**': { lines: 95, functions: 95, branches: 90, statements: 95 },
      },
    },
  },
});
