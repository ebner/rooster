import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  forgetRecentTask,
  readRecentTasks,
  recentTasksMax,
  recordRecentTask,
  updateRecentTitles,
} from './recent-tasks';

const entry = (id: string, title = '') => ({ id, orgId: 'org', title, at: 1 });

describe('recent tasks (02 §12: the last 8 opened)', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  test('most recent first, de-duplicated, capped at 8, per user', () => {
    for (let i = 0; i < 10; i++) recordRecentTask('u1', entry(`t${i}`));
    recordRecentTask('u1', entry('t3'));
    const ids = readRecentTasks('u1').map((e) => e.id);
    expect(ids).toHaveLength(recentTasksMax);
    expect(ids[0]).toBe('t3');
    expect(new Set(ids).size).toBe(ids.length);
    expect(readRecentTasks('u2')).toEqual([]);
  });

  test('a known title survives a re-open without one; titles can be refreshed', () => {
    recordRecentTask('u1', entry('a', 'Alpha'));
    recordRecentTask('u1', entry('a'));
    expect(readRecentTasks('u1')[0]?.title).toBe('Alpha');
    updateRecentTitles('u1', new Map([['a', 'Alpha 2']]));
    expect(readRecentTasks('u1')[0]?.title).toBe('Alpha 2');
    forgetRecentTask('u1', 'a');
    expect(readRecentTasks('u1')).toEqual([]);
  });

  test('corrupt or unavailable storage reads as empty and never throws', () => {
    localStorage.setItem('rooster.palette.recent.u1', '{not json');
    expect(readRecentTasks('u1')).toEqual([]);
    localStorage.setItem('rooster.palette.recent.u1', JSON.stringify([{ id: 1 }, entry('ok')]));
    expect(readRecentTasks('u1').map((e) => e.id)).toEqual(['ok']);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => recordRecentTask('u1', entry('b'))).not.toThrow();
  });
});
