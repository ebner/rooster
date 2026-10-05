import { uuidv7 } from '@rooster/core/ids';
import { generateNKeysBetween, keyBetween } from '@rooster/core/ordering';
import type { Locale } from '@rooster/i18n';
import { and, eq } from 'drizzle-orm';
import { taskGroup } from '../db/schema/index.ts';
import { serverText } from '../lib/i18n.ts';
import type { Tx } from './context.ts';

/** The default groups of every new membership, in order (FR-AUTH-3). */
const DEFAULT_GROUPS = ['group.today', 'group.prio', 'group.upcoming'] as const;

/**
 * Creates the member's Inbox and the localised default groups in an org (05 §4.2). Called
 * whenever a membership is created; GroupService takes over the groups from Phase 2.
 */
export function createDefaultGroups(
  tx: Tx,
  input: { orgId: string; userId: string; locale: Locale; now: number },
): void {
  const { orgId, userId, locale, now } = input;
  const base = { orgId, userId, createdAt: now, updatedAt: now };
  // The inbox's position is ignored (it is always first), but the column is NOT NULL.
  tx.insert(taskGroup)
    .values({
      ...base,
      id: uuidv7(),
      kind: 'inbox',
      name: serverText(locale, 'group.inbox'),
      position: keyBetween(null, null),
    })
    .run();
  const positions = generateNKeysBetween(null, null, DEFAULT_GROUPS.length);
  DEFAULT_GROUPS.forEach((key, i) => {
    tx.insert(taskGroup)
      .values({
        ...base,
        id: uuidv7(),
        kind: 'normal',
        name: serverText(locale, key),
        position: positions[i] as string,
      })
      .run();
  });
}

/** Hard-deletes every group of the user in the org, Inbox included (05 §4.2, member removal). */
export function deleteMemberGroups(tx: Tx, input: { orgId: string; userId: string }): void {
  tx.delete(taskGroup)
    .where(and(eq(taskGroup.orgId, input.orgId), eq(taskGroup.userId, input.userId)))
    .run();
}
