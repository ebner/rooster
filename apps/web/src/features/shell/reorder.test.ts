import { describe, expect, test } from 'vitest';
import { reorderIntent } from './reorder';

const ids = ['a', 'b', 'c', 'd'];

describe('reorderIntent (06 §1: afterId above, beforeId below)', () => {
  test('moving down one position', () => {
    expect(reorderIntent(ids, 1, 2)).toEqual({ orgId: 'b', afterId: 'c', beforeId: 'd' });
  });
  test('moving up one position', () => {
    expect(reorderIntent(ids, 2, 1)).toEqual({ orgId: 'c', afterId: 'a', beforeId: 'b' });
  });
  test('to the top has no item above', () => {
    expect(reorderIntent(ids, 3, 0)).toEqual({ orgId: 'd', afterId: null, beforeId: 'a' });
  });
  test('to the end has no item below', () => {
    expect(reorderIntent(ids, 0, 3)).toEqual({ orgId: 'a', afterId: 'd', beforeId: null });
  });
  test('no move and out-of-range targets give null', () => {
    expect(reorderIntent(ids, 2, 2)).toBeNull();
    expect(reorderIntent(ids, 0, 4)).toBeNull();
    expect(reorderIntent(ids, 0, -1)).toBeNull();
  });
});
