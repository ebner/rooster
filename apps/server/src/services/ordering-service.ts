import {
  compareKeys,
  generateNKeysBetween,
  needsRebalance,
  rebalanceKeys,
} from '@rooster/core/ordering';
import type { OrderingIntent } from '@rooster/core/schemas';

export interface Keyed {
  id: string;
  position: string;
}

/**
 * One ordering domain (04 §7), loaded inside the caller's transaction: its items in
 * `ORDER BY position, id` order WITHOUT the items being placed, and a writer used when the
 * domain has to be re-keyed.
 */
export interface OrderDomain {
  items: readonly Keyed[];
  write(id: string, position: string): void;
}

/** `top`/`end` are server-side defaults; an intent object comes from a client (06 §1). */
export type OrderTarget = OrderingIntent | 'top' | 'end';

export interface PlaceResult {
  /** One key per placed item, ascending. */
  keys: string[];
  /** The intent's neighbours were missing, foreign or out of order: placed at the end. */
  fellBack: boolean;
  /** The whole domain was re-keyed. */
  rebalanced: boolean;
}

/**
 * Computes fractional keys from `{afterId, beforeId}` intents inside a transaction (04 §7).
 * The server is authoritative: it resolves the intent against its own ordering and never
 * trusts a client key.
 */
export class OrderingService {
  /**
   * Index in `items` where new items go. `afterId` is the item directly above, `beforeId`
   * the one directly below. With both, the slot is directly below `afterId` (hidden items,
   * such as completed or deleted tasks, may sit between the two). A neighbour that is not
   * in the domain, or neighbours in the wrong order, fall back to the end.
   */
  slot(items: readonly Keyed[], placement: OrderTarget): { index: number; fellBack: boolean } {
    const end = { index: items.length, fellBack: false };
    if (placement === 'end') return end;
    if (placement === 'top') return { index: 0, fellBack: false };
    const afterId = placement.afterId ?? null;
    const beforeId = placement.beforeId ?? null;
    if (afterId === null && beforeId === null) return end;
    const after = afterId === null ? -1 : items.findIndex((i) => i.id === afterId);
    const before = beforeId === null ? -1 : items.findIndex((i) => i.id === beforeId);
    const fallBack = { index: items.length, fellBack: true };
    if ((afterId !== null && after === -1) || (beforeId !== null && before === -1)) return fallBack;
    if (afterId === null) return { index: before, fellBack: false };
    if (beforeId === null || after < before) return { index: after + 1, fellBack: false };
    return fallBack;
  }

  /**
   * Keys for `count` consecutive new items at `placement`. Keys are generated between the
   * actual neighbours in the domain, so they cannot collide with an existing key. When the
   * neighbours share a key, or a new key would exceed 64 characters, the whole domain is
   * re-keyed in its current order with the new items in their slot.
   */
  place(domain: OrderDomain, placement: OrderTarget, count = 1): PlaceResult {
    const { items } = domain;
    const { index, fellBack } = this.slot(items, placement);
    const lower = items[index - 1]?.position ?? null;
    const upper = items[index]?.position ?? null;
    let keys: string[] | null = null;
    if (lower === null || upper === null || compareKeys(lower, upper) < 0) {
      try {
        keys = generateNKeysBetween(lower, upper, count);
      } catch {
        // A malformed stored key; re-keying repairs the domain.
        keys = null;
      }
      if (keys?.some(needsRebalance)) keys = null;
    }
    if (keys !== null) return { keys, fellBack, rebalanced: false };

    const all = rebalanceKeys(items.length + count);
    items.forEach((item, i) => {
      const key = all[i < index ? i : i + count] as string;
      if (key !== item.position) domain.write(item.id, key);
    });
    return { keys: all.slice(index, index + count), fellBack, rebalanced: true };
  }
}
