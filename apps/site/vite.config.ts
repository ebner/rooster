import { defineConfig } from 'vite';
import { siteUrl } from './src/config.ts';

/** Only for `pnpm --filter @rooster/site preview`; the build runs from scripts/build.ts. */
export default defineConfig({
  base: siteUrl().pathname,
  preview: { port: 4173 },
});
