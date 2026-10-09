import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppDb } from './client.ts';
import { instanceSetting } from './schema/instance-setting.ts';

/** Returns the instance ID, generating and storing it on first boot. */
export function ensureInstanceId(db: AppDb): string {
  db.orm
    .insert(instanceSetting)
    .values({ key: 'instance_id', value: randomUUID() })
    .onConflictDoNothing()
    .run();
  const row = db.orm
    .select({ value: instanceSetting.value })
    .from(instanceSetting)
    .where(eq(instanceSetting.key, 'instance_id'))
    .get();
  if (row === undefined) throw new Error('instance_id missing after bootstrap');
  return row.value;
}

const LAST_BOOT_VERSION = 'last_boot_version';

/**
 * The server version that last booted this database, read before migrating: on a database
 * older than `instance_setting` the table does not exist yet, which reads as "unknown".
 */
export function readLastBootVersion(db: AppDb): string | undefined {
  const table = db.sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'instance_setting'")
    .get();
  if (table === undefined) return undefined;
  const row = db.sqlite
    .prepare('SELECT value FROM instance_setting WHERE key = ?')
    .get(LAST_BOOT_VERSION) as { value: string } | undefined;
  return row?.value;
}

export function recordBootVersion(db: AppDb, version: string): void {
  db.orm
    .insert(instanceSetting)
    .values({ key: LAST_BOOT_VERSION, value: version })
    .onConflictDoUpdate({ target: instanceSetting.key, set: { value: version } })
    .run();
}
