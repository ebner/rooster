import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';

// Scalar's browser bundle is not in its export map; locate it next to the package entry.
const scalarBundle = join(
  dirname(fileURLToPath(import.meta.resolve('@scalar/api-reference'))),
  'browser',
  'standalone.js',
);

// Native modules cannot be bundled; they are installed into the runtime image separately
// (see docker/Dockerfile). Everything else — including the TypeScript-source workspace
// packages — is inlined so the image needs no node_modules beyond these.
export const NATIVE_DEPS = ['better-sqlite3', 'sharp'];

// `@react-email/render` imports prettier for its `pretty` option, which is never used
// (src/mail/render.ts); a throwing stub keeps prettier out of the bundle.
const prettierStub = fileURLToPath(new URL('./src/mail/prettier-stub.ts', import.meta.url));

export default defineConfig({
  entry: ['src/main.ts', 'src/healthcheck.ts'],
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node24',
  dts: false,
  clean: true,
  // The image runs with NODE_ENV=production (docker/Dockerfile); fixing it at build time lets
  // the bundler drop the development builds of React that CJS packages select at runtime.
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  alias: {
    'prettier/standalone': prettierStub,
    'prettier/plugins/html': prettierStub,
  },
  deps: {
    alwaysBundle: (id) => !NATIVE_DEPS.some((dep) => id === dep || id.startsWith(`${dep}/`)),
    onlyBundle: false,
  },
  copy: [
    // Resolved at runtime as `<dir of main.js>/migrations` (see src/db/migrate.ts).
    { from: 'src/db/migrations', to: 'dist' },
    // Served at /api/docs/scalar.js (see src/app.ts); no CDN (08 §10).
    { from: scalarBundle, to: 'dist/vendor' },
  ],
  fixedExtension: false,
});
