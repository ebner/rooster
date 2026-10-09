import { describe, expect, it } from 'vitest';
import {
  assigneeTokenAt,
  findAssigneeToken,
  findDateInTitle,
  matchMembers,
} from '../src/dates/index.ts';

const members = [
  { userId: 'me', name: 'Jannik Lunde', email: 'jannik@example.com' },
  { userId: 'anna', name: 'Anna Svensson', email: 'anna.s@example.com' },
  { userId: 'annika', name: 'Annika Berg' },
  { userId: 'ake', name: 'Åke Ström', email: 'ake@example.com' },
  { userId: 'bo', name: 'Bo' },
  { userId: 'bo2', name: 'Bo' },
];

describe('findAssigneeToken (02 §3.4 `@name`)', () => {
  it.each([
    ['Call the bank @anna', { start: 14, end: 19, query: 'anna', userId: 'anna' }],
    ['Call @"Anna Svensson"', { start: 5, end: 21, query: 'Anna Svensson', userId: 'anna' }],
    ['Fix @ake tomorrow', { start: 4, end: 8, query: 'ake', userId: 'ake' }],
    ['Fix @Åke fri 9am', { start: 4, end: 8, query: 'Åke', userId: 'ake' }],
    ['Fix @ann', { start: 4, end: 8, query: 'ann', userId: null }],
    ['Fix @annik', { start: 4, end: 10, query: 'annik', userId: 'annika' }],
    ['Fix @svensson', { start: 4, end: 13, query: 'svensson', userId: 'anna' }],
    ['Fix @jannik', { start: 4, end: 11, query: 'jannik', userId: 'me' }],
    ['Fix @me', { start: 4, end: 7, query: 'me', userId: 'me' }],
    ['Fix @bo', { start: 4, end: 7, query: 'bo', userId: null }],
    ['Fix @nobody', { start: 4, end: 11, query: 'nobody', userId: null }],
    ['@anna then @bo2x', { start: 11, end: 16, query: 'bo2x', userId: null }],
    ['@anna', { start: 0, end: 5, query: 'anna', userId: 'anna' }],
  ])('%j → %j', (title, expected) => {
    expect(findAssigneeToken(title, members, 'me')).toEqual(expected);
  });

  it.each([
    'Fix the bug',
    'Fix @anna now',
    'Fix @anna #urgent',
    'mail a@anna',
    'At @9am',
    'Use `@anna`',
    'Use `see @anna`',
    'Fix @"open quote',
  ])('%j → null', (title) => {
    expect(findAssigneeToken(title, members, 'me')).toBeNull();
  });

  it('@me needs the viewer', () => {
    expect(findAssigneeToken('Fix @me', members)?.userId).toBeNull();
  });

  it('a quoted name is an inline token, so no date parses inside it', () => {
    const ctx = {
      today: '2026-10-09',
      locale: 'en' as const,
      weekStart: 1 as const,
      dateFormat: 'MMM d' as const,
    };
    expect(findDateInTitle('Ask @"Team tomorrow"', ctx)).toBeNull();
    expect(findDateInTitle('Ask Team tomorrow', ctx)).not.toBeNull();
  });
});

describe('matchMembers', () => {
  it('ranks whole names, then name prefixes, then word prefixes, then emails', () => {
    expect(matchMembers('an', members)).toEqual([
      { userId: 'anna', exact: false },
      { userId: 'annika', exact: false },
    ]);
    expect(matchMembers('s', members).map((m) => m.userId)).toEqual(['anna', 'ake']);
    expect(matchMembers('anna.s', members)).toEqual([{ userId: 'anna', exact: true }]);
    expect(matchMembers('ann', [{ userId: 'x', name: 'X', email: 'annie@a.test' }])).toEqual([
      { userId: 'x', exact: false },
    ]);
    expect(matchMembers('', members)).toHaveLength(members.length);
    expect(matchMembers('mig', members, 'me')).toEqual([{ userId: 'me', exact: true }]);
  });
});

describe('assigneeTokenAt (autocomplete)', () => {
  it('finds the token the caret is in or after', () => {
    expect(assigneeTokenAt('Fix @an', 7)).toEqual({ start: 4, end: 7, query: 'an' });
    expect(assigneeTokenAt('Fix @anna tomorrow', 6)).toEqual({ start: 4, end: 9, query: 'anna' });
    expect(assigneeTokenAt('Fix @', 5)).toEqual({ start: 4, end: 5, query: '' });
    expect(assigneeTokenAt('Fix @"Anna S', 12)).toEqual({ start: 4, end: 12, query: 'Anna S' });
    expect(assigneeTokenAt('Fix @"Anna S" x', 8)).toEqual({
      start: 4,
      end: 13,
      query: 'Anna S',
    });
    expect(assigneeTokenAt('mail a@b', 8)).toBeNull();
    expect(assigneeTokenAt('Fix @9', 6)).toBeNull();
    expect(assigneeTokenAt('Fix anna', 8)).toBeNull();
  });
});
