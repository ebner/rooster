import { defineConfig } from 'tsdown';

// The native keychain addon cannot be bundled; it is an optional runtime dependency that
// `src/secrets.ts` imports lazily (07 §1). Everything else, the workspace packages included,
// is inlined so `dist/rooster.mjs` runs with nothing but Node.
export const NATIVE_DEPS = ['@napi-rs/keyring'];
/**
 * Ink's React DevTools hook (P9 TUI): imported only with `DEV=true` and only when the package
 * resolves (`ink/build/reconciler.js`), so it stays an external nobody installs.
 */
export const DEV_ONLY_DEPS = ['react-devtools-core'];

export default defineConfig({
  entry: { rooster: 'src/main.ts' },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  clean: true,
  minify: true,
  outExtensions: () => ({ js: '.mjs' }),
  deps: {
    neverBundle: DEV_ONLY_DEPS,
    alwaysBundle: (id) =>
      ![...NATIVE_DEPS, ...DEV_ONLY_DEPS].some((dep) => id === dep || id.startsWith(`${dep}/`)),
    onlyBundle: false,
  },
});
