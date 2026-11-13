import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: '@rooster/site', environment: 'node', env: { TZ: 'UTC' } },
});
