import { inArray } from 'drizzle-orm';
import type { AppDb } from '../db/client.ts';
import { instanceSetting } from '../db/schema/index.ts';
import type { Tx } from '../services/context.ts';
import { generateVapidKeys } from './transport.ts';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  /** Env keys cannot be regenerated from the admin UI. */
  source: 'env' | 'instance';
}

const PUBLIC = 'vapid_public';
const PRIVATE = 'vapid_private';

/**
 * The instance's VAPID keys (08 §2 step 5): `ROOSTER_VAPID_PUBLIC`/`_PRIVATE` when set,
 * otherwise a pair generated once and kept in `instance_setting`.
 */
export function ensureVapidKeys(
  db: AppDb,
  env: { publicKey: string; privateKey: string } | null,
): VapidKeys {
  if (env !== null) return { ...env, source: 'env' };
  return db.orm.transaction(
    (tx) => {
      const stored = readStored(tx);
      if (stored !== null) return stored;
      return writeKeys(tx, generateVapidKeys());
    },
    { behavior: 'immediate' },
  );
}

function readStored(tx: Tx): VapidKeys | null {
  const rows = tx
    .select()
    .from(instanceSetting)
    .where(inArray(instanceSetting.key, [PUBLIC, PRIVATE]))
    .all();
  const publicKey = rows.find((r) => r.key === PUBLIC)?.value;
  const privateKey = rows.find((r) => r.key === PRIVATE)?.value;
  return publicKey === undefined || privateKey === undefined
    ? null
    : { publicKey, privateKey, source: 'instance' };
}

/** Stores a new pair (first boot, or "Regenerate push keys"). */
export function writeKeys(tx: Tx, keys: { publicKey: string; privateKey: string }): VapidKeys {
  for (const [key, value] of [
    [PUBLIC, keys.publicKey],
    [PRIVATE, keys.privateKey],
  ] as const) {
    tx.insert(instanceSetting)
      .values({ key, value })
      .onConflictDoUpdate({ target: instanceSetting.key, set: { value } })
      .run();
  }
  return { ...keys, source: 'instance' };
}
