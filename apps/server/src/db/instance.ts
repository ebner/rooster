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
