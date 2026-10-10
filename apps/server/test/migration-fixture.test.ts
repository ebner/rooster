// WP 11.5, AC-11.5 (10 §3.6): the previous release's database migrates to the current schema
// with its data intact, and migrating an up-to-date database changes nothing. The fixture is a
// SQL dump made by test/fixtures/make-release-fixture.ts (see there for refreshing it).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Me, MyList, TaskDetail } from '@rooster/core/schemas';
import { describe, expect, it } from 'vitest';
import { type AppDb, openDb } from '../src/db/client.ts';
import { hasPendingMigrations, MIGRATIONS_DIR, runMigrations } from '../src/db/migrate.ts';
import { tempDir } from './helpers.ts';
import { listCtx } from './list-helpers.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'release-1.4.0.sql');

/** The fixture loaded into a private in-memory database (foreign keys checked afterwards). */
function loadFixture(): AppDb {
  const db = openDb(':memory:');
  db.sqlite.pragma('foreign_keys = OFF');
  db.sqlite.exec(readFileSync(FIXTURE, 'utf8'));
  db.sqlite.pragma('foreign_keys = ON');
  return db;
}

type Snapshot = { schema: string[]; counts: Record<string, number> };

/** The schema (every object's SQL) and the row count of every table. */
function snapshot(db: AppDb): Snapshot {
  const objects = db.sqlite
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as { type: string; name: string; sql: string }[];
  const counts: Record<string, number> = {};
  for (const o of objects.filter((x) => x.type === 'table')) {
    counts[o.name] = (
      db.sqlite.prepare(`SELECT count(*) AS n FROM "${o.name}"`).get() as { n: number }
    ).n;
  }
  return { schema: objects.map((o) => `${o.type} ${o.name}: ${o.sql}`), counts };
}

const journalLength = () =>
  (
    JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as {
      entries: unknown[];
    }
  ).entries.length;

const userId = (db: AppDb, email: string) =>
  (db.sqlite.prepare('SELECT id FROM user WHERE email = ?').get(email) as { id: string }).id;

describe('AC-11.5 migrating the 1.4.0 fixture database', () => {
  it('migrates to the current schema with every row intact', () => {
    const db = loadFixture();
    expect(db.sqlite.pragma('foreign_key_check')).toEqual([]);
    const before = snapshot(db);
    expect(before.counts.task).toBeGreaterThan(10);

    runMigrations(db);
    const after = snapshot(db);
    expect(hasPendingMigrations(db)).toBe(false);
    expect(after.counts.__drizzle_migrations).toBe(journalLength());
    // Every table the release had keeps its rows (the migrations table gains the new ones).
    for (const [table, n] of Object.entries(before.counts)) {
      if (table === '__drizzle_migrations') continue;
      expect(after.counts[table], table).toBe(n);
    }
    expect(db.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(db.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
    db.close();
  });

  it('migrate is a no-op on an up-to-date database', () => {
    const db = loadFixture();
    runMigrations(db);
    const once = snapshot(db);
    runMigrations(db);
    expect(snapshot(db)).toEqual(once);
    db.close();
  });

  it('the migrated data reads back through the API', async () => {
    const db = loadFixture();
    runMigrations(db);
    const dir = tempDir();
    try {
      const ctx = listCtx({ db, env: { ROOSTER_DATA_DIR: dir.path } });
      // Sign in as the fixture's users with fresh sessions (the stored ones are of no use here).
      const anna = ctx.signedIn(userId(db, 'anna.lindqvist@example.com'));
      const bo = ctx.signedIn(userId(db, 'bo.ek@example.com'));

      const me = await anna.ok<Me>('GET', '/api/v1/me');
      expect(me.name).toBe('Anna Lindqvist');
      expect(me.locale).toBe('sv');
      expect(me.prefs.swipeLeft).toBe('move');
      expect(me.orgs.map((o) => o.name)).toContain('Northwind Garden Club');
      // The attachment uploaded under 1.4.0 counts toward the quota introduced since.
      expect(me.storage?.usedBytes).toBeGreaterThan(0);

      const team = me.orgs.find((o) => o.name === 'Northwind Garden Club');
      const list = await anna.ok<MyList>('GET', `/api/v1/orgs/${team?.id}/my-list`);
      const titles = list.tasks.map((t) => t.title);
      expect(titles).toEqual(
        expect.arrayContaining([
          'Order seeds for the spring beds',
          'Compare suppliers',
          'Ask Bo about the budget',
          'Water the greenhouse',
          'Book the hall',
        ]),
      );
      expect(titles).not.toContain('Old flyer draft');
      const plan = list.tasks.find((t) => t.title === 'Order seeds for the spring beds');
      expect(plan?.dueTime).toBe('09:30');
      const greenhouse = list.tasks.find((t) => t.title === 'Water the greenhouse');
      expect(greenhouse?.recurrence).toBe('FREQ=WEEKLY;BYDAY=MO,TH');

      const detail = await anna.ok<TaskDetail>('GET', `/api/v1/tasks/${plan?.id}`);
      expect(detail.description).toContain('**basil**');
      expect(detail.attachments?.map((a) => a.filename)).toEqual(['bed-layout.png']);
      const tags = await anna.ok<{ id: string; name: string }[]>(
        'GET',
        `/api/v1/orgs/${team?.id}/tags`,
      );
      const names = detail.tagIds.map((id) => tags.find((t) => t.id === id)?.name);
      expect(names.sort()).toEqual(['garden', 'shopping']);

      const boList = await bo.ok<MyList>('GET', `/api/v1/orgs/${team?.id}/my-list`);
      const gate = boList.tasks.find((t) => t.title === 'Fix the gate latch');
      expect(gate?.assigneeId).toBe(bo.userId);
      const activity = await bo.ok<{ items: { kind: string }[] }>(
        'GET',
        `/api/v1/tasks/${gate?.id}/activity`,
      );
      expect(activity.items.filter((i) => i.kind === 'comment')).toHaveLength(2);

      const trash = await anna.ok<{ items: { title: string }[] }>(
        'GET',
        `/api/v1/orgs/${team?.id}/trash`,
      );
      expect(trash.items.map((t) => t.title)).toEqual(['Old flyer draft']);

      // The search index came along (boot only rebuilds it when the row count is off).
      expect(ctx.app.services.search.rebuildIfStale()).toBeNull();
      const hits = await anna.ok<{ task: { title: string } }[]>(
        'GET',
        '/api/v1/search?q=greenhouse',
      );
      expect(hits.map((h) => h.task.title)).toContain('Water the greenhouse');
    } finally {
      dir.cleanup();
      db.close();
    }
  });
});
