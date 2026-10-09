import { defineConfig } from 'tsdown';

// The publishable build (`publishConfig.exports`): ESM plus bundled declarations, including
// the generated `schema.d.ts`. Inside the monorepo the package is consumed from `src/`.
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: 'esm',
  platform: 'neutral',
  target: 'es2023',
  dts: true,
  clean: true,
  fixedExtension: false,
});
