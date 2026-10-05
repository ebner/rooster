#!/usr/bin/env node
// drizzle-kit cannot emit SQLite STRICT tables, but rooster's own tables must be STRICT
// (docs/spec/05-data-model.md). This post-generate step appends `STRICT` to every
// `CREATE TABLE` for a rooster table that lacks it. It is idempotent, so it can run over
// the whole migrations folder after every `drizzle-kit generate`.
//
// Usage: node scripts/strictify-migrations.mjs [migrationsDir]

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// better-auth owns these tables (its adapter decides their types), so they stay non-STRICT.
// `organization`, `member` and `invitation` are rooster's own tables (ADR 0002) and are STRICT.
const NON_STRICT_TABLES = new Set([
  'user',
  'session',
  'account',
  'verification',
  'apikey',
  'deviceCode',
]);

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(process.argv[2] ?? join(here, '../src/db/migrations'));

const CREATE_TABLE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([A-Za-z_][\w]*)[`"\]]?\s*\(/gi;

/** Index just past the `)` that closes the `(` at `open`, skipping quoted strings and identifiers. */
function findClosingParen(sql, open) {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = sql.indexOf(ch, i + 1);
      if (end === -1) return -1;
      i = end;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function strictify(sql) {
  let out = '';
  let cursor = 0;
  for (const match of sql.matchAll(CREATE_TABLE)) {
    if (match.index < cursor) continue;
    const name = match[1].replace(/^__new_/, '');
    const open = match.index + match[0].length - 1;
    const close = findClosingParen(sql, open);
    if (close === -1) break;
    out += sql.slice(cursor, close);
    cursor = close;
    if (NON_STRICT_TABLES.has(name)) continue;
    const tail = /^(?:(?!-->)[^;])*/.exec(sql.slice(close))?.[0] ?? '';
    if (/\bSTRICT\b/i.test(tail)) continue;
    if (/\bWITHOUT\s+ROWID\b/i.test(tail)) {
      out += `${tail.trimEnd()}, STRICT`;
      cursor = close + tail.length;
    } else {
      out += ' STRICT';
    }
  }
  return out + sql.slice(cursor);
}

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
let changed = 0;
for (const file of files) {
  const path = join(migrationsDir, file);
  const before = readFileSync(path, 'utf8');
  const after = strictify(before);
  if (after !== before) {
    writeFileSync(path, after);
    changed++;
    process.stdout.write(`strictify-migrations: ${file}\n`);
  }
}
process.stdout.write(`strictify-migrations: ${changed} file(s) updated in ${migrationsDir}\n`);
