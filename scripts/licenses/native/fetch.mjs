#!/usr/bin/env node
// Downloads the licence files of the libraries inside rooster's native bundles: the Bun runtime
// in the CLI binaries and the prebuilt libvips (@img/sharp-libvips-linux-x64) in the Docker
// image. manifest.json names every library, the version the bundle ships and the upstream URL of
// each file; scripts/third-party-notices.mjs renders the files offline. Run this when the Bun
// pin or sharp-libvips moves, after updating manifest.json.
//
//   node scripts/licenses/native/fetch.mjs            # (re)write every file
//   node scripts/licenses/native/fetch.mjs --verify   # write nothing; exit 1 on a difference
//
// Bun's Node.js polyfills (src/node-fallbacks) are npm packages: the list comes from the
// bun.lock that manifest.json names, the files from each package's registry tarball (read in
// memory, never unpacked), and polyfills.json records what was found.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const here = fileURLToPath(new URL('.', import.meta.url));
const verify = process.argv.includes('--verify');
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
const differences = [];
// Every file this run produces; anything else under bun/ and sharp-libvips/ is stale.
const written = new Set();

const normalize = (text) =>
  `${text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')}\n`;

async function download(url) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { redirect: 'follow' });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    // raw.githubusercontent.com rate-limits bursts.
    if ((response.status === 429 || response.status >= 500) && attempt < 6) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
      continue;
    }
    throw new Error(`${url}: HTTP ${response.status}`);
  }
}

function pick(text, lines) {
  if (!lines) return text;
  const all = text.split('\n');
  const ranges = Array.isArray(lines[0]) ? lines : [lines];
  return ranges.map(([from, to]) => all.slice(from - 1, to).join('\n')).join('\n[...]\n');
}

function store(path, text) {
  written.add(path);
  const file = join(here, path);
  let current = null;
  try {
    current = readFileSync(file, 'utf8');
  } catch {}
  if (current === text) return;
  if (verify) {
    differences.push(path);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  console.log(`fetch: wrote ${path}`);
}

// ---- the libraries ----

async function fetchLibraries() {
  for (const lib of manifest.libraries) {
    for (const file of lib.files) {
      let body = await download(file.url);
      if (file.base64) body = Buffer.from(body.toString('utf8'), 'base64');
      const text = normalize(pick(body.toString('utf8'), file.lines));
      if (text.trim().length === 0) throw new Error(`${file.url}: empty`);
      store(file.path, text);
    }
  }
}

// ---- the polyfills ----

const LICENCE_FILE = /^(licen[cs]e|copying|notice|copyright)s?([-_.][^/]*)?$/i;
const NOT_A_TEXT = /\.(c?js|mjs|ts|cts|mts|json|map|html?)$/i;

/** The top-level files of an npm tarball (ustar), by name. */
function tarballFiles(gz) {
  const tar = gunzipSync(gz);
  const files = new Map();
  let at = 0;
  let longName = null;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (from, length) =>
      header
        .subarray(from, from + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    const prefix = field(345, 155);
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    const body = tar.subarray(at + 512, at + 512 + size);
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type === '0') {
      name = name.replace(/^[^/]+\//, '');
      if (!name.includes('/')) files.set(name, body);
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** The licence section of a README, as the notices generator reads it. */
function readmeLicence(text) {
  const lines = normalize(text).split('\n');
  const start = lines.findIndex((line) => /^#{1,6}\s+(licen[cs]e|licen[cs]ing)\b/i.test(line));
  if (start < 0) return null;
  const level = /^#+/.exec(lines[start])[0].length;
  let end = start + 1;
  while (end < lines.length) {
    const heading = /^(#+)\s/.exec(lines[end]);
    if (heading && heading[1].length <= level) break;
    end += 1;
  }
  const section = normalize(lines.slice(start, end).join('\n'));
  return section.trim().split('\n').length > 1 ? section : null;
}

const personName = (person) => {
  if (!person) return null;
  if (typeof person === 'string') return person.replace(/\s*[<(].*$/, '').trim() || null;
  return person.name?.trim() || null;
};

async function fetchPolyfills() {
  const { lockfile, extra = [] } = manifest.polyfills;
  // bun.lock is JSON with trailing commas.
  const lock = JSON.parse(
    (await download(lockfile)).toString('utf8').replace(/,(\s*[}\]])/g, '$1'),
  );
  const locked = new Set(Object.values(lock.packages).map((entry) => entry[0]));
  const specs = [...new Set([...locked, ...extra])].sort();
  const packages = [];
  for (const spec of specs) {
    const at = spec.lastIndexOf('@');
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    const base = name.split('/').pop();
    const files = tarballFiles(
      await download(`https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`),
    );
    const pkg = JSON.parse(files.get('package.json').toString('utf8'));
    const dir = `bun/polyfills/${name}@${version}`;
    const licence = [];
    for (const file of [...files.keys()].sort()) {
      if (!LICENCE_FILE.test(file) || NOT_A_TEXT.test(file)) continue;
      const text = normalize(files.get(file).toString('utf8'));
      if (text.trim().length === 0) continue;
      store(`${dir}/${file}`, text);
      licence.push({ name: file, path: `${dir}/${file}` });
    }
    let readme = null;
    if (licence.length === 0) {
      const file = [...files.keys()].find((f) => /^readme(\.md|\.markdown|\.txt)?$/i.test(f));
      const section = file ? readmeLicence(files.get(file).toString('utf8')) : null;
      if (section) {
        store(`${dir}/README.licence.txt`, section);
        readme = { name: `${file} (licence section)`, path: `${dir}/README.licence.txt` };
      }
    }
    const license = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? null);
    packages.push({
      name,
      version,
      license,
      author: personName(pkg.author) ?? personName(pkg.contributors?.[0]),
      locked: locked.has(spec),
      files: licence,
      readme,
    });
  }
  store('polyfills.json', `${JSON.stringify({ lockfile, packages }, null, 2)}\n`);
}

function removeStale() {
  for (const dir of ['bun', 'sharp-libvips']) {
    for (const entry of readdirSync(join(here, dir), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = relative(here, join(entry.parentPath, entry.name));
      if (written.has(path)) continue;
      if (verify) differences.push(`${path} (not in the manifest)`);
      else {
        rmSync(join(here, path));
        console.log(`fetch: removed ${path}`);
      }
    }
  }
}

try {
  await fetchLibraries();
  await fetchPolyfills();
  removeStale();
} catch (error) {
  console.error(`fetch: ${error.message}`);
  process.exit(1);
}
if (differences.length > 0) {
  console.error(`fetch: out of date:\n  ${differences.join('\n  ')}`);
  process.exit(1);
}
if (verify) console.log('fetch: every file matches its source');
