import { describe, expect, test } from 'vitest';
import { blankSpan, resolveGroupToken } from './title-tokens';

const groups = [
  { id: 'inbox', name: 'Inbox' },
  { id: 'prio', name: 'Prio' },
  { id: 'prio2', name: 'prio later' },
  { id: 'errands', name: 'Errands' },
];

describe('`>Group` token (02 §3.4)', () => {
  test('exact name first, then case-insensitive, then prefix', () => {
    expect(resolveGroupToken('Call >Prio', groups)?.groupId).toBe('prio');
    expect(resolveGroupToken('Call >prio', groups)?.groupId).toBe('prio');
    expect(resolveGroupToken('Call >err', groups)?.groupId).toBe('errands');
    expect(resolveGroupToken('Call >"prio later"', groups)?.groupId).toBe('prio2');
  });

  test('the span covers the token; a date phrase may follow it', () => {
    const hit = resolveGroupToken('Call >err tomorrow', groups);
    expect(hit).toMatchObject({ start: 5, end: 9, name: 'Errands' });
    expect(blankSpan('Call >err tomorrow', hit as { start: number; end: number })).toBe(
      'Call      tomorrow',
    );
  });

  test('unknown names, escaped tokens and cancelled spans stay text', () => {
    expect(resolveGroupToken('Call >nowhere', groups)).toBeNull();
    expect(resolveGroupToken('Read `>Prio`', groups)).toBeNull();
    expect(resolveGroupToken('Call >Prio', groups, [{ start: 5, end: 10 }])).toBeNull();
    expect(resolveGroupToken('a > b', groups)).toBeNull();
  });
});
