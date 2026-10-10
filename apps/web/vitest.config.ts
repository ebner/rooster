import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { guidePlugin } from './src/features/help/guide-build.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  // The guide's virtual modules (ADR 0052 §2) resolve in tests too; tests may still mock them.
  plugins: [
    react(),
    guidePlugin({ guideDir: `${repoRoot}docs/guide`, repoRoot, locales: ['en', 'sv'] }),
  ],
  test: {
    name: '@rooster/web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    // CI runners are UTC; pin it so a local run in another zone can't hide a host-zone bug.
    env: { TZ: 'UTC' },
  },
});
