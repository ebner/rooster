import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from './helpers.ts';

const script = join(import.meta.dirname, '..', 'scripts', 'strictify-migrations.mjs');

describe('strictify-migrations', () => {
  it('appends STRICT to rooster tables only, idempotently', () => {
    const dir = tempDir();
    try {
      const file = join(dir.path, '0001_x.sql');
      writeFileSync(
        file,
        [
          'CREATE TABLE `user` (\n\t`id` text PRIMARY KEY NOT NULL\n);',
          'CREATE TABLE `organization` (\n\t`id` text PRIMARY KEY NOT NULL\n);',
          "CREATE TABLE `task_group` (\n\t`name` text DEFAULT '(' NOT NULL\n);",
          'CREATE TABLE `kv` (`k` text PRIMARY KEY) WITHOUT ROWID;',
          'CREATE TABLE `done` (`id` text) STRICT;',
          'CREATE VIRTUAL TABLE task_fts USING fts5(title);',
          // The shape of hand-written migrations (0004_task_fts): quoted name, options.
          "CREATE VIRTUAL TABLE `task_fts2` USING fts5(\n\ttitle,\n\ttokenize='unicode61'\n);",
        ].join('\n--> statement-breakpoint\n'),
      );
      execFileSync(process.execPath, [script, dir.path]);
      const once = readFileSync(file, 'utf8');
      expect(once).toContain('CREATE TABLE `user` (\n\t`id` text PRIMARY KEY NOT NULL\n);');
      // Rooster owns the org tables (ADR 0002), so they are STRICT.
      expect(once).toContain(
        'CREATE TABLE `organization` (\n\t`id` text PRIMARY KEY NOT NULL\n) STRICT;',
      );
      expect(once).toContain("`name` text DEFAULT '(' NOT NULL\n) STRICT;");
      expect(once).toContain('WITHOUT ROWID, STRICT;');
      expect(once).toContain('CREATE TABLE `done` (`id` text) STRICT;');
      expect(once).toContain('USING fts5(title);');
      expect(once).toContain("tokenize='unicode61'\n);");
      expect(once).not.toMatch(/fts5[^;]*STRICT/);
      execFileSync(process.execPath, [script, dir.path]);
      expect(readFileSync(file, 'utf8')).toBe(once);
    } finally {
      dir.cleanup();
    }
  });
});
