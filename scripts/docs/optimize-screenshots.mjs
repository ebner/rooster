#!/usr/bin/env node
// Optimises captured screenshots into docs/screenshots: a lossless-looking 256-colour palette
// PNG (the UI is flat colour, so quantising is invisible) with maximum compression.
//   node scripts/docs/optimize-screenshots.mjs <raw dir> <out dir>
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { readShotMeta, writeShotMeta } from './png-meta.mjs';

// sharp is a dependency of the server (thumbnails), not of the root workspace.
const root = resolve(import.meta.dirname, '../..');
const sharp = createRequire(join(root, 'apps/server/package.json'))('sharp');

const [rawDir, outDir] = process.argv.slice(2);
if (!rawDir || !outDir) {
  console.error('usage: optimize-screenshots.mjs <raw dir> <out dir>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

let before = 0;
let after = 0;
for (const name of readdirSync(rawDir)
  .filter((f) => f.endsWith('.png'))
  .sort()) {
  const from = join(rawDir, name);
  const to = join(outDir, name);
  const png = await sharp(from)
    .png({ palette: true, quality: 95, effort: 10, compressionLevel: 9, dither: 0.6 })
    .toBuffer();
  // sharp drops the density and window width that shoot.ts recorded; the guide needs them.
  const meta = readShotMeta(readFileSync(from));
  writeFileSync(to, meta ? writeShotMeta(png, meta) : png);
  const a = statSync(from).size;
  const b = statSync(to).size;
  before += a;
  after += b;
  console.log(`${name.padEnd(48)} ${(b / 1024).toFixed(0).padStart(5)} KB`);
}
console.log(`total ${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(1)} MB`);
