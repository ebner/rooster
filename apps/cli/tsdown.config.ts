import { defineConfig } from 'tsdown';

// The native keychain addon cannot be bundled; it is an optional runtime dependency that
// `src/secrets.ts` imports lazily (07 §1). Everything else, the workspace packages included,
// is inlined so `dist/rooster.mjs` runs with nothing but Node.
export const NATIVE_DEPS = ['@napi-rs/keyring'];

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
    alwaysBundle: (id) => !NATIVE_DEPS.some((dep) => id === dep || id.startsWith(`${dep}/`)),
    onlyBundle: false,
  },
});
