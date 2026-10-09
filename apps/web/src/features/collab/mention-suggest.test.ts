import { describe, expect, test } from 'vitest';
import { filterCandidates, insertMention, mentionQueryAt } from './mention-suggest';

const anna = { userId: '01900000-0000-7000-8000-0000000000a1', name: 'Anna Lindqvist' };
const ake = { userId: '01900000-0000-7000-8000-0000000000a2', name: 'Åke Östlund' };
const bob = { userId: '01900000-0000-7000-8000-0000000000a3', name: 'Bob', email: 'rob@x.test' };

describe('mentionQueryAt', () => {
  test('finds the @query before the caret', () => {
    expect(mentionQueryAt('Hi @an', 6)).toEqual({ start: 3, end: 6, query: 'an' });
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, end: 1, query: '' });
    expect(mentionQueryAt('Hi (@an', 7)?.query).toBe('an');
    expect(mentionQueryAt('@anna l', 7)?.query).toBe('anna l');
  });

  test('ignores emails, stored mentions, finished names and newlines', () => {
    expect(mentionQueryAt('mail me@x.test', 12)).toBeNull();
    expect(mentionQueryAt(`@[Anna](user:${anna.userId}) `, 46)).toBeNull();
    expect(mentionQueryAt('@anna lind and', 14)).toBeNull();
    expect(mentionQueryAt('@an\nx', 5)).toBeNull();
    expect(mentionQueryAt('@ x', 3)).toBeNull();
    expect(mentionQueryAt('no at here', 4)).toBeNull();
  });
});

describe('filterCandidates', () => {
  const all = [bob, ake, anna];
  test('prefix matches first, accent-insensitive, then contains', () => {
    expect(filterCandidates(all, '').map((c) => c.name)).toEqual([
      'Åke Östlund',
      'Anna Lindqvist',
      'Bob',
    ]);
    expect(filterCandidates(all, 'ake')).toEqual([ake]);
    expect(filterCandidates(all, 'ostl')).toEqual([ake]);
    expect(filterCandidates(all, 'rob')).toEqual([bob]);
    expect(filterCandidates(all, 'nd').map((c) => c.name)).toEqual([
      'Åke Östlund',
      'Anna Lindqvist',
    ]);
    expect(filterCandidates(all, 'zz')).toEqual([]);
    expect(filterCandidates(all, '', 1)).toHaveLength(1);
  });
});

describe('insertMention', () => {
  test('replaces the query with the stored token and a space', () => {
    const query = mentionQueryAt('Hi @an', 6);
    if (!query) throw new Error('no query');
    const result = insertMention('Hi @an', query, anna);
    expect(result.text).toBe(`Hi @[Anna Lindqvist](user:${anna.userId}) `);
    expect(result.caret).toBe(result.text.length);
  });

  test('keeps the text after the caret', () => {
    const query = mentionQueryAt('@an see', 3);
    if (!query) throw new Error('no query');
    const result = insertMention('@an see', query, anna);
    expect(result.text).toBe(`@[Anna Lindqvist](user:${anna.userId}) see`);
    expect(result.text.slice(result.caret)).toBe('see');
    const nl = insertMention('@an\nx', { start: 0, end: 3, query: 'an' }, anna);
    expect(nl.text.slice(nl.caret)).toBe('\nx');
  });
});
