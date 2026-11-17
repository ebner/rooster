import { DEFAULT_PREFS } from '@rooster/core/limits';
import { beforeEach, describe, expect, test } from 'vitest';
import type { Me } from '../../data/types';
import { sweepUserStorage, userStorageKey } from '../../lib/user-storage';
import { fixtureMe } from './fixtures';
import {
  fallbackStartPath,
  forgetListPath,
  isListPath,
  rememberListPath,
  startPath,
} from './start-page';

const userId = fixtureMe.user.id;
const key = userStorageKey(userId, 'lastListPath');
const me = (prefs: Partial<Me['prefs'] & object> = {}, orgs = fixtureMe.orgs): Me => ({
  ...fixtureMe,
  orgs,
  prefs: { ...DEFAULT_PREFS, ...prefs },
});
const [personal, company] = fixtureMe.orgs;
const viewId = '0192f5d0-7a1e-7c3a-9f10-0000000c0001';

beforeEach(() => localStorage.clear());

describe('isListPath', () => {
  test('only a list view’s own path', () => {
    expect(isListPath('/o/northwind/today')).toBe(true);
    expect(isListPath('/o/personal/my')).toBe(true);
    expect(isListPath('/all/week')).toBe(true);
    expect(isListPath('/all/t/abc')).toBe(false);
    expect(isListPath('/o/northwind/t/abc')).toBe(false);
    expect(isListPath('/all/nodate')).toBe(false);
    expect(isListPath('/o/northwind/settings')).toBe(false);
    expect(isListPath('/settings/behaviour')).toBe(false);
    expect(isListPath('/inbox')).toBe(false);
    // Phase 13 (ADR 0073 B): a view, but not the unsaved "+ New view".
    expect(isListPath(`/o/northwind/v/${viewId}`)).toBe(true);
    expect(isListPath('/o/northwind/v/new')).toBe(false);
  });
});

describe('the start page (ADR 0073 A6)', () => {
  test('without a cached /me, or the first time: Personal → My tasks', () => {
    expect(startPath(undefined)).toBe('/o/personal/my');
    expect(startPath(me())).toBe(fallbackStartPath);
  });

  test('"The last view": the list view shown last in this browser', () => {
    rememberListPath(userId, '/o/northwind/week');
    expect(startPath(me())).toBe('/o/northwind/week');
    // The pane, settings and other pages are not list views: the last list stays.
    rememberListPath(userId, '/o/northwind/t/0192');
    rememberListPath(userId, '/settings/behaviour');
    expect(startPath(me())).toBe('/o/northwind/week');
    rememberListPath(userId, '/all/overdue');
    expect(startPath(me())).toBe('/all/overdue');
  });

  test('"All organisations · Today" wins, with two orgs or more', () => {
    rememberListPath(userId, '/o/northwind/week');
    expect(startPath(me({ startPage: 'all-today' }))).toBe('/all/today');
    // One org: All organisations isn't offered, so the last view it is.
    expect(startPath(me({ startPage: 'all-today' }, personal ? [personal] : []))).toBe(
      '/o/personal/my',
    );
  });

  test('a stored All view needs two orgs; an org view needs the org', () => {
    rememberListPath(userId, '/all/today');
    expect(startPath(me({}, personal ? [personal] : []))).toBe(fallbackStartPath);
    rememberListPath(userId, '/o/left-org/today');
    expect(startPath(me())).toBe(fallbackStartPath);
    rememberListPath(userId, '/o/personal/today');
    expect(startPath(me())).toBe('/o/personal/today');
  });

  test('the stored value is untrusted: off-origin or not list-shaped falls back', () => {
    for (const bad of [
      '//evil.example/o/a/my',
      'https://evil.example/o/a/my',
      'javascript:alert(1)',
      '/o/northwind/my?next=//evil.example',
      '/o/northwind/my#x',
      '/\\evil.example',
      '/o/northwind/t/1',
    ]) {
      localStorage.setItem(key, bad);
      expect(startPath(me()), bad).toBe(fallbackStartPath);
    }
  });

  test('per user, and swept on sign-out', () => {
    rememberListPath(userId, '/o/northwind/week');
    expect(startPath({ ...me(), user: { ...fixtureMe.user, id: 'someone-else' } })).toBe(
      fallbackStartPath,
    );
    sweepUserStorage(undefined, localStorage, async () => undefined);
    expect(startPath(me())).toBe(fallbackStartPath);
  });

  test('blocked storage falls back quietly', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(() => rememberListPath(userId, '/o/northwind/week', blocked)).not.toThrow();
    expect(startPath(me(), blocked)).toBe(fallbackStartPath);
  });
});

describe('the start page and views (ADR 0073 B)', () => {
  const viewPath = `/o/northwind/v/${viewId}`;

  test('a remembered view opens again while its org is the user’s', () => {
    rememberListPath(userId, viewPath);
    expect(startPath(me())).toBe(viewPath);
    expect(startPath(me({}, personal ? [personal] : []))).toBe(fallbackStartPath);
  });

  test('cached views that lack it open its org’s My tasks; unknown ones open it', () => {
    rememberListPath(userId, viewPath);
    const cached = (ids: string[]) => (orgId: string) =>
      orgId === company?.id ? ids.map((id) => ({ id })) : undefined;
    expect(startPath(me(), localStorage, cached([viewId]))).toBe(viewPath);
    expect(startPath(me(), localStorage, cached([]))).toBe('/o/northwind/my');
    expect(startPath(me(), localStorage, () => undefined)).toBe(viewPath);
  });

  test('"+ New view" is not remembered', () => {
    rememberListPath(userId, '/o/northwind/week');
    rememberListPath(userId, '/o/northwind/v/new');
    expect(startPath(me())).toBe('/o/northwind/week');
  });

  test('forgetListPath drops a view that turned out to be gone, nothing else', () => {
    rememberListPath(userId, viewPath);
    forgetListPath(userId, '/o/northwind/week');
    expect(startPath(me())).toBe(viewPath);
    forgetListPath(userId, viewPath);
    expect(startPath(me())).toBe(fallbackStartPath);
  });
});
