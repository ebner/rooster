import { uuidv7 } from '@rooster/core/ids';
import {
  type ReindexResult,
  type SearchResult,
  SNIPPET_MARK_END,
  SNIPPET_MARK_START,
  searchResultSchema,
  type Task,
  type TaskPage,
} from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { AppDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { task } from '../src/db/schema/index.ts';
import { SEARCH_SCAN_CAP } from '../src/services/search-service.ts';
import { type Caller, createTask, groupNamed, listCtx, meta, sharedOrg } from './list-helpers.ts';

const DAY = 86_400_000;
const S = SNIPPET_MARK_START;
const E = SNIPPET_MARK_END;

interface IndexRow {
  task_id: string;
  org_id: string;
  title: string;
  description: string;
}

function indexRows(db: AppDb): IndexRow[] {
  return db.sqlite
    .prepare('SELECT task_id, org_id, title, description FROM task_fts ORDER BY task_id')
    .all() as IndexRow[];
}

/** The index holds exactly the live tasks, with their current text (05 §3). */
function expectIndexConsistent(db: AppDb): void {
  const live = db.sqlite
    .prepare(
      'SELECT id AS task_id, org_id, title, description FROM task WHERE deleted_at IS NULL ORDER BY id',
    )
    .all();
  expect(indexRows(db)).toEqual(live);
}

const indexed = (db: AppDb, id: string) => indexRows(db).find((r) => r.task_id === id);

async function search(c: Caller, q: string, extra = ''): Promise<SearchResult> {
  const hits = await c.ok<SearchResult>('GET', `/api/v1/search?q=${encodeURIComponent(q)}${extra}`);
  expect(searchResultSchema.safeParse(hits).success).toBe(true);
  return hits;
}

const titles = (hits: SearchResult) => hits.map((h) => h.task.title);

describe('index maintenance (every task write path)', () => {
  it('create, rename, description, stale edits and duplicate keep the index in step', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const t = await createTask(a, { title: 'First', description: 'notes' });
    expect(indexed(ctx.db, t.id)).toMatchObject({ title: 'First', description: 'notes' });
    const now = Date.now();
    await a.ok('PATCH', `/api/v1/tasks/${t.id}`, { title: 'Renamed' }, 200, {
      'X-Rooster-Edit-Time': String(now),
    });
    await a.ok('PATCH', `/api/v1/tasks/${t.id}`, { description: 'new notes' });
    expect(indexed(ctx.db, t.id)).toMatchObject({ title: 'Renamed', description: 'new notes' });
    // An edit older than the title clock is ignored, and so is its text.
    await a.ok('PATCH', `/api/v1/tasks/${t.id}`, { title: 'Stale' }, 200, {
      'X-Rooster-Edit-Time': String(now - 60_000),
    });
    expect(indexed(ctx.db, t.id)?.title).toBe('Renamed');
    await createTask(a, { title: 'Child', parentId: t.id });
    await a.ok('POST', `/api/v1/tasks/${t.id}/duplicate`, {}, 201);
    expect(
      indexRows(ctx.db)
        .map((r) => r.title)
        .sort(),
    ).toEqual(['Child', 'Child', 'Renamed', 'Renamed']);
    expectIndexConsistent(ctx.db);
  });

  it('delete, restore, bulk and permanent delete add and remove rows with the subtasks', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const parent = await createTask(a, { title: 'Parent' });
    const child = await createTask(a, { title: 'Child', parentId: parent.id });
    await a.ok('DELETE', `/api/v1/tasks/${parent.id}`, undefined, 204);
    expect(indexed(ctx.db, parent.id)).toBeUndefined();
    expect(indexed(ctx.db, child.id)).toBeUndefined();
    expect(await search(a, 'child')).toEqual([]);
    await a.ok('POST', `/api/v1/tasks/${parent.id}/restore`);
    expect(titles(await search(a, 'child'))).toEqual(['Child']);
    expectIndexConsistent(ctx.db);

    await a.ok('POST', '/api/v1/tasks/bulk', { op: 'delete', ids: [parent.id] });
    expectIndexConsistent(ctx.db);
    await a.ok('POST', '/api/v1/tasks/bulk', { op: 'restore', ids: [parent.id] });
    expect(indexRows(ctx.db)).toHaveLength(2);
    await a.ok('DELETE', `/api/v1/tasks/${parent.id}`, undefined, 204);
    await a.ok('DELETE', `/api/v1/tasks/${parent.id}/permanent`, undefined, 204);
    expect(indexRows(ctx.db)).toEqual([]);
    expectIndexConsistent(ctx.db);
  });

  it('group delete with its tasks, and the group restore', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const prio = await groupNamed(a, 'Prio');
    await createTask(a, { title: 'In prio', groupId: prio.id });
    await a.ok('DELETE', `/api/v1/groups/${prio.id}`, { deleteTasks: true }, 204);
    expect(await search(a, 'prio')).toEqual([]);
    expectIndexConsistent(ctx.db);
    await a.ok('POST', `/api/v1/groups/${prio.id}/restore`);
    expect(titles(await search(a, 'prio'))).toEqual(['In prio']);
    expectIndexConsistent(ctx.db);
  });

  it('the trash purge leaves no row behind', async () => {
    let now = Date.UTC(2026, 8, 1);
    const ctx = listCtx({ clock: () => now });
    const a = ctx.user('a@example.com');
    const t = await createTask(a, { title: 'Old' });
    await createTask(a, { title: 'Sub', parentId: t.id });
    await createTask(a, { title: 'Kept' });
    await a.ok('DELETE', `/api/v1/tasks/${t.id}`, undefined, 204);
    now += 31 * DAY;
    expect(ctx.app.services.retention.purge(now).tasks).toBeGreaterThan(0);
    expect(indexRows(ctx.db).map((r) => r.title)).toEqual(['Kept']);
    expectIndexConsistent(ctx.db);
  });

  it('a deleted org’s tasks are not found by its former members', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const org = await sharedOrg(a, []);
    await createTask(a, { title: 'Shared plan' }, org.id);
    expect(titles(await search(a, 'plan'))).toEqual(['Shared plan']);
    await a.ok('DELETE', `/api/v1/orgs/${org.id}`, { confirmName: org.name }, 204);
    expect(await search(a, 'plan')).toEqual([]);
    expect((await a.call('GET', `/api/v1/search?q=plan&orgId=${org.id}`)).status).toBe(404);
  });

  it('migration 0004 creates the table and backfills the live tasks', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    await createTask(a, { title: 'One' });
    await createTask(a, { title: 'Two', description: 'second' });
    const gone = await createTask(a, { title: 'Gone' });
    await a.ok('DELETE', `/api/v1/tasks/${gone.id}`, undefined, 204);
    // Roll the FTS migration (and the later 0005 and 0006) back by hand, then let the migrator
    // apply them again.
    ctx.db.sqlite.exec(
      'DROP TABLE task_fts; DROP TABLE comment; DROP TABLE activity; DROP TABLE follower; DROP TABLE notification; DROP TABLE notification_pref; DROP TABLE job_run; DROP TABLE push_subscription',
    );
    ctx.db.sqlite
      .prepare(
        'DELETE FROM __drizzle_migrations WHERE created_at IN (SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 3)',
      )
      .run();
    runMigrations(ctx.db);
    expect(
      indexRows(ctx.db)
        .map((r) => r.title)
        .sort(),
    ).toEqual(['One', 'Two']);
    expectIndexConsistent(ctx.db);
    const sql = (
      ctx.db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'task_fts'").get() as {
        sql: string;
      }
    ).sql;
    expect(sql).toContain("tokenize='unicode61 remove_diacritics 2', prefix='2 3 4'");
    expect(sql).not.toMatch(/STRICT/);
  });
});

describe('AC-5.2 search', () => {
  it('AC-5.2 Searching "tand" finds "Boka tandläkare" (prefix match)', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    await createTask(a, { title: 'Boka tandläkare' });
    await createTask(a, { title: 'Handla mat' });
    const hits = await search(a, 'tand');
    expect(titles(hits)).toEqual(['Boka tandläkare']);
    expect(hits[0]?.snippet).toBe(`Boka ${S}tandläkare${E}`);
    // Diacritics and case are ignored both ways.
    expect(titles(await search(a, 'TANDLAK'))).toEqual(['Boka tandläkare']);
    expect(titles(await search(a, 'tandläk'))).toEqual(['Boka tandläkare']);
  });

  it('AC-5.2 "rapport" matches a description', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    await createTask(a, { title: 'Kvartal', description: 'Skriv rapporten till styrelsen' });
    const hits = await search(a, 'rapport');
    expect(titles(hits)).toEqual(['Kvartal']);
    expect(hits[0]?.snippet).toBe(`Skriv ${S}rapporten${E} till styrelsen`);
    expect(hits[0]?.task.description).toBeUndefined();
  });

  it('AC-5.2 results never include tasks from orgs the user is not a member of', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const c = ctx.user('c@example.com');
    const ab = await sharedOrg(a, [b], 'AB');
    await createTask(a, { title: 'Secret plan A' });
    await createTask(b, { title: 'Secret plan B' });
    await createTask(a, { title: 'Secret plan shared' }, ab.id);
    await createTask(c, { title: 'Secret plan C' });
    expect(titles(await search(a, 'secret')).sort()).toEqual([
      'Secret plan A',
      'Secret plan shared',
    ]);
    expect(titles(await search(b, 'secret')).sort()).toEqual([
      'Secret plan B',
      'Secret plan shared',
    ]);
    expect(titles(await search(c, 'secret'))).toEqual(['Secret plan C']);
    // Filter-only queries are scoped the same way.
    expect(titles(await search(c, 'is:open'))).toEqual(['Secret plan C']);
    // A foreign org is 404, exactly like a missing one.
    expect((await c.call('GET', `/api/v1/search?q=secret&orgId=${ab.id}`)).status).toBe(404);
    expect((await c.call('GET', '/api/v1/search?q=secret&orgId=nope')).status).toBe(404);
    // Removing a member stops them finding the org's tasks.
    await a.ok('DELETE', `/api/v1/orgs/${ab.id}/members/${b.userId}`, undefined, 204);
    expect(titles(await search(b, 'secret'))).toEqual(['Secret plan B']);
  });

  it('ranks open before completed, then title matches before description matches', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const done = await createTask(a, { title: 'Budget done' });
    await a.ok('POST', `/api/v1/tasks/${done.id}/complete`, { completed: true });
    await createTask(a, { title: 'Meeting', description: 'talk about the budget' });
    await createTask(a, { title: 'Budget review' });
    expect(titles(await search(a, 'budget'))).toEqual(['Budget review', 'Meeting', 'Budget done']);
    expect(titles(await search(a, 'budget is:done'))).toEqual(['Budget done']);
    expect(titles(await search(a, 'budget is:open'))).toEqual(['Budget review', 'Meeting']);
  });

  it('several terms AND-combine; a phrase keeps its words together', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    await createTask(a, { title: 'Call the bank about the loan' });
    await createTask(a, { title: 'Bank holiday' });
    expect(titles(await search(a, 'bank loan'))).toEqual(['Call the bank about the loan']);
    expect(titles(await search(a, '"bank hol"'))).toEqual(['Bank holiday']);
    expect(await search(a, '"loan bank"')).toEqual([]);
  });

  it('filters: #tag prefix, @me, due:, and filter-only ordering by due date', async () => {
    const now = Date.UTC(2026, 9, 5, 10, 0);
    const ctx = listCtx({ clock: () => now });
    const a = ctx.user('a@example.com');
    await createTask(a, { title: 'Pay invoice', dueDate: '2026-10-07', tagNames: ['finance'] });
    await createTask(a, { title: 'Pay rent', dueDate: '2026-10-04', tagNames: ['Fika'] });
    await createTask(a, { title: 'Pay later' });
    await createTask(a, { title: 'Water plants', dueDate: '2026-10-05' });
    expect(titles(await search(a, 'pay #fin'))).toEqual(['Pay invoice']);
    expect(titles(await search(a, 'pay #f')).sort()).toEqual(['Pay invoice', 'Pay rent']);
    expect(await search(a, 'pay #nope')).toEqual([]);
    expect(titles(await search(a, 'pay due:overdue'))).toEqual(['Pay rent']);
    expect(titles(await search(a, 'pay due:none'))).toEqual(['Pay later']);
    expect(titles(await search(a, 'pay due:week'))).toEqual(['Pay invoice']);
    // No terms: filters only, by due date (none last).
    expect(titles(await search(a, '@me'))).toEqual([
      'Pay rent',
      'Water plants',
      'Pay invoice',
      'Pay later',
    ]);
    expect(titles(await search(a, 'due:today'))).toEqual(['Pay rent', 'Water plants']);
    expect(await search(a, '@someone-else')).toEqual([]);
    const hit = (await search(a, '#finance'))[0];
    // A filter-only hit has the plain title as its snippet.
    expect(hit?.snippet).toBe('Pay invoice');
  });

  it('palette action queries, bare sigils and empty input never hit the index', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    await createTask(a, { title: 'Move boxes' });
    expect(await search(a, '>move')).toEqual([]);
    expect(await search(a, '#')).toEqual([]);
    expect(await search(a, '!!!')).toEqual([]);
    expect((await a.call('GET', '/api/v1/search?q=')).status).toBe(422);
    expect((await a.call('GET', `/api/v1/search?q=${'x'.repeat(201)}`)).status).toBe(422);
    expect((await a.call('GET', '/api/v1/search?q=a&limit=51')).status).toBe(422);
  });

  it('limits results (default 50) and accepts org slugs and `personal`', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    for (let i = 0; i < 55; i++) await createTask(a, { title: `Item ${i}` });
    expect(await search(a, 'item')).toHaveLength(50);
    expect(await search(a, 'item', '&limit=3')).toHaveLength(3);
    expect(await search(a, 'item', '&orgId=personal&limit=5')).toHaveLength(5);
    const org = await sharedOrg(a, []);
    await createTask(a, { title: 'Item in org' }, org.id);
    expect(titles(await search(a, 'item', `&orgId=${org.slug}`))).toEqual(['Item in org']);
  });

  it('subtasks are found and carry my placement only when they have one', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const parent = await createTask(a, { title: 'Trip' });
    await createTask(a, { title: 'Pack suitcase', parentId: parent.id });
    const [sub] = await search(a, 'suitcase');
    expect(sub?.task).toMatchObject({ parentId: parent.id, placement: null });
    const [top] = await search(a, 'trip');
    expect(top?.task.placement).not.toBeNull();
    expect(top?.orgId).toBe(parent.orgId);
  });

  it('is injection-safe: random queries never fail', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    await createTask(a, { title: 'Boka tandläkare', description: 'ring "dr" (snart) - NEAR*' });
    // A small deterministic PRNG, so a failure is reproducible.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const alphabet = [
      ...'abcdeåäö AND OR NOT NEAR " \' * ( ) : ^ - + # @ > \\ ; % _ { } [ ] , . / ~ ` |',
      '\u0000',
      '\u0001',
      '\n',
      '\t',
      'é',
      '🐓',
      'due:',
      'is:',
      'today',
      'title:',
      '"',
      'NEAR(',
    ];
    for (let i = 0; i < 300; i++) {
      const length = 1 + Math.floor(rand() * 24);
      let q = '';
      for (let j = 0; j < length; j++) q += alphabet[Math.floor(rand() * alphabet.length)];
      const res = await a.call('GET', `/api/v1/search?q=${encodeURIComponent(q)}`);
      expect([200, 422], `q=${JSON.stringify(q)}: ${res.status}`).toContain(res.status);
      if (res.status === 200) {
        expect(searchResultSchema.safeParse(await res.json()).success).toBe(true);
      }
    }
    // The task query's `q` takes the same grammar.
    for (const q of ['"', 'title:x', 'NEAR(a b)', '\u0000', '*', 'a" OR "b']) {
      const res = await a.call('GET', `/api/v1/orgs/personal/tasks?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
    }
  });
});

describe('search scan cap', () => {
  it(`a filtered search examines at most SEARCH_SCAN_CAP candidates`, async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const dated = await createTask(a, { title: 'Dated', dueDate: '2026-10-07' });
    await createTask(a, { title: 'Undated' });
    // Candidates rank due dates first, so the undated task is the last one examined.
    expect(titles(await search(a, 'due:none'))).toEqual(['Undated']);

    const insert = ctx.db.sqlite.prepare(
      `INSERT INTO task (id, org_id, title, description, created_by, due_date, field_clock,
         created_at, updated_at)
       SELECT ?, org_id, 'Clone', '', created_by, due_date, field_clock, created_at, updated_at
       FROM task WHERE id = ?`,
    );
    ctx.db.sqlite.transaction(() => {
      for (let i = 0; i < SEARCH_SCAN_CAP; i += 1) insert.run(uuidv7(), dated.id);
    })();
    expect(await search(a, 'due:none')).toEqual([]);
    // Term searches are not affected: they rank by relevance and stop at the limit.
    expect(titles(await search(a, 'undated'))).toEqual(['Undated']);
  });
});

describe('task query ?q=', () => {
  it('narrows a view with terms and filters, keeping the view order', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const prio = await groupNamed(a, 'Prio');
    await createTask(a, { title: 'Report draft', groupId: prio.id, tagNames: ['work'] });
    await createTask(a, { title: 'Report final', groupId: prio.id });
    await createTask(a, { title: 'Groceries', description: 'for the report party' });
    const q = async (query: string) =>
      (
        await a.ok<TaskPage>('GET', `/api/v1/orgs/personal/tasks?q=${encodeURIComponent(query)}`)
      ).items.map((t: Task) => t.title);
    // My list order: the Inbox first, then Prio in position order.
    expect(await q('report')).toEqual(['Groceries', 'Report draft', 'Report final']);
    expect(await q('report #work')).toEqual(['Report draft']);
    expect(await q('#work')).toEqual(['Report draft']);
    expect(await q('>report')).toEqual([]);
    expect(await q('nothing')).toEqual([]);
  });
});

describe('reindex (ADR 0012)', () => {
  it('POST /admin/search/reindex rebuilds a broken index (instance admins)', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const admin = ctx.user('admin@example.com');
    await createTask(a, { title: 'Alpha' });
    const gone = await createTask(a, { title: 'Beta' });
    await a.ok('DELETE', `/api/v1/tasks/${gone.id}`, undefined, 204);
    // Break it both ways: a missing row, and a stray row for a deleted task.
    ctx.db.sqlite.prepare('DELETE FROM task_fts').run();
    ctx.db.sqlite
      .prepare(
        "INSERT INTO task_fts (task_id, org_id, title, description, comments) VALUES (?, ?, 'Beta', '', '')",
      )
      .run(gone.id, gone.orgId);
    expect(await search(a, 'alpha')).toEqual([]);
    expect((await a.call('POST', '/api/v1/admin/search/reindex')).status).toBe(403);
    const result = await admin.ok<ReindexResult>('POST', '/api/v1/admin/search/reindex');
    expect(result).toMatchObject({ indexed: 1, durationMs: expect.any(Number) });
    expect(titles(await search(a, 'alpha'))).toEqual(['Alpha']);
    expect(await search(a, 'beta')).toEqual([]);
    expectIndexConsistent(ctx.db);
  });

  it('the boot check rebuilds only when the row counts differ', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    await createTask(a, { title: 'Alpha' });
    await createTask(a, { title: 'Gamma' });
    const { search: service } = ctx.app.services;
    expect(service.rebuildIfStale()).toBeNull();
    ctx.db.sqlite.prepare("DELETE FROM task_fts WHERE title = 'Gamma'").run();
    expect(service.rebuildIfStale()).toMatchObject({ before: 1, indexed: 2 });
    expect(service.rebuildIfStale()).toBeNull();
    expectIndexConsistent(ctx.db);
  });

  it('rebuild skips deleted tasks', () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const { tasks, search: service } = ctx.app.services;
    const t = tasks.create(a.actor, 'personal', { title: 'Soon deleted' });
    tasks.remove(a.actor, t.id, meta());
    ctx.db.orm
      .update(task)
      .set({ title: 'Changed behind our back' })
      .where(eq(task.id, t.id))
      .run();
    expect(service.rebuild().indexed).toBe(0);
    expectIndexConsistent(ctx.db);
  });
});
