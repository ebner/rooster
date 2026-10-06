#!/usr/bin/env node
// 10 §4: initial JS (gzip) for /o/:slug/my ≤ 450 KB (ADR 0016). Reads the Vite manifest of a
// web build and sums the gzip size of every JS chunk the browser loads to render that route:
// the entry, the route chunks on the matched path (`_app` → `_tasks` → `my`), their static
// imports, and the active locale's catalog (the larger one, to be safe), which `main.tsx`
// awaits before the first render. Other dynamic imports (palette, editor, popovers, settings,
// admin, …) are excluded by construction.
//
// Usage: node scripts/bundle-budget.mjs [distDir] [--verbose]
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = 450;
const ROUTE_CHAIN = [
  'src/routes/_app.tsx?tsr-split=component',
  'src/routes/_app/o.$orgSlug._tasks.tsx?tsr-split=component',
  'src/routes/_app/o.$orgSlug._tasks.my.tsx?tsr-split=component',
];

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const dist = resolve(args.find((a) => !a.startsWith('--')) ?? 'apps/web/dist');
const manifest = JSON.parse(readFileSync(join(dist, '.vite/manifest.json'), 'utf8'));

const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry);
const roots = [entryKey, ...ROUTE_CHAIN];
for (const key of roots) {
  if (!manifest[key]) {
    console.error(`bundle-budget: ${key} is missing from the manifest (route renamed?)`);
    process.exit(1);
  }
}

// The larger locale catalog stands in for "the active one" (main.tsx awaits it).
const catalogs = Object.keys(manifest).filter((k) => /\/catalog-[a-z]{2}\.ts$/.test(k));
if (catalogs.length === 0) {
  console.error('bundle-budget: no locale catalog chunks in the manifest (i18n/lazy.ts changed?)');
  process.exit(1);
}
const catalogSize = (key) => readFileSync(join(dist, manifest[key].file)).length;
const largestCatalog = catalogs.sort((a, b) => catalogSize(b) - catalogSize(a))[0];

const files = new Set();
const visit = (key) => {
  const chunk = manifest[key];
  if (!chunk || files.has(chunk.file)) return;
  files.add(chunk.file);
  for (const imported of chunk.imports ?? []) visit(imported);
};
for (const key of [...roots, largestCatalog]) visit(key);

const sizes = [...files]
  .filter((file) => file.endsWith('.js'))
  .map((file) => ({ file, gzip: gzipSync(readFileSync(join(dist, file)), { level: 9 }).length }))
  .sort((a, b) => b.gzip - a.gzip);
const totalKb = sizes.reduce((sum, s) => sum + s.gzip, 0) / 1024;

if (verbose) {
  for (const s of sizes) console.log(`${(s.gzip / 1024).toFixed(1).padStart(8)} KB  ${s.file}`);
}
const verdict = totalKb <= BUDGET_KB ? 'ok' : 'OVER BUDGET';
console.log(
  `bundle-budget: initial JS for /o/:slug/my = ${totalKb.toFixed(1)} KB gzip ` +
    `(${sizes.length} chunks; budget ${BUDGET_KB} KB) ${verdict}`,
);
process.exit(totalKb <= BUDGET_KB ? 0 : 1);
