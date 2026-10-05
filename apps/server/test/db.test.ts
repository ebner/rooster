import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareDatabase } from '../src/db/boot.ts';
import { openDb } from '../src/db/client.ts';
import { ensureInstanceId } from '../src/db/instance.ts';
import { backupDatabase, hasPendingMigrations, runMigrations } from '../src/db/migrate.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createTestDb, tempDir } from './helpers.ts';

const silent = createLogger('silent');

let dir: ReturnType<typeof tempDir>;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  dir.cleanup();
});

describe('openDb', () => {
  it('applies the 05 §1 pragmas to a file database', () => {
    const db = openDb(join(dir.path, 'p.db'));
    try {
      const pragma = (name: string) => db.sqlite.pragma(name, { simple: true });
      expect(pragma('journal_mode')).toBe('wal');
      expect(pragma('synchronous')).toBe(1); // NORMAL
      expect(pragma('foreign_keys')).toBe(1);
      expect(pragma('busy_timeout')).toBe(5000);
      expect(pragma('temp_store')).toBe(2); // MEMORY
      expect(pragma('cache_size')).toBe(-20000);
    } finally {
      db.close();
    }
  });
});

describe('migrations', () => {
  it('createTestDb() returns a migrated in-memory database', () => {
    const db = createTestDb();
    expect(hasPendingMigrations(db)).toBe(false);
    expect(db.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    const table = db.sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'instance_setting'")
      .get() as { sql: string } | undefined;
    expect(table?.sql).toMatch(/\)\s*STRICT$/);
  });

  it('detects pending migrations and applies them idempotently', () => {
    const db = openDb(':memory:');
    expect(hasPendingMigrations(db)).toBe(true);
    runMigrations(db);
    expect(hasPendingMigrations(db)).toBe(false);
    runMigrations(db);
    expect(hasPendingMigrations(db)).toBe(false);
    db.close();
  });

  it('rooster tables are STRICT; better-auth tables are not', () => {
    const db = createTestDb();
    const tables = db.sqlite
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%drizzle%'",
      )
      .all() as { name: string; sql: string }[];
    const strict = tables.filter((t) => /\)\s*STRICT$/.test(t.sql)).map((t) => t.name);
    expect(strict.sort()).toEqual([
      'allowlist_entry',
      'idempotency',
      'instance_setting',
      'invitation',
      'invite_link',
      'member',
      'org_member_pref',
      'organization',
      'placement',
      'task',
      'task_group',
    ]);
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['user', 'session', 'account', 'verification']),
    );
    db.close();
  });

  it('allows one inbox per user and org, and compares allowlist values case-insensitively', () => {
    const db = createTestDb();
    const now = Date.now();
    db.sqlite
      .prepare(
        "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('u', 'U', 'u@x.test', 1, ?, ?)",
      )
      .run(now, now);
    db.sqlite
      .prepare("INSERT INTO organization (id, name, slug, created_at) VALUES ('o', 'O', 'o1', ?)")
      .run(now);
    const group = db.sqlite.prepare(
      "INSERT INTO task_group (id, org_id, user_id, kind, name, position, created_at, updated_at) VALUES (?, 'o', 'u', ?, 'G', 'a0', ?, ?)",
    );
    group.run('g1', 'inbox', now, now);
    group.run('g2', 'normal', now, now);
    group.run('g3', 'normal', now, now);
    expect(() => group.run('g4', 'inbox', now, now)).toThrow(/UNIQUE/);
    const allow = db.sqlite.prepare(
      "INSERT INTO allowlist_entry (id, kind, value, created_at) VALUES (?, 'email', ?, ?)",
    );
    allow.run('a1', 'Ann@Example.com', now);
    expect(() => allow.run('a2', 'ann@example.com', now)).toThrow(/UNIQUE/);
    db.close();
  });

  it('instance_setting is STRICT', () => {
    const db = createTestDb();
    expect(() =>
      db.sqlite
        .prepare('INSERT INTO instance_setting (key, value) VALUES (?, ?)')
        .run('k', Buffer.from([1])),
    ).toThrow(/cannot store BLOB value in TEXT column/);
  });
});

describe('backupDatabase', () => {
  it('writes a consistent, openable copy', () => {
    const db = createTestDb();
    const id = ensureInstanceId(db);
    const dest = join(dir.path, 'backup.db');
    backupDatabase(db, dest);
    const copy = new Database(dest, { readonly: true });
    try {
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
      const row = copy
        .prepare("SELECT value FROM instance_setting WHERE key = 'instance_id'")
        .get() as { value: string };
      expect(row.value).toBe(id);
    } finally {
      copy.close();
      db.close();
    }
  });
});

describe('prepareDatabase', () => {
  it('creates the data layout, migrates and generates a stable instance ID', () => {
    const first = prepareDatabase(dir.path, silent);
    first.db.close();
    expect(existsSync(join(dir.path, 'rooster.db'))).toBe(true);
    expect(existsSync(join(dir.path, 'backups'))).toBe(true);
    expect(existsSync(join(dir.path, 'attachments'))).toBe(true);
    // A fresh database has nothing worth backing up.
    expect(readdirSync(join(dir.path, 'backups'))).toEqual([]);

    const second = prepareDatabase(dir.path, silent);
    second.db.close();
    expect(second.instanceId).toBe(first.instanceId);
    expect(first.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(readdirSync(join(dir.path, 'backups'))).toEqual([]);
  });

  it('backs up an existing database before applying pending migrations', () => {
    const dbFile = join(dir.path, 'rooster.db');
    const legacy = new Database(dbFile);
    legacy.exec('CREATE TABLE legacy (x TEXT)');
    legacy.close();

    const { db } = prepareDatabase(dir.path, silent);
    db.close();
    const backups = readdirSync(join(dir.path, 'backups'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^pre-migrate-\d{4}-\d{2}-\d{2}T[\d-]+Z\.db$/);
    const copy = new Database(join(dir.path, 'backups', backups[0] ?? ''), { readonly: true });
    try {
      const tables = copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      expect(tables).toEqual([{ name: 'legacy' }]);
    } finally {
      copy.close();
    }
  });
});
