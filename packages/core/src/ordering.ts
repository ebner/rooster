import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

export { generateKeyBetween, generateNKeysBetween };

/** Keys longer than this trigger a re-key of the whole ordering domain (04 §7). */
export const MAX_KEY_LENGTH = 64;

/**
 * Binary (UTF-16 code unit) comparison. Keys are ASCII base-62, so this matches SQLite's
 * BINARY collation. Never use `localeCompare` for positions: it is case-insensitive in many
 * locales and would disagree with the database order.
 */
export function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Key for an item dropped between `afterKey` (the item above, or null for the top) and
 * `beforeKey` (the item below, or null for the bottom).
 */
export function keyBetween(afterKey: string | null, beforeKey: string | null): string {
  if (afterKey !== null && beforeKey !== null && compareKeys(afterKey, beforeKey) >= 0) {
    throw new RangeError(`keyBetween: afterKey "${afterKey}" must sort before "${beforeKey}"`);
  }
  return generateKeyBetween(afterKey, beforeKey);
}

/** Sorts like `ORDER BY position, id` under BINARY collation. Returns a new array. */
export function sortByPosition<T extends { readonly position: string; readonly id: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => compareKeys(a.position, b.position) || compareKeys(a.id, b.id));
}

export function needsRebalance(key: string): boolean {
  return key.length > MAX_KEY_LENGTH;
}

/** Fresh, evenly spaced keys for re-keying a domain of `n` items in their current order. */
export function rebalanceKeys(n: number): string[] {
  return generateNKeysBetween(null, null, n);
}
