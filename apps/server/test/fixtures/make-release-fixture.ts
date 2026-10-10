// Generates the previous release's fixture database for the migration test (10 §3.6, AC-11.5;
// test/migration-fixture.test.ts): a SQL dump of a database at that release's schema, with
// representative data written through the API of the time.
//
// REFRESH IT AT EVERY RELEASE, from the release's own commit (so the services match its schema):
//
//   git checkout vX.Y.Z
//   pnpm --filter @rooster/server exec tsx test/fixtures/make-release-fixture.ts \
//     --release X.Y.Z --through <the release's last migration tag, e.g. 0011_p10_…>
//   git checkout main   # then commit test/fixtures/release-X.Y.Z.sql, delete the older dump,
//                       # and point FIXTURE in test/migration-fixture.test.ts at the new one
//
// `--through` stops the migrations at the release's last one, so the dump can also be made from
// a later commit as long as no migration since then changed a column the seeding writes (the
// 1.4.0 dump was made that way: 0012 only adds an index).
//
// The dump is plain SQL for review: CREATE TABLE statements, then the rows (one INSERT each),
// then the indexes and triggers, so loading it never fires a trigger. The FTS table's rows are
// inserted through the virtual table (its shadow tables are not dumped). Every person, org and
// address in it is fictional.

import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDb } from '../../src/db/client.ts';
import { MIGRATIONS_DIR, runMigrations } from '../../src/db/migrate.ts';
import { blobGc, instanceSetting, jobRun } from '../../src/db/schema/index.ts';
import { fileForm, png, sendForm } from '../blob-helpers.ts';
import { subscriptionBody } from '../delivery-fakes.ts';
import { pat } from '../grant-helpers.ts';
import { tempDir } from '../helpers.ts';
import { createTask, listCtx, sharedOrg } from '../list-helpers.ts';

const { values: args } = parseArgs({
  options: {
    release: { type: 'string' },
    through: { type: 'string' },
    out: { type: 'string' },
  },
});
if (args.release === undefined || args.through === undefined) {
  console.error(
    'usage: make-release-fixture.ts --release X.Y.Z --through <migration tag> [--out file]',
  );
  process.exit(2);
}
const release = args.release;
const out = resolve(args.out ?? join(import.meta.dirname, `release-${release}.sql`));

interface Journal {
  entries: { idx: number; tag: string; when: number }[];
}

/** A copy of the migrations folder that ends at `through`. */
function migrationsThrough(through: string, dir: string): string[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'));
  const end = (journal as Journal).entries.findIndex((e) => e.tag === through);
  if (end < 0) throw new Error(`no migration ${through}`);
  const entries = (journal as Journal).entries.slice(0, end + 1);
  mkdirSync(join(dir, 'meta'), { recursive: true });
  for (const e of entries) cpSync(join(MIGRATIONS_DIR, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  return entries.map((e) => e.tag);
}

const work = tempDir('rooster-fixture-');
const migrationsDir = join(work.path, 'migrations');
const tags = migrationsThrough(args.through, migrationsDir);
const db = openDb(':memory:');
runMigrations(db, migrationsDir);

// --- the data ---------------------------------------------------------------------------------
const ctx = listCtx({ db, env: { ROOSTER_DATA_DIR: join(work.path, 'data') } });
const anna = ctx.user('anna.lindqvist@example.com', 'Anna Lindqvist');
const bo = ctx.user('bo.ek@example.com', 'Bo Ek');
const cleo = ctx.user('cleo.marsh@example.org', 'Cleo Marsh');
ctx.user('admin@example.com', 'Instance Admin');

const team = await sharedOrg(anna, [bo, cleo], 'Northwind Garden Club');
const groups = await anna.ok<{ group: { id: string } }>(
  'POST',
  `/api/v1/orgs/${team.id}/groups`,
  { name: 'Spring planting' },
  201,
);
const plan = await createTask(
  anna,
  {
    title: 'Order seeds for the spring beds',
    description: 'Tomatoes, **basil** and [peas](https://example.com/peas).',
    groupId: groups.group.id,
    dueDate: '2026-11-03',
    dueTime: '09:30',
    dueTz: 'Europe/Stockholm',
    tagNames: ['garden', 'shopping'],
  },
  team.id,
);
const step = await createTask(anna, { title: 'Compare suppliers', parentId: plan.id }, team.id);
await createTask(anna, { title: 'Ask Bo about the budget', parentId: step.id }, team.id);
await createTask(
  anna,
  {
    title: 'Water the greenhouse',
    dueDate: '2026-10-12',
    recurrence: 'FREQ=WEEKLY;BYDAY=MO,TH',
    recurrenceBasis: 'due',
    reminders: [{ offsetMinutes: 60 }],
  },
  team.id,
);
const forBo = await createTask(
  anna,
  {
    title: 'Fix the gate latch',
    assigneeId: bo.userId,
    startDate: '2026-10-20',
    dueDate: '2026-10-24',
  },
  team.id,
);
await anna.ok(
  'POST',
  `/api/v1/tasks/${forBo.id}/comments`,
  {
    body: `@[Bo Ek](user:${bo.userId}) the spare hinge is in the shed.`,
  },
  201,
);
await bo.ok('POST', `/api/v1/tasks/${forBo.id}/comments`, { body: 'On it this weekend.' }, 201);
await cleo.ok('PUT', `/api/v1/tasks/${forBo.id}/followers/me`);
const done = await createTask(anna, { title: 'Book the hall', tagNames: ['garden'] }, team.id);
await anna.ok('POST', `/api/v1/tasks/${done.id}/complete`, { completed: true });
const binned = await createTask(anna, { title: 'Old flyer draft' }, team.id);
await anna.ok('DELETE', `/api/v1/tasks/${binned.id}`, undefined, 204);
await createTask(bo, { title: 'Unassigned: mow the lawn', assigneeId: null }, team.id);

// Personal tasks, an expanded parent and a hand-ordered list.
const personal = await createTask(anna, { title: 'Renew passport', dueDate: '2026-12-01' });
await createTask(anna, { title: 'Find the old one', parentId: personal.id });
await anna.ok('PUT', `/api/v1/tasks/${personal.id}/expanded`, undefined, 204);
for (const title of ['Call the dentist', 'Pay the electricity bill', 'Return library books']) {
  await createTask(anna, { title }, 'personal');
}
await createTask(bo, { title: 'Buy birthday present', dueDate: '2026-10-15' });

// An attachment (an image, so with a thumbnail key), a calendar feed, a token, a device.
const image = await sendForm(
  ctx,
  anna,
  'POST',
  `/api/v1/tasks/${plan.id}/attachments`,
  fileForm(await png(64, 48), 'bed-layout.png', 'image/png'),
);
if (image.status !== 201) throw new Error(`upload: ${image.status} ${await image.text()}`);
await anna.ok('POST', '/api/v1/me/ical-feeds', { orgId: null }, 201);
await pat(anna, ['tasks:read', 'tasks:write'], { orgs: 'all' });
await anna.ok('PATCH', '/api/v1/me', {
  timezone: 'Europe/Stockholm',
  locale: 'sv',
  prefs: { swipeLeft: 'move', allDayReminderTime: '08:00' },
});
await bo.ok('POST', '/api/v1/me/push-subscriptions', subscriptionBody('fixture-device'), 201);
// An idempotent request leaves its stored response.
await anna.ok('POST', '/api/v1/orgs/personal/tasks', { title: 'Sent once, stored once' }, 201, {
  'Idempotency-Key': '0199c5a0-0000-7000-8000-000000000001',
});

// Instance state the boot and the jobs leave. The generated VAPID keys are left out: the dump is
// committed, and the secret scan rightly flags private keys (an instance with env keys has none).
const T = 1_791_532_800_000;
db.orm.insert(instanceSetting).values({ key: 'last_boot_version', value: release }).run();
db.sqlite.prepare("DELETE FROM instance_setting WHERE key LIKE 'vapid_%'").run();
db.orm
  .insert(jobRun)
  .values({ job: 'digest', scope: `${anna.userId}|2026-10-09`, ranAt: T })
  .run();
const ORPHAN_BLOB = 'attachments/orphan/blob';
db.orm.insert(blobGc).values({ key: ORPHAN_BLOB, storage: 'local', queuedAt: T }).run();

// --- the dump ---------------------------------------------------------------------------------
type Row = Record<string, unknown>;
const sqlite = db.sqlite;

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number')
    return Number.isInteger(value) ? String(value) : value.toPrecision(17);
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
}
const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

const schema = sqlite
  .prepare(
    "SELECT type, name, tbl_name AS tbl, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
  )
  .all() as { type: string; name: string; tbl: string; sql: string }[];
const virtual = new Set(
  schema.filter((s) => /^CREATE VIRTUAL TABLE/i.test(s.sql)).map((s) => s.name),
);
const isShadow = (name: string) => [...virtual].some((v) => name.startsWith(`${v}_`));
const tables = schema.filter((s) => s.type === 'table' && !isShadow(s.name));
const later = schema.filter(
  (s) => (s.type === 'index' || s.type === 'trigger') && !isShadow(s.tbl),
);

const lines: string[] = [
  `-- rooster ${release} fixture database (10 §3.6): the schema through migration ${tags.at(-1)}`,
  '-- and representative data. Generated by test/fixtures/make-release-fixture.ts; do not edit.',
  '-- Loaded by test/migration-fixture.test.ts, which migrates it to the current schema.',
  '',
];
for (const t of tables) lines.push(`${t.sql};`);
lines.push('');
const counts: Record<string, number> = {};
for (const t of tables) {
  const columns = virtual.has(t.name)
    ? (sqlite
        .prepare(`SELECT * FROM ${ident(t.name)} LIMIT 0`)
        .columns()
        .map((c) => c.name) as string[])
    : (sqlite.prepare(`PRAGMA table_info(${ident(t.name)})`).all() as { name: string }[]).map(
        (c) => c.name,
      );
  const rows = sqlite
    .prepare(`SELECT ${columns.map(ident).join(', ')} FROM ${ident(t.name)} ORDER BY 1`)
    .safeIntegers(true)
    .all() as Row[];
  counts[t.name] = rows.length;
  for (const row of rows) {
    lines.push(
      `INSERT INTO ${ident(t.name)} (${columns.map(ident).join(', ')}) VALUES (${columns.map((c) => literal(row[c])).join(', ')});`,
    );
  }
}
lines.push('');
for (const s of later) lines.push(`${s.sql};`);
lines.push('');
writeFileSync(out, `${lines.join('\n')}`);
db.close();
work.cleanup();
const total = Object.values(counts).reduce((a, b) => a + b, 0);
process.stdout.write(
  `wrote ${out}: ${tables.length} tables, ${total} rows (through ${tags.at(-1)})\n`,
);
