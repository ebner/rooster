import { describe, expect, it } from 'vitest';
import {
  createUuidv7Generator,
  isUuidv7,
  UUIDV7_REGEX,
  uuidv7,
  uuidv7Timestamp,
} from '../src/ids.ts';

const fixedRandom = (byte: number) => (n: number) => new Uint8Array(n).fill(byte);

describe('uuidv7', () => {
  it('produces RFC 9562 version 7, variant 10 ids matching the 05 regex', () => {
    for (let i = 0; i < 1000; i++) {
      const id = uuidv7();
      expect(id).toMatch(UUIDV7_REGEX);
      expect(id[14]).toBe('7');
      expect('89ab').toContain(id[19]);
      expect(isUuidv7(id)).toBe(true);
    }
  });

  it('encodes the timestamp in the first 48 bits', () => {
    const gen = createUuidv7Generator();
    const now = Date.UTC(2026, 9, 4, 12, 0, 0, 123);
    const id = gen(now);
    expect(uuidv7Timestamp(id)).toBe(now);
    expect(id.slice(0, 13)).toBe(
      `${now.toString(16).padStart(12, '0').slice(0, 8)}-${now.toString(16).padStart(12, '0').slice(8)}`,
    );
  });

  it('sets version and variant bits regardless of random input', () => {
    const gen = createUuidv7Generator();
    expect(gen(0, fixedRandom(0xff))).toBe('00000000-0000-77ff-bfff-ffffffffffff');
    const gen2 = createUuidv7Generator();
    expect(gen2(0, fixedRandom(0x00))).toBe('00000000-0000-7000-8000-000000000000');
  });

  it('sorts lexicographically in creation order (10k ids)', () => {
    const ids = Array.from({ length: 10_000 }, () => uuidv7());
    expect(new Set(ids).size).toBe(ids.length);
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  it('is monotonic within one millisecond via the rand_a counter', () => {
    const gen = createUuidv7Generator();
    const now = 1_700_000_000_000;
    const ids = Array.from({ length: 5000 }, () => gen(now));
    expect([...ids].sort()).toEqual(ids);
    expect(uuidv7Timestamp(ids[0] ?? '')).toBe(now);
    // Seeded with the top counter bit clear, so at least 2048 ids share the real timestamp.
    expect(uuidv7Timestamp(ids[2047] ?? '')).toBe(now);
  });

  it('advances the timestamp when the counter overflows', () => {
    const gen = createUuidv7Generator();
    const now = 1_700_000_000_000;
    const ids = Array.from({ length: 4097 }, () => gen(now, fixedRandom(0xff)));
    // Seed 0x7ff leaves 0x800 increments before overflow.
    expect(uuidv7Timestamp(ids[0x800] ?? '')).toBe(now);
    expect(uuidv7Timestamp(ids[0x801] ?? '')).toBe(now + 1);
    expect([...ids].sort()).toEqual(ids);
  });

  it('stays monotonic when the clock goes backwards', () => {
    const gen = createUuidv7Generator();
    const a = gen(2_000);
    const b = gen(1_000);
    expect(b > a).toBe(true);
    expect(uuidv7Timestamp(b)).toBe(2_000);
  });

  it('rejects out-of-range timestamps and short random sources', () => {
    const gen = createUuidv7Generator();
    expect(() => gen(-1)).toThrow(RangeError);
    expect(() => gen(1.5)).toThrow(RangeError);
    expect(() => gen(2 ** 48)).toThrow(RangeError);
    expect(() => gen(0, () => new Uint8Array(3))).toThrow(RangeError);
  });
});

describe('isUuidv7', () => {
  it.each([
    ['0192f3a0-0000-7000-8000-000000000000', true],
    ['0192F3A0-0000-7000-8000-000000000000', false],
    ['0192f3a0-0000-4000-8000-000000000000', false],
    ['0192f3a0-0000-7000-c000-000000000000', false],
    ['0192f3a0000070008000000000000000', false],
    ['', false],
    [42, false],
    [null, false],
  ])('%s → %s', (value, expected) => {
    expect(isUuidv7(value)).toBe(expected);
  });

  it('uuidv7Timestamp rejects non-v7 input', () => {
    expect(() => uuidv7Timestamp('nope')).toThrow(TypeError);
  });
});
