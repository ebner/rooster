import { afterEach, describe, expect, test } from 'vitest';
import { sweepUserStorage, userStorageKey } from './user-storage';

afterEach(() => localStorage.clear());

describe('per-user localStorage', () => {
  test('one prefix per user', () => {
    expect(userStorageKey('u1', 'palette.recent')).toBe('rooster.user.u1.palette.recent');
  });

  test('the sweep removes every user key and the legacy recents, and keeps device prefs', () => {
    localStorage.setItem(userStorageKey('u1', 'palette.recent'), '[]');
    localStorage.setItem(userStorageKey('u2', 'palette.recent'), '[]');
    localStorage.setItem('rooster.palette.recent.u1', '[{"title":"Secret"}]');
    localStorage.setItem('rooster.locale', 'sv');
    sweepUserStorage();
    expect(Object.keys(localStorage)).toEqual(['rooster.locale']);
  });

  test('with a user to keep, only the other users go', () => {
    localStorage.setItem(userStorageKey('u1', 'palette.recent'), '[]');
    localStorage.setItem(userStorageKey('u10', 'palette.recent'), '[]');
    localStorage.setItem(userStorageKey('u2', 'palette.recent'), '[]');
    sweepUserStorage('u1');
    expect(Object.keys(localStorage)).toEqual([userStorageKey('u1', 'palette.recent')]);
  });
});
