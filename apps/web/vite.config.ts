import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import optimizeLocales from '@react-aria/optimize-locales-plugin';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { guidePlugin } from './src/features/help/guide-build.ts';

/** The API server started by `pnpm dev` (apps/server); e2e points it at its own server. */
const apiTarget = process.env.ROOSTER_API_TARGET ?? 'http://localhost:3000';
const proxied = ['/api', '/healthz', '/readyz', '/ical', '/unsubscribe'];
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  define: {
    // The SSE `hello` handshake compares these with the server's (04 §6.3).
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_GIT_SHA__: JSON.stringify(process.env.ROOSTER_GIT_SHA ?? 'dev'),
  },
  plugins: [
    // Must run before the React plugin so route files are code-split first.
    tanstackRouter({ target: 'react', autoCodeSplitting: true, quoteStyle: 'single' }),
    react(),
    // 10 §4: react-aria bundles UI strings for ~34 locales; keep only the ones we ship.
    { ...optimizeLocales.vite({ locales: ['en-US', 'sv-SE'] }), enforce: 'pre' as const },
    tailwindcss(),
    // ADR 0052 §2: the user guide (docs/guide) as HTML, one lazy chunk per locale.
    guidePlugin({
      guideDir: `${repoRoot}docs/guide`,
      repoRoot,
      repoUrl: 'https://github.com/201works/rooster',
      locales: ['en', 'sv'],
    }),
    // 04 §6.3: a custom service worker (injectManifest), registered by the app with an
    // update prompt (`features/pwa`). Off in `vite` dev unless VITE_PWA_DEV=1.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      manifestFilename: 'manifest.webmanifest',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
        // Guide screenshots are cached when viewed (sw.ts), not at install (ADR 0052 §2).
        globIgnores: ['**/*.map', 'assets/guide/**'],
      },
      devOptions: { enabled: process.env.VITE_PWA_DEV === '1', type: 'module' },
      // FR-PWA-1, 02 §13.5.
      manifest: {
        id: '/',
        name: 'rooster',
        short_name: 'rooster',
        description: 'A calm, keyboard-first task manager.',
        lang: 'en',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        theme_color: '#ffffff',
        // The splash screen behind the icon: the icon's cream tile (amber-50).
        background_color: '#fffbeb',
        categories: ['productivity'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  server: {
    proxy: Object.fromEntries(
      proxied.map((path) => [path, { target: apiTarget, changeOrigin: false }]),
    ),
  },
  build: {
    target: 'es2023',
    sourcemap: 'hidden',
    // `scripts/bundle-budget.mjs` walks it (10 §4).
    manifest: true,
  },
});
