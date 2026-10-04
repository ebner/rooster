import { describe, expect, it } from 'vitest';
import {
  compareKeys,
  generateKeyBetween,
  generateNKeysBetween,
  keyBetween,
  MAX_KEY_LENGTH,
  needsRebalance,
  rebalanceKeys,
  sortByPosition,
} from '../src/ordering.ts';

// SQLite BINARY collation is memcmp over UTF-8 bytes.
function binaryCompare(a: string, b: string): number {
  const ba = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    const d = (ba[i] ?? 0) - (bb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return Math.sign(ba.length - bb.length);
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('ordering', () => {
  it('re-exports fractional-indexing', () => {
    expect(generateKeyBetween(null, null)).toBe('a0');
    expect(generateNKeysBetween(null, null, 3)).toEqual(['a0', 'a1', 'a2']);
  });

  it('keyBetween places keys between neighbours', () => {
    expect(keyBetween(null, null)).toBe('a0');
    const top = keyBetween(null, 'a0');
    expect(compareKeys(top, 'a0')).toBe(-1);
    const bottom = keyBetween('a0', null);
    expect(compareKeys(bottom, 'a0')).toBe(1);
    const mid = keyBetween('a0', 'a1');
    expect(compareKeys('a0', mid)).toBe(-1);
    expect(compareKeys(mid, 'a1')).toBe(-1);
  });

  it('keyBetween rejects equal or inverted neighbours', () => {
    expect(() => keyBetween('a1', 'a1')).toThrow(RangeError);
    expect(() => keyBetween('a2', 'a1')).toThrow(RangeError);
  });

  it('compareKeys is binary, not locale-aware', () => {
    expect(compareKeys('Z', 'a')).toBe(-1);
    expect(compareKeys('a', 'Z')).toBe(1);
    expect(compareKeys('a0', 'a0')).toBe(0);
    expect(compareKeys('a0', 'a0V')).toBe(-1);
    // localeCompare would put 'a' before 'Z'.
    expect('Z'.localeCompare('a', 'en')).toBe(1);
  });

  it('sortByPosition orders by position then id without mutating the input', () => {
    const items = [
      { id: 'b', position: 'a1' },
      { id: 'a', position: 'a1' },
      { id: 'c', position: 'Zz' },
      { id: 'd', position: 'a0V' },
    ];
    const sorted = sortByPosition(items);
    expect(sorted.map((i) => i.id)).toEqual(['c', 'd', 'a', 'b']);
    expect(items.map((i) => i.id)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('needsRebalance triggers above 64 characters', () => {
    expect(MAX_KEY_LENGTH).toBe(64);
    expect(needsRebalance('a'.repeat(64))).toBe(false);
    expect(needsRebalance('a'.repeat(65))).toBe(true);
  });

  it('rebalanceKeys returns n short ascending keys', () => {
    const keys = rebalanceKeys(100);
    expect(keys).toHaveLength(100);
    for (let i = 1; i < keys.length; i++) {
      expect(compareKeys(keys[i - 1] ?? '', keys[i] ?? '')).toBe(-1);
    }
    expect(keys.every((k) => !needsRebalance(k))).toBe(true);
    expect(rebalanceKeys(0)).toEqual([]);
  });

  it('fuzz: 1000 random inserts keep strict order, identical under BINARY collation', () => {
    const rand = mulberry32(42);
    const keys: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const at = Math.floor(rand() * (keys.length + 1));
      const key = keyBetween(keys[at - 1] ?? null, keys[at] ?? null);
      keys.splice(at, 0, key);
    }
    expect(new Set(keys).size).toBe(1000);
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1] ?? '';
      const b = keys[i] ?? '';
      expect(a < b).toBe(true);
      expect(binaryCompare(a, b)).toBe(-1);
    }
    const shuffled = [...keys].sort(() => rand() - 0.5);
    expect([...shuffled].sort(compareKeys)).toEqual(keys);
    expect([...shuffled].sort(binaryCompare)).toEqual(keys);
    expect(keys.every((k) => /^[0-9A-Za-z]+$/.test(k))).toBe(true);
  });

  it('repeated inserts at one spot eventually need a rebalance', () => {
    let after = 'a0';
    const before = 'a1';
    let n = 0;
    while (!needsRebalance(after) && n < 10_000) {
      after = keyBetween(after, before);
      n++;
    }
    expect(needsRebalance(after)).toBe(true);
  });
});
