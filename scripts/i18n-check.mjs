#!/usr/bin/env node
// i18n gate (10 §1): every key of every namespace exists in every locale, no value is
// empty, every message is valid ICU with the same arguments as English, and every
// key is referenced from source code. Exits 1 with a readable report otherwise.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const localesDir = join(root, 'packages/i18n/locales');
const referenceLocale = 'en';
const sourceRoots = ['apps', 'packages'];
const sourceExtensions = /\.(ts|tsx|mts|js|mjs)$/;
const skipDirs = new Set(['node_modules', 'dist', 'build', 'locales', 'test-results', 'coverage']);

const problems = [];
const report = (message) => problems.push(message);

function flatten(tree, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else if (value && typeof value === 'object') flatten(value, path, out);
    else report(`${path}: expected a string or object, got ${JSON.stringify(value)}`);
  }
  return out;
}

async function loadMessageFormat() {
  try {
    const require = createRequire(join(root, 'packages/i18n/package.json'));
    const mod = await import(pathToFileURL(require.resolve('intl-messageformat')).href);
    return mod.IntlMessageFormat;
  } catch {
    console.warn('i18n-check: intl-messageformat not resolvable; skipping ICU validation.');
    return undefined;
  }
}

function collectArguments(elements, out = new Set()) {
  for (const el of elements) {
    if (typeof el.value === 'string' && el.type !== 0 && el.type !== 7) out.add(el.value);
    for (const option of Object.values(el.options ?? {})) collectArguments(option.value, out);
    if (Array.isArray(el.children)) collectArguments(el.children, out);
  }
  return out;
}

function listSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (skipDirs.has(entry) || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listSourceFiles(path, out);
    else if (sourceExtensions.test(entry) && !entry.endsWith('.gen.ts')) out.push(path);
  }
  return out;
}

const locales = readdirSync(localesDir).filter((d) => statSync(join(localesDir, d)).isDirectory());
if (!locales.includes(referenceLocale)) {
  console.error(`i18n-check: reference locale "${referenceLocale}" missing in ${localesDir}`);
  process.exit(1);
}

const namespaces = new Set(
  locales.flatMap((l) => readdirSync(join(localesDir, l)).filter((f) => f.endsWith('.json'))),
);
const MessageFormat = await loadMessageFormat();
const catalogs = new Map();

for (const file of [...namespaces].sort()) {
  const ns = file.replace(/\.json$/, '');
  const byLocale = new Map();
  for (const locale of locales) {
    const path = join(localesDir, locale, file);
    try {
      byLocale.set(locale, flatten(JSON.parse(readFileSync(path, 'utf8'))));
    } catch (error) {
      report(`${locale}/${file}: ${error.code === 'ENOENT' ? 'file missing' : error.message}`);
      byLocale.set(locale, new Map());
    }
  }
  catalogs.set(ns, byLocale.get(referenceLocale));

  const allKeys = new Set([...byLocale.values()].flatMap((m) => [...m.keys()]));
  for (const key of [...allKeys].sort()) {
    const reference = byLocale.get(referenceLocale).get(key);
    let referenceArgs;
    for (const locale of locales) {
      const message = byLocale.get(locale).get(key);
      const id = `${locale}/${ns}:${key}`;
      if (message === undefined) {
        report(`${id}: missing (en: ${JSON.stringify(reference ?? '')})`);
        continue;
      }
      if (message.trim() === '') report(`${id}: empty value`);
      if (!MessageFormat) continue;
      try {
        const args = collectArguments(new MessageFormat(message, locale).getAst());
        if (locale === referenceLocale) referenceArgs = args;
        else if (referenceArgs) {
          const a = [...args].sort().join(', ');
          const b = [...referenceArgs].sort().join(', ');
          if (a !== b) report(`${id}: arguments {${a}} differ from en {${b}}`);
        }
      } catch (error) {
        report(`${id}: invalid ICU message (${error.message})`);
      }
    }
  }
}

// Unused keys: a key counts as used when its full path appears as a string literal
// (optionally with an `ns:` prefix), or when a template literal starts with one of
// its parent paths, e.g. `sync.${state}` covers every key under `sync.`.
const sources = sourceRoots
  .flatMap((dir) => listSourceFiles(join(root, dir)))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
const templatePrefixes = new Set(
  [...sources.matchAll(/`(?:[\w-]+:)?([\w.-]+\.)\$\{/g)].map((m) => m[1]),
);
for (const [ns, keys] of catalogs) {
  for (const key of keys.keys()) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const literal = new RegExp(`['"\`](?:${ns}:)?${escaped}['"\`]`);
    const dynamic = [...templatePrefixes].some((prefix) => key.startsWith(prefix));
    if (!literal.test(sources) && !dynamic) report(`${ns}:${key}: unused (no reference in source)`);
  }
}

if (problems.length > 0) {
  console.error(`i18n-check: ${problems.length} problem(s) in ${relative(root, localesDir)}\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `i18n-check: ${locales.join(', ')} agree on ${[...catalogs.values()].reduce((n, m) => n + m.size, 0)} keys in ${catalogs.size} namespace(s).`,
);
