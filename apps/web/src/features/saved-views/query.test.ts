import { parseSearchQuery } from '@rooster/core/search';
import { describe, expect, test } from 'vitest';
import {
  emptyViewQuery,
  queryFromEveryone,
  queryFromSearch,
  queryFromTagFilter,
  searchHasFilters,
  suggestViewName,
} from './query';

/** ADR 0073 B7: the queries "Save as view" makes, and the names it suggests. */

const tags = [
  { id: 't1', name: 'Juniper' },
  { id: 't2', name: 'Fika' },
];
const members = [
  { userId: 'u1', name: 'Anna Lindqvist', email: 'anna@example.com' },
  { userId: 'u2', name: 'Markus Berg', email: 'markus@example.com' },
];
const label = {
  me: 'Me',
  unassigned: 'Unassigned',
  due: (due: string) => `due:${due}`,
  status: (status: string) => `is:${status}`,
  fallback: 'New view',
};

describe('Save as view', () => {
  test('My tasks’ tag filter: the tags across people (a project view with one tag)', () => {
    expect(queryFromTagFilter(['t1'])).toEqual({ ...emptyViewQuery, tags: ['t1'] });
  });

  test('Everyone’s filters: tags, due, and one member (several become anyone)', () => {
    expect(queryFromEveryone({ tagIds: ['t2'], due: 'nodate', members: ['u1'] })).toEqual({
      ...emptyViewQuery,
      tags: ['t2'],
      due: 'none',
      assignee: 'u1',
    });
    expect(queryFromEveryone({ tagIds: [], due: 'week', members: [null] }).assignee).toBe(
      'unassigned',
    );
    expect(queryFromEveryone({ tagIds: [], due: 'any', members: ['u1', 'u2'] }).assignee).toBe(
      'anyone',
    );
  });

  test('a palette search: #tags by name, one @person, due: and is:; free text is dropped', () => {
    const parsed = parseSearchQuery('banners #juniper @anna due:overdue is:done');
    expect(searchHasFilters(parsed)).toBe(true);
    expect(queryFromSearch(parsed, { tags, members })).toEqual({
      tags: ['t1'],
      tagMode: 'any',
      assignee: 'u1',
      due: 'overdue',
      status: 'done',
    });
    expect(queryFromSearch(parseSearchQuery('@me'), { tags, members })?.assignee).toBe('me');
    // Several #tags in a search all apply (the list filters take any of them).
    expect(queryFromSearch(parseSearchQuery('#juniper #fika'), { tags, members })).toMatchObject({
      tags: ['t1', 't2'],
      tagMode: 'all',
    });
    // Nothing of it applies (an unknown tag): no view.
    expect(queryFromSearch(parseSearchQuery('#nope'), { tags, members })).toBeNull();
    expect(searchHasFilters(parseSearchQuery('banners'))).toBe(false);
  });

  test('names: the tags, else the other filters, else a fallback; at most 60 characters', () => {
    const ctx = { tags, members, label };
    expect(suggestViewName({ ...emptyViewQuery, tags: ['t1', 't2'] }, ctx)).toBe('Juniper, Fika');
    expect(suggestViewName({ ...emptyViewQuery, assignee: 'u2', due: 'week' }, ctx)).toBe(
      'Markus Berg · due:week',
    );
    expect(suggestViewName(emptyViewQuery, ctx)).toBe('New view');
    const long = { ...ctx, tags: [{ id: 't9', name: 'x'.repeat(80) }] };
    expect(suggestViewName({ ...emptyViewQuery, tags: ['t9'] }, long)).toHaveLength(60);
  });
});
