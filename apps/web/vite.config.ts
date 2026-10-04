import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** The API server started by `pnpm dev` (apps/server). */
const apiTarget = 'http://localhost:3000';
const proxied = ['/api', '/healthz', '/readyz', '/ical'];

export default defineConfig({
  plugins: [
    // Must run before the React plugin so route files are code-split first.
    tanstackRouter({ target: 'react', autoCodeSplitting: true, quoteStyle: 'single' }),
    react(),
    tailwindcss(),
  ],
  server: {
    proxy: Object.fromEntries(
      proxied.map((path) => [path, { target: apiTarget, changeOrigin: false }]),
    ),
  },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
});
