import { describe, expect, it } from 'vitest';
import {
  addDays,
  type DateParseContext,
  type DateParseResult,
  findDateInTitle,
  findGroupToken,
  type ParseLocale,
  parseDatePhrase,
  parseIsoDate,
  stripBackticks,
  stripTitleMatch,
} from '../src/dates.ts';
import { CORPUS } from './dates.corpus.ts';

function ctxFor(locale: ParseLocale, today: string, weekStart: 0 | 1 = 1): DateParseContext {
  return { locale, today, weekStart, dateFormat: locale === 'en' ? 'MMM d' : 'd MMM' };
}

function flat(result: DateParseResult | null): string | null {
  if (!result) return null;
  return result.time ? `${result.date} ${result.time}` : result.date;
}

function flatRecurrence(result: DateParseResult | null): string | undefined {
  const r = result?.recurrence;
  if (r === undefined) return undefined;
  return r.basis === 'completion' ? `after:${r.rule}` : r.rule;
}

const W = '2026-10-07';
const en = ctxFor('en', W);
const sv = ctxFor('sv', W);

describe('NL date corpus (10 §3.1)', () => {
  it('has at least 150 rows covering both languages and both modes', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(150);
    for (const locale of ['en', 'sv'] as const) {
      for (const mode of ['title', 'picker'] as const) {
        expect(CORPUS.some((r) => r[0] === locale && r[1] === mode)).toBe(true);
      }
    }
    expect(CORPUS.filter((r) => r[5] === null).length).toBeGreaterThanOrEqual(40);
  });

  for (const [locale, mode, input, today, ws, expected, rest, recurrence] of CORPUS) {
    it(`${locale} ${mode} ${JSON.stringify(input)} (today ${today}, ws ${ws}) → ${expected}`, () => {
      const ctx = ctxFor(locale, today, ws);
      if (mode === 'picker') {
        const result = parseDatePhrase(input, ctx);
        expect(flat(result)).toBe(expected);
        expect(flatRecurrence(result)).toBe(recurrence);
        return;
      }
      const match = findDateInTitle(input, ctx);
      expect(flat(match)).toBe(expected);
      expect(flatRecurrence(match)).toBe(recurrence);
      if (match) {
        expect(match.text).toBe(input.slice(match.start, match.end));
        if (rest !== undefined) expect(stripTitleMatch(input, match)).toBe(rest);
      }
    });
  }
});

describe('findDateInTitle', () => {
  it('returns UTF-16 offsets and the matched text, prepositions included', () => {
    expect(findDateInTitle('Call Bob on friday', en)).toEqual({
      date: '2026-10-09',
      time: null,
      start: 9,
      end: 18,
      text: 'on friday',
    });
    expect(findDateInTitle('Möte imorgon kl 14', sv)).toMatchObject({
      start: 5,
      end: 18,
      text: 'imorgon kl 14',
      time: '14:00',
    });
    expect(findDateInTitle('Städa i helgen', sv)).toMatchObject({ start: 6, end: 14 });
    expect(findDateInTitle('🐓 Feed tomorrow', en)).toMatchObject({ start: 8, end: 16 });
    expect(findDateInTitle('Tandläkare den 12 oktober', sv)).toMatchObject({
      text: 'den 12 oktober',
    });
  });

  it('returns the last match', () => {
    expect(findDateInTitle('Ship 12 oct, invoice tomorrow', en)).toMatchObject({
      text: 'tomorrow',
    });
  });

  it('never matches inside ignored ranges and falls back to an earlier phrase', () => {
    const title = 'Ship 12 oct tomorrow';
    expect(findDateInTitle(title, en, [{ start: 12, end: 20 }])).toMatchObject({
      date: '2026-10-12',
      start: 5,
      end: 11,
    });
    expect(
      findDateInTitle(title, en, [
        { start: 5, end: 11 },
        { start: 12, end: 20 },
      ]),
    ).toBeNull();
    // An ignored phrase stays text, so an earlier end-only phrase is no longer at the end.
    expect(findDateInTitle('Call Bob fri tomorrow', en, [{ start: 13, end: 21 }])).toBeNull();
    // Partial overlap also blocks.
    expect(findDateInTitle('Call Bob tomorrow', en, [{ start: 10, end: 11 }])).toBeNull();
  });

  it('skips backtick escapes and inline tokens', () => {
    expect(findDateInTitle('Read `next week` notes', en)).toBeNull();
    expect(findDateInTitle('Read `tomorrow` fri', en)).toMatchObject({ date: '2026-10-09' });
    expect(findDateInTitle('Call Bob fri `x`', en)).toBeNull();
    expect(findDateInTitle('Tag #tomorrow', en)).toBeNull();
    expect(findDateInTitle('Move >tomorrow', en)).toBeNull();
    expect(findDateInTitle('Ask @tom', en)).toBeNull();
  });

  it('only parses inside words at word boundaries', () => {
    expect(findDateInTitle('Callfri', en)).toBeNull();
    expect(findDateInTitle('xtomorrow', en)).toBeNull();
    expect(findDateInTitle('Ändra idagx', sv)).toBeNull();
    expect(findDateInTitle('Väntaidag', sv)).toBeNull();
  });
});

describe('parseDatePhrase', () => {
  it('reads slash dates per dateFormat', () => {
    expect(parseDatePhrase('3/4', { ...en, dateFormat: 'd MMM' })).toEqual({
      date: '2027-04-03',
      time: null,
    });
    expect(parseDatePhrase('3/4', { ...en, dateFormat: 'MMM d' })).toEqual({
      date: '2027-03-04',
      time: null,
    });
  });

  it('round-trips random explicit dates (property)', () => {
    const enMonths =
      'January February March April May June July August September October November December'.split(
        ' ',
      );
    const svMonths =
      'januari februari mars april maj juni juli augusti september oktober november december'.split(
        ' ',
      );
    let seed = 0x5eed;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 400; i++) {
      const today = addDays('2024-01-01', random(1500));
      const ctx = { ...en, today, weekStart: random(2) as 0 | 1 };
      const date = addDays(today, random(801));
      const { year, month, day } = parseIsoDate(date);
      const mon = enMonths[month - 1] as string;
      const phrases = [
        `${day} ${mon} ${year}`,
        `${mon.slice(0, 3)} ${day}, ${year}`,
        `${day} ${svMonths[month - 1]} ${year}`,
        date,
      ];
      for (const phrase of phrases) {
        expect(parseDatePhrase(phrase, ctx), phrase).toEqual({ date, time: null });
      }
      // Without a year, any date in the coming 364 days is its own next occurrence.
      if (random(801) < 364) {
        const near = addDays(today, random(364));
        const p = parseIsoDate(near);
        expect(parseDatePhrase(`${p.day} ${enMonths[p.month - 1]}`, ctx)?.date).toBe(near);
      }
    }
  });
});

describe('stripTitleMatch / stripBackticks', () => {
  it('removes the phrase, collapses whitespace and strips escapes', () => {
    expect(stripTitleMatch('Call  Bob on friday  now', { start: 10, end: 19 })).toBe(
      'Call Bob now',
    );
    expect(stripTitleMatch('Read `next week` notes fri', { start: 23, end: 26 })).toBe(
      'Read next week notes',
    );
    expect(stripTitleMatch('tomorrow', { start: 0, end: 8 })).toBe('');
  });

  it('strips paired backticks only', () => {
    expect(stripBackticks('Read `next week` notes')).toBe('Read next week notes');
    expect(stripBackticks('`a` and `b`')).toBe('a and b');
    expect(stripBackticks('dangling ` tick')).toBe('dangling ` tick');
  });
});

describe('findGroupToken', () => {
  it.each([
    ['Buy milk >Errands', { name: 'Errands', start: 9, end: 17 }],
    ['>Errands', { name: 'Errands', start: 0, end: 8 }],
    ['Buy milk >"Home stuff"', { name: 'Home stuff', start: 9, end: 22 }],
    ['Buy milk >Errands   ', { name: 'Errands', start: 9, end: 17 }],
    ['Buy milk >Errands fri', { name: 'Errands', start: 9, end: 17 }],
    ['Köp mjölk >Ärenden imorgon kl 9', { name: 'Ärenden', start: 10, end: 18 }],
    ['Buy milk >Errands 12 okt', { name: 'Errands', start: 9, end: 17 }],
    ['>A then >B', { name: 'B', start: 8, end: 10 }],
    ['>A then >B next week', { name: 'B', start: 8, end: 10 }],
    ['Water >Home every mon at 9', { name: 'Home', start: 6, end: 11 }],
    ['Hyra >Hem den 15:e varje månad', { name: 'Hem', start: 5, end: 9 }],
  ])('%j → %j', (title, expected) => {
    expect(findGroupToken(title)).toEqual(expected);
  });

  it.each([
    'Buy milk',
    'Buy milk >Errands now',
    'Buy milk >Errands #shop',
    'Buy milk >Errands 1/2',
    'a>b',
    'Compare a > b',
    'Use `>Code` here',
    'Use `>Code`',
    'Use `see >Code`',
    '>A >B extra',
  ])('%j → null', (title) => {
    expect(findGroupToken(title)).toBeNull();
  });
});
