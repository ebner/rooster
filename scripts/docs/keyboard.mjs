#!/usr/bin/env node
// `pnpm docs:keyboard` (ADR 0052 §2, hard rule 8): writes docs/guide/{en,sv}/keyboard.md from the
// keymap registry (apps/web/src/keymap.ts) and the en/sv catalogs, the same source and grouping
// as the `?` cheat sheet. `--check` writes nothing and exits 1 when a file is out of date (CI).
// Runs under plain Node 24: the TypeScript modules it imports are erasable-syntax only.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const check = process.argv.includes('--check');
const { renderKeyboardDoc } = await import(
  pathToFileURL(join(root, 'apps/web/src/features/help/keyboard-doc.ts')).href
);

const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const { pages } = readJson('docs/guide/pages.json');
const page = pages.find((p) => p.slug === 'keyboard');
if (!page) {
  console.error('docs:keyboard: docs/guide/pages.json has no "keyboard" page');
  process.exit(1);
}

let stale = 0;
for (const locale of ['en', 'sv']) {
  const markdown = renderKeyboardDoc({
    title: page.title[locale] ?? page.title.en,
    list: readJson(`packages/i18n/locales/${locale}/list.json`),
    help: readJson(`packages/i18n/locales/${locale}/help.json`),
  });
  const file = join(root, 'docs/guide', locale, 'keyboard.md');
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {}
  const name = relative(root, file);
  if (current === markdown) {
    if (!check) console.log(`docs:keyboard: ${name} is up to date`);
  } else if (check) {
    stale += 1;
    console.error(`docs:keyboard: ${name} is out of date; run pnpm docs:keyboard`);
  } else {
    writeFileSync(file, markdown);
    console.log(`docs:keyboard: wrote ${name}`);
  }
}
if (stale > 0) process.exit(1);
