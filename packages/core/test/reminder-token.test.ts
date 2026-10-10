import { describe, expect, it } from 'vitest';
import {
  findAssigneeToken,
  findDateInTitle,
  findGroupToken,
  findReminderTokens,
  isTitleTail,
  reminderTokenSpans,
  removeSpans,
} from '../src/dates/index.ts';

const en = { locale: 'en', today: '2026-10-07', weekStart: 1, dateFormat: 'MMM d' } as const;

function offsets(title: string): number[] {
  return findReminderTokens(title).map((t) => t.offsetMinutes);
}

describe('!reminder tokens (02 §8.1, FR-REM-4)', () => {
  it.each([
    ['Call Bob !15m', [15]],
    ['Call Bob !2h', [120]],
    ['Call Bob !1d', [1440]],
    ['Call Bob !due', [0]],
    ['Call Bob !DUE', [0]],
    ['Call Bob !1H', [60]],
    ['Call Bob !15m !1d', [15, 1440]],
    ['Call Bob fri 14:00 !1h', [60]],
    ['Call Bob !1h fri 14:00', [60]],
    ['Call Bob !1h #work fri @anna >Calls', [60]],
    ['Call Bob #work !1h', [60]],
    ['Call Bob >Calls !1h', [60]],
    ['Call Bob @"Anna Berg" !1h', [60]],
    ['Call Bob every mon at 9 !15m', [15]],
    ['Call Bob !1h   ', [60]],
    ['!due', [0]],
    // Four weeks is the maximum.
    ['Plan !40320m', [40_320]],
    ['Plan !28d', [40_320]],
  ])('%j → %j', (title, expected) => {
    expect(offsets(title)).toEqual(expected);
  });

  it.each([
    'Ship it!',
    'Ship it !',
    'Ship it !!',
    'Ship it !foo',
    'Ship it !1x',
    'Ship it !15',
    'Ship it !m',
    'Ship it !1h later',
    'Ship it !1h fri now',
    'Ship it !1h fri #x 14:00',
    'Ship it!1h',
    'Ship it !1h!',
    'Ship `!1h`',
    'Plan !29d',
    'Plan !40321m',
    'Plan !123456m',
  ])('%j → none', (title) => {
    expect(findReminderTokens(title)).toEqual([]);
  });

  it('returns spans and the token text', () => {
    expect(findReminderTokens('Call Bob fri !1h #x !due')).toEqual([
      { start: 13, end: 16, text: '!1h', offsetMinutes: 60 },
      { start: 20, end: 24, text: '!due', offsetMinutes: 0 },
    ]);
    const title = 'Call Bob fri !1h';
    const spans = findReminderTokens(title);
    expect(removeSpans(title, spans).trim()).toBe('Call Bob fri');
  });

  it('only a token followed by other tokens counts, so an earlier one stays text', () => {
    expect(findReminderTokens('Ping !1h then !2h').map((t) => t.text)).toEqual(['!2h']);
  });

  it('reminderTokenSpans finds well-formed tokens anywhere', () => {
    expect(reminderTokenSpans('a !1h b !nope !2d `!3h`')).toEqual([
      { start: 2, end: 5, offsetMinutes: 60 },
      { start: 14, end: 17, offsetMinutes: 2880 },
    ]);
  });

  it('isTitleTail accepts reminder tokens after whitespace only', () => {
    expect(isTitleTail(' !1h')).toBe(true);
    expect(isTitleTail(' #x !1h @a')).toBe(true);
    expect(isTitleTail('!1h')).toBe(false);
    expect(isTitleTail(' !1h now')).toBe(false);
    expect(isTitleTail(' !1y')).toBe(false);
    expect(isTitleTail('')).toBe(true);
  });
});

describe('the date phrase and other tokens around reminder tokens', () => {
  it('"Call Bob fri 14:00 !1h" gives fri, 14:00 and a 60-minute reminder', () => {
    const title = 'Call Bob fri 14:00 !1h';
    expect(findDateInTitle(title, en)).toMatchObject({
      date: '2026-10-09',
      time: '14:00',
      text: 'fri 14:00',
    });
    expect(offsets(title)).toEqual([60]);
  });

  it('end-only date phrases may be followed by reminder tokens in any order with others', () => {
    expect(findDateInTitle('Call Bob mon !1d #home', en)).toMatchObject({ date: '2026-10-12' });
    expect(findDateInTitle('Call Bob !1d mon', en)).toMatchObject({ date: '2026-10-12' });
    expect(findDateInTitle('Call Bob mon !1d later', en)).toBeNull();
    expect(findDateInTitle('Call Bob mon !nope', en)).toBeNull();
  });

  it('>Group and @name may be followed by reminder tokens and a date phrase', () => {
    expect(findGroupToken('Buy milk >Errands !1h')).toMatchObject({ name: 'Errands' });
    expect(findGroupToken('Buy milk >Errands fri !1h')).toMatchObject({ name: 'Errands' });
    expect(findGroupToken('Buy milk >Errands !1h fri')).toMatchObject({ name: 'Errands' });
    expect(findGroupToken('Buy milk >Errands !1h now')).toBeNull();
    expect(findGroupToken('Buy milk >Errands fri !1h 14:00')).toBeNull();
    const members = [{ userId: 'u1', name: 'Anna Berg' }];
    expect(findAssigneeToken('Ask @anna !15m', members)).toMatchObject({ userId: 'u1' });
    expect(findAssigneeToken('Ask @anna tomorrow !15m', members)).toMatchObject({ userId: 'u1' });
    expect(findAssigneeToken('Ask @anna !15m now', members)).toBeNull();
  });
});
