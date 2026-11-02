#!/usr/bin/env node
// `pnpm notices`: writes THIRD-PARTY-NOTICES.txt, the licences and notices of the third-party
// software in rooster's distributions: the Docker image (the server bundle, the native modules
// installed next to it and the web app it serves) and the CLI (dist/rooster.mjs and the
// Bun-compiled binaries). `--check` writes nothing and exits 1 when the file is out of date (CI).
//
// The dependency graph comes from the installed node_modules (pnpm's layout: a package's
// dependencies are its siblings in node_modules/.pnpm/<id>/node_modules), not from a build, so
// the check needs none. The output is deterministic: sorted, no timestamps, no absolute paths.
// Platform-specific packages are taken for linux-x64 glibc, the platform the release image is
// built on, so the file is generated there (CI and the release host); elsewhere `--check` skips.
//
// Licence texts that packages do not ship, and the entries that are not npm packages (the
// Fraunces outlines in the wordmark, the Bun runtime), live in scripts/licenses/.
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const OUT = 'THIRD-PARTY-NOTICES.txt';
const TEXTS = join(root, 'scripts/licenses');
const check = process.argv.includes('--check');
const TARGET = { os: 'linux', cpu: 'x64', libc: 'glibc' };

/**
 * What each distribution contains. `fields` are the manifest fields whose packages end up in
 * it, with their dependencies. `extra` are packages outside those fields whose code is copied
 * into the output (`via` resolves a dependency of the named package; `deps: false` takes the
 * package alone; `sourceMap` keeps only the packages a prebuilt bundle's map names).
 * `exclude` are packages the build leaves out, with everything only they bring in.
 */
const DISTRIBUTIONS = [
  {
    id: 'image:server',
    label: 'Docker image: server',
    app: 'apps/server',
    fields: ['dependencies', 'optionalDependencies'],
    extra: [
      // dist/vendor/standalone.js, served at /api/docs/scalar.js (tsdown.config.ts `copy`).
      {
        name: '@scalar/api-reference',
        deps: true,
        sourceMap: 'dist/browser/standalone.js.map',
      },
      // The bundler's runtime helpers in dist/*.js.
      { name: 'tsdown', via: 'rolldown', deps: false },
    ],
    // Aliased to a throwing stub (tsdown.config.ts).
    exclude: ['prettier'],
  },
  {
    id: 'image:web',
    label: 'Docker image: web app',
    app: 'apps/web',
    fields: ['dependencies', 'optionalDependencies'],
    extra: [
      // The module preload helper and polyfill in the built chunks.
      { name: 'vite', deps: false },
      { name: 'vite', via: 'rolldown', deps: false },
      // `virtual:pwa-register` (features/pwa/sw-registration.ts).
      { name: 'vite-plugin-pwa', deps: false },
      // The generated CSS, its preflight included.
      { name: 'tailwindcss', deps: false },
    ],
    exclude: [],
  },
  {
    id: 'cli',
    label: 'CLI',
    app: 'apps/cli',
    // The CLI bundles its devDependencies into dist/rooster.mjs (tsdown.config.ts), except
    // these build and test tools.
    fields: ['dependencies', 'optionalDependencies', 'devDependencies'],
    devTools: [
      '@modelcontextprotocol/client',
      'ink-testing-library',
      'tsdown',
      'tsx',
      'typescript',
      'vitest',
    ],
    extra: [{ name: 'tsdown', via: 'rolldown', deps: false }],
    // The keychain addon stays outside the bundle and the binaries (build-binaries.sh), and
    // Ink's React DevTools hook is aliased to a no-op (tsdown.config.ts).
    exclude: ['@napi-rs/keyring', 'react-devtools-core'],
  },
];

/** Entries that are not npm packages. */
const MANUAL = [
  {
    name: 'Fraunces (glyph outlines)',
    license: 'OFL-1.1',
    homepage: 'https://github.com/undercasetype/Fraunces',
    in: ['image:server', 'image:web'],
    note: [
      'The "rooster" wordmark (apps/web/src/ui/brand.ts) is drawn from Fraunces glyph',
      'outlines. It is in the web app, its icons and the logo of the emails the server sends.',
    ],
    files: [{ name: 'OFL.txt', text: 'Fraunces-OFL.txt' }],
  },
  {
    name: 'Bun runtime',
    license: 'MIT, with LGPL-2.0 and LGPL-2.1 parts',
    homepage: 'https://bun.sh',
    repository: 'https://github.com/oven-sh/bun',
    in: ['cli'],
    note: [
      'The single-file CLI binaries are built with `bun build --compile` and embed the Bun',
      'runtime. Bun is MIT-licensed; its LICENSE.md names no copyright holder. It statically',
      'links JavaScriptCore and WebKit (LGPL-2.0) and tinycc (LGPL-2.1), among the libraries',
      "listed below. Bun's patched WebKit is at https://github.com/oven-sh/webkit, and the",
      'LICENSE.md below says how to relink Bun with a changed JavaScriptCore; a binary can',
      "then be rebuilt from dist/rooster.mjs with apps/cli/scripts/build-binaries.sh. Bun's",
      'LICENSE.md is reproduced as published with Bun 1.4.3; the release workflow builds',
      'with the Bun current at release time.',
    ],
    files: [
      { name: 'LICENSE.md', text: 'Bun-LICENSE.md' },
      { name: 'MIT licence text', text: 'MIT.txt', copyright: null },
      { name: 'LGPL-2.0 (JavaScriptCore, WebKit)', text: 'LGPL-2.0.txt' },
      { name: 'LGPL-2.1 (tinycc)', text: 'LGPL-2.1.txt' },
    ],
  },
];

/** Standard texts for packages that ship no licence file, by SPDX id. */
const STANDARD_TEXTS = {
  MIT: ['MIT.txt'],
  'Apache-2.0': ['Apache-2.0.txt'],
  'LGPL-3.0-or-later': ['LGPL-3.0.txt', 'GPL-3.0.txt'],
  'MPL-2.0': ['MPL-2.0.txt'],
};

/**
 * Licences that must travel in full: a package whose files carry only a short notice (MPL's
 * Exhibit A, an Apache header) gets the standard text too. The marker is a line of the full text.
 */
const FULL_TEXT = {
  'Apache-2.0': 'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
  'MPL-2.0': '1.1. "Contributor"',
};

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const readText = (path) => normalize(readFileSync(path, 'utf8'));

function normalize(text) {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

// ---- the dependency graph ----

function matchesPlatform(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true;
  if (list.includes(`!${value}`)) return false;
  const allowed = list.filter((v) => !v.startsWith('!'));
  return allowed.length === 0 || allowed.includes(value);
}

const forTarget = (pkg) =>
  matchesPlatform(pkg.os, TARGET.os) &&
  matchesPlatform(pkg.cpu, TARGET.cpu) &&
  matchesPlatform(pkg.libc, TARGET.libc);

/** A dependency as pnpm links it: nested, or a sibling in the package's .pnpm entry. */
function resolveDep(fromDir, name) {
  const candidates = [join(fromDir, 'node_modules', name)];
  const marker = `${sep}node_modules${sep}.pnpm${sep}`;
  const at = fromDir.indexOf(marker);
  if (at >= 0) {
    const entry = fromDir.slice(at + marker.length).split(sep)[0];
    candidates.push(join(fromDir.slice(0, at + marker.length), entry, 'node_modules', name));
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
  }
  return null;
}

const isWorkspace = (dir) => !dir.split(sep).includes('node_modules');

/** The package names a prebuilt bundle's source map takes code from. */
function bundledNames(pkgDir, mapPath, scope) {
  const names = new Set();
  for (const source of readJson(join(pkgDir, mapPath)).sources) {
    const at = source.lastIndexOf('node_modules/');
    if (at >= 0) {
      const parts = source.slice(at + 'node_modules/'.length).split('/');
      names.add(parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]);
    } else {
      // Sibling packages of the same monorepo appear as ../../../<dir>/src/….
      const sibling = /^(?:\.\.\/){3}([^./][^/]*)\//.exec(source);
      if (sibling) names.add(`${scope}/${sibling[1]}`);
    }
  }
  return names;
}

/** Every package in one distribution: real directory → manifest. */
function collect(dist) {
  const appDir = join(root, dist.app);
  const manifest = readJson(join(appDir, 'package.json'));
  const exclude = new Set(dist.exclude);
  const found = new Map();
  const visit = (dir, into) => {
    if (into.has(dir)) return;
    const pkg = readJson(join(dir, 'package.json'));
    if (exclude.has(pkg.name) || pkg.name.startsWith('@types/') || !forTarget(pkg)) return;
    into.set(dir, pkg);
    const names = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);
    for (const peer of Object.keys(pkg.peerDependencies ?? {})) {
      if (!pkg.peerDependenciesMeta?.[peer]?.optional) names.add(peer);
    }
    for (const name of [...names].sort()) {
      const resolved = resolveDep(dir, name);
      if (resolved) visit(resolved, into);
    }
  };
  const devTools = new Set(dist.devTools ?? []);
  for (const field of dist.fields) {
    for (const name of Object.keys(manifest[field] ?? {}).sort()) {
      if (field === 'devDependencies' && devTools.has(name)) continue;
      if (exclude.has(name)) continue;
      const resolved = resolveDep(appDir, name);
      if (resolved) visit(resolved, found);
      else if (field !== 'optionalDependencies') {
        throw new Error(`${dist.app}: ${name} is not installed (run pnpm install)`);
      }
    }
  }
  for (const extra of dist.extra) {
    let dir = resolveDep(appDir, extra.name);
    if (dir && extra.via) dir = resolveDep(dir, extra.via);
    if (!dir) throw new Error(`${dist.app}: ${extra.via ?? extra.name} is not installed`);
    if (!extra.deps) {
      found.set(dir, readJson(join(dir, 'package.json')));
    } else if (!extra.sourceMap) {
      visit(dir, found);
    } else {
      const tree = new Map();
      visit(dir, tree);
      const pkg = tree.get(dir);
      const keep = bundledNames(dir, extra.sourceMap, pkg.name.split('/')[0]);
      keep.add(pkg.name);
      const seen = new Set();
      for (const [d, p] of tree) {
        if (!keep.has(p.name)) continue;
        seen.add(p.name);
        found.set(d, p);
      }
      const missing = [...keep].filter((name) => !seen.has(name));
      if (missing.length > 0) {
        throw new Error(`${extra.name}: bundled but not installed: ${missing.join(', ')}`);
      }
    }
  }
  for (const dir of [...found.keys()]) if (isWorkspace(dir)) found.delete(dir);
  return found;
}

// ---- package metadata and licence texts ----

const LICENCE_FILE = /^(licen[cs]e|copying|notice|copyright)s?([-_.][^/]*)?$/i;
const NOT_A_TEXT = /\.(c?js|mjs|ts|cts|mts|json|map|html?)$/i;

function licenceFiles(dir) {
  return readdirSync(dir)
    .filter((name) => LICENCE_FILE.test(name) && !NOT_A_TEXT.test(name))
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort(byText((name) => `${name.toLowerCase()}\0${name}`))
    .map((name) => ({ name, text: readText(join(dir, name)) }))
    .filter((file) => file.text.length > 0);
}

function licenceId(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    const ids = pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).filter(Boolean);
    if (ids.length > 0) return ids.length === 1 ? ids[0] : `(${ids.join(' OR ')})`;
  }
  return null;
}

function personName(person) {
  if (!person) return null;
  if (typeof person === 'string') return person.replace(/\s*[<(].*$/, '').trim() || null;
  return person.name?.trim() || null;
}

function repositoryUrl(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!repo) return null;
  let url = repo.trim();
  const short = /^(github|gitlab|bitbucket):(.+)$/.exec(url);
  if (short) url = `https://${short[1]}.${short[1] === 'bitbucket' ? 'org' : 'com'}/${short[2]}`;
  else if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  url = url
    .replace(/^git\+/, '')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^(git|ssh|http):\/\/(git@)?/, 'https://')
    .replace(/\.git$/, '');
  const directory = typeof pkg.repository === 'object' ? pkg.repository.directory : null;
  if (directory && /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(url)) {
    url += `/tree/HEAD/${directory.replace(/^\/+/, '')}`;
  }
  return url;
}

/** The licence section of a README, for packages without a licence file. */
function readmeLicence(dir) {
  const readme = readdirSync(dir).find((name) => /^readme(\.md|\.markdown|\.txt)?$/i.test(name));
  if (!readme) return null;
  const lines = readText(join(dir, readme)).split('\n');
  const start = lines.findIndex((line) => /^#{1,6}\s+(licen[cs]e|licen[cs]ing)\b/i.test(line));
  if (start < 0) return null;
  const level = /^#+/.exec(lines[start])[0].length;
  let end = start + 1;
  while (end < lines.length) {
    const heading = /^(#+)\s/.exec(lines[end]);
    if (heading && heading[1].length <= level) break;
    end += 1;
  }
  const text = normalize(lines.slice(start, end).join('\n'));
  return text.split('\n').length > 1 ? { name: `${readme} (licence section)`, text } : null;
}

/** Fills a template's copyright line, or drops the line when nobody is named. */
const withHolder = (text, holder) =>
  holder ? text.replace('{copyright}', holder) : text.replace(/^Copyright.*\{copyright\}\n\n/m, '');

function standardTexts(id, holder) {
  const files = STANDARD_TEXTS[id];
  if (!files) return null;
  return files.map((file) => {
    const text = readText(join(TEXTS, file));
    return {
      name: `${file.replace(/\.txt$/, '')} (standard text)`,
      text: withHolder(text, holder),
      templated: text.includes('{copyright}'),
    };
  });
}

function wrap(text, width = 86) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return [...lines, line];
}

// ---- ordering ----

function byText(key) {
  return (a, b) => {
    const x = key(a);
    const y = key(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
}

function compareVersions(a, b) {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    if (x === y) continue;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return 0;
}

// ---- building the file ----

function packageEntries() {
  const byKey = new Map();
  for (const dist of DISTRIBUTIONS) {
    for (const [dir, pkg] of collect(dist)) {
      const key = `${pkg.name}@${pkg.version}`;
      const entry = byKey.get(key) ?? { dir, pkg, in: new Set() };
      entry.in.add(dist.id);
      byKey.set(key, entry);
    }
  }
  const problems = [];
  const entries = [...byKey.values()].map(({ dir, pkg, in: dists }) => {
    const license = licenceId(pkg);
    if (!license) problems.push(`${pkg.name}@${pkg.version}: no licence in package.json`);
    let files = licenceFiles(dir);
    let note = null;
    if (files.length === 0) {
      const author = personName(pkg.author) ?? personName(pkg.contributors?.[0]);
      const holder = author ?? `the authors of ${pkg.name}`;
      const standard = standardTexts(license, holder);
      if (!standard) {
        problems.push(
          `${pkg.name}@${pkg.version}: no licence file and no standard text for ${license}`,
        );
      }
      const readme = readmeLicence(dir);
      files = [...(readme ? [readme] : []), ...(standard ?? [])];
      const templated = (standard ?? []).some((f) => f.templated);
      const holderNote = !templated
        ? '.'
        : author
          ? ', with the copyright holder from the author field of its package.json.'
          : '; its package.json names no author.';
      const what = readme
        ? 'The licence section of its README and the standard text of its licence follow'
        : 'The standard text of its licence follows';
      note = wrap(`The package ships no licence file. ${what}${holderNote}`);
      files = files.map(({ name, text }) => ({ name, text }));
    } else if (FULL_TEXT[license] && !files.some((f) => f.text.includes(FULL_TEXT[license]))) {
      files.push(...standardTexts(license, '').map(({ name, text }) => ({ name, text })));
      note = wrap(`Its licence file is a short notice; the standard text of ${license} follows.`);
    }
    return {
      name: pkg.name,
      versions: [pkg.version],
      license: license ?? 'UNKNOWN',
      homepage: typeof pkg.homepage === 'string' ? pkg.homepage.trim() : null,
      repository: repositoryUrl(pkg),
      in: dists,
      note,
      files,
    };
  });
  if (problems.length > 0) {
    throw new Error(`licences to resolve by hand:\n  ${problems.join('\n  ')}`);
  }
  // One entry per package and licence content; versions with the same texts are merged.
  const merged = new Map();
  for (const entry of entries) {
    const key = JSON.stringify([entry.name, entry.license, entry.files]);
    const into = merged.get(key);
    if (!into) {
      merged.set(key, entry);
      continue;
    }
    into.versions.push(...entry.versions);
    for (const d of entry.in) into.in.add(d);
  }
  for (const entry of merged.values()) entry.versions.sort(compareVersions);
  return [...merged.values()].sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return compareVersions(a.versions[0], b.versions[0]);
  });
}

function manualEntries() {
  return MANUAL.map((m) => ({
    name: m.name,
    versions: [],
    license: m.license,
    homepage: m.homepage,
    repository: m.repository ?? null,
    in: new Set(m.in),
    note: m.note,
    files: m.files.map((f) => ({
      name: f.name,
      text: withHolder(readText(join(TEXTS, f.text)), f.copyright),
    })),
  }));
}

const RULE = '-'.repeat(78);
const HEAVY = '='.repeat(78);
const ORDER = DISTRIBUTIONS.map((d) => d.id);
const shipsIn = (set) =>
  ORDER.filter((id) => set.has(id))
    .map((id) => DISTRIBUTIONS.find((d) => d.id === id).label)
    .join('; ');

const title = (entry) => [entry.name, entry.versions.join(', ')].filter(Boolean).join(' ');
const describe = (dist, lines) =>
  lines.map((line, i) => `  ${(i === 0 ? dist.label : '').padEnd(23)}${line}`);

function render() {
  const manual = manualEntries();
  const packages = packageEntries();
  const all = [...manual, ...packages];

  // Texts used by more than one entry are printed once, at the end.
  const uses = new Map();
  for (const entry of all) {
    for (const file of entry.files) {
      const list = uses.get(file.text) ?? [];
      if (!list.includes(entry)) list.push(entry);
      uses.set(file.text, list);
    }
  }
  const shared = new Map();
  for (const entry of all) {
    for (const file of entry.files) {
      if (uses.get(file.text).length > 1 && !shared.has(file.text)) {
        shared.set(file.text, `S${shared.size + 1}`);
      }
    }
  }

  const out = [];
  out.push(
    'THIRD-PARTY NOTICES FOR ROOSTER',
    HEAVY,
    '',
    'rooster is licensed under the GNU Affero General Public License v3.0 only (LICENSE).',
    'It contains third-party software, listed here with its licence and notices:',
    '',
    ...describe(DISTRIBUTIONS[0], [
      'dist/main.js inlines every JavaScript dependency of the server;',
      'better-sqlite3 and sharp (with its prebuilt libvips for linux-x64)',
      'are installed next to it as native modules.',
    ]),
    ...describe(DISTRIBUTIONS[1], ['the web app the server serves, fonts included.']),
    ...describe(DISTRIBUTIONS[2], [
      'dist/rooster.mjs and the single-file binaries, which also embed the',
      'Bun runtime.',
    ]),
    '',
    'The image is built on a distroless Node.js base image, which carries the notices of',
    'Node.js and of the Debian packages in it.',
    '',
    'Generated by scripts/third-party-notices.mjs (pnpm notices) from the installed',
    'dependencies; do not edit by hand. Licence texts used by more than one package are',
    'printed once, under "Shared licence texts" at the end, and referred to as [S1], [S2], ...',
    '',
    HEAVY,
    `INDEX (${all.length} entries)`,
    HEAVY,
    '',
  );
  for (const entry of all) {
    out.push(`${title(entry)}  (${entry.license})`);
  }
  out.push('');
  for (const entry of all) {
    out.push(HEAVY, title(entry), HEAVY);
    out.push(`Licence: ${entry.license}`);
    if (entry.homepage) out.push(`Homepage: ${entry.homepage}`);
    if (entry.repository && entry.repository !== entry.homepage) {
      out.push(`Repository: ${entry.repository}`);
    }
    out.push(`In: ${shipsIn(entry.in)}`);
    if (entry.note) out.push('', ...entry.note);
    for (const file of entry.files) {
      const id = shared.get(file.text);
      if (id) out.push('', `${file.name}: see [${id}] below.`);
      else
        out.push(
          '',
          `${RULE.slice(0, 3)} ${file.name} ${RULE.slice(file.name.length + 5)}`,
          '',
          file.text,
        );
    }
    out.push('');
  }
  out.push(HEAVY, 'SHARED LICENCE TEXTS', HEAVY, '');
  for (const [text, id] of shared) {
    const users = uses.get(text);
    const named = users.slice(0, 5).map((e) => e.name);
    const more = users.length > 5 ? ` and ${users.length - 5} more` : '';
    out.push(RULE, `[${id}] used by ${named.join(', ')}${more}`, RULE, '', text, '');
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// ---- main ----

const onTarget =
  process.platform === TARGET.os &&
  process.arch === TARGET.cpu &&
  // glibc: musl's Node has no glibcVersionRuntime.
  Boolean(process.report?.getReport?.().header?.glibcVersionRuntime);
if (!onTarget) {
  const message = `notices: platform packages are read for ${TARGET.os}-${TARGET.cpu} (${TARGET.libc}); run this there`;
  if (check) {
    console.warn(`${message}. Skipped.`);
    process.exit(0);
  }
  console.error(message);
  process.exit(1);
}

let content;
try {
  content = render();
} catch (error) {
  console.error(`notices: ${error.message}`);
  process.exit(1);
}
const file = join(root, OUT);
let current = '';
try {
  current = readFileSync(file, 'utf8');
} catch {}
if (current === content) {
  if (!check) console.log(`notices: ${OUT} is up to date`);
} else if (check) {
  console.error(`notices: ${OUT} is out of date; run pnpm notices`);
  process.exit(1);
} else {
  writeFileSync(file, content);
  console.log(`notices: wrote ${OUT}`);
}
