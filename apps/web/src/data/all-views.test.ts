import { describe, expect, test } from 'vitest';
import { combineStatus, listSettled } from './all-views';

/** ADR 0073 A9: an org whose list can't load offline doesn't hold up All organisations. */

type Result = Parameters<typeof combineStatus>[0][number];
const result = (fields: Partial<Result>) =>
  ({ data: undefined, isError: false, fetchStatus: 'idle', error: null, ...fields }) as Result;

describe('All organisations: list status', () => {
  test('a query paused offline without a cached list counts as settled (an empty org)', () => {
    expect(listSettled(result({ fetchStatus: 'paused' }))).toBe(true);
    expect(listSettled(result({ fetchStatus: 'fetching' }))).toBe(false);
    const status = combineStatus([
      result({ data: { tasks: {} } }),
      result({ fetchStatus: 'paused' }),
    ]);
    expect(status.ready).toBe(true);
    expect(status.error).toBeNull();
  });

  test('still loading: not ready', () => {
    expect(
      combineStatus([result({ data: { tasks: {} } }), result({ fetchStatus: 'fetching' })]).ready,
    ).toBe(false);
  });
});
