import { describe, expect, it } from 'vitest';
import {
  type DateFormat,
  type FormatContext,
  formatRelative,
  formatTime,
  type Locale,
  type RelativeInput,
  type TimeFormat,
} from '../src/dates.ts';

// 2026-10-05 is a Monday.
const TODAY = '2026-10-05';

function ctx(
  locale: Locale,
  dateFormat: DateFormat = 'MMM d',
  timeFormat: TimeFormat = '24h',
): FormatContext {
  return { today: TODAY, locale, dateFormat, timeFormat };
}

type Row = [label: string, input: RelativeInput, context: FormatContext, expected: string];

const rows: Row[] = [
  // 02 §8.3, EN
  ['today', { dueDate: '2026-10-05' }, ctx('en'), 'Today'],
  ['tomorrow', { dueDate: '2026-10-06' }, ctx('en'), 'Tomorrow'],
  ['yesterday', { dueDate: '2026-10-04' }, ctx('en'), 'Yesterday'],
  ['+2 days', { dueDate: '2026-10-07' }, ctx('en'), 'Wed'],
  ['+4 days', { dueDate: '2026-10-09' }, ctx('en'), 'Fri'],
  ['+6 days', { dueDate: '2026-10-11' }, ctx('en'), 'Sun'],
  ['+7 days', { dueDate: '2026-10-12' }, ctx('en'), 'Oct 12'],
  ['+7 days, d MMM', { dueDate: '2026-10-12' }, ctx('en', 'd MMM'), '12 Oct'],
  ['-2 days', { dueDate: '2026-10-03' }, ctx('en'), 'Oct 3'],
  ['current year', { dueDate: '2026-01-15' }, ctx('en'), 'Jan 15'],
  ['other year', { dueDate: '2027-10-12' }, ctx('en'), 'Oct 12, 2027'],
  ['other year, d MMM', { dueDate: '2027-10-12' }, ctx('en', 'd MMM'), '12 Oct 2027'],
  ['past year', { dueDate: '2025-12-31' }, ctx('en'), 'Dec 31, 2025'],
  ['today 24h', { dueDate: '2026-10-05', dueTime: '14:00' }, ctx('en'), 'Today 14:00'],
  ['fri 12h', { dueDate: '2026-10-09', dueTime: '14:00' }, ctx('en', 'MMM d', '12h'), 'Fri 2 PM'],
  [
    '12h minutes',
    { dueDate: '2026-10-05', dueTime: '09:30' },
    ctx('en', 'MMM d', '12h'),
    'Today 9:30 AM',
  ],
  [
    '12h midnight',
    { dueDate: '2026-10-06', dueTime: '00:00' },
    ctx('en', 'MMM d', '12h'),
    'Tomorrow 12 AM',
  ],
  [
    '12h noon',
    { dueDate: '2026-10-12', dueTime: '12:05' },
    ctx('en', 'MMM d', '12h'),
    'Oct 12 12:05 PM',
  ],
  ['null time', { dueDate: '2026-10-05', dueTime: null }, ctx('en'), 'Today'],
  // start ranges, EN
  [
    'range same month',
    { dueDate: '2026-10-12', startDate: '2026-10-10' },
    ctx('en'),
    'Oct 10 – 12',
  ],
  [
    'range across months',
    { dueDate: '2026-11-02', startDate: '2026-10-30' },
    ctx('en'),
    'Oct 30 – Nov 2',
  ],
  [
    'range d MMM same month',
    { dueDate: '2026-10-12', startDate: '2026-10-10' },
    ctx('en', 'd MMM'),
    '10 – 12 Oct',
  ],
  [
    'range d MMM across months',
    { dueDate: '2026-11-02', startDate: '2026-10-30' },
    ctx('en', 'd MMM'),
    '30 Oct – 2 Nov',
  ],
  [
    'range other year',
    { dueDate: '2027-03-12', startDate: '2027-03-10' },
    ctx('en'),
    'Mar 10 – 12, 2027',
  ],
  [
    'range other year across months',
    { dueDate: '2027-04-02', startDate: '2027-03-30' },
    ctx('en'),
    'Mar 30 – Apr 2, 2027',
  ],
  [
    'range across years',
    { dueDate: '2027-01-02', startDate: '2026-12-30' },
    ctx('en'),
    'Dec 30, 2026 – Jan 2, 2027',
  ],
  [
    'range with time',
    { dueDate: '2026-10-12', startDate: '2026-10-10', dueTime: '14:00' },
    ctx('en'),
    'Oct 10 – 12 14:00',
  ],
  [
    'range ignores relative words',
    { dueDate: '2026-10-06', startDate: '2026-10-05' },
    ctx('en'),
    'Oct 5 – 6',
  ],
  ['start equal to due', { dueDate: '2026-10-06', startDate: '2026-10-06' }, ctx('en'), 'Tomorrow'],
  [
    'start after due is ignored',
    { dueDate: '2026-10-06', startDate: '2026-10-08' },
    ctx('en'),
    'Tomorrow',
  ],
  ['null start', { dueDate: '2026-10-06', startDate: null }, ctx('en'), 'Tomorrow'],
  // 02 §8.3, SV
  ['sv today', { dueDate: '2026-10-05' }, ctx('sv'), 'Idag'],
  ['sv tomorrow', { dueDate: '2026-10-06' }, ctx('sv'), 'Imorgon'],
  ['sv yesterday', { dueDate: '2026-10-04' }, ctx('sv'), 'Igår'],
  ['sv +4 days', { dueDate: '2026-10-09' }, ctx('sv'), 'fre'],
  ['sv +2 days', { dueDate: '2026-10-07' }, ctx('sv'), 'ons'],
  ['sv +5 days', { dueDate: '2026-10-10' }, ctx('sv'), 'lör'],
  ['sv current year', { dueDate: '2026-10-12' }, ctx('sv'), '12 okt'],
  ['sv ignores MMM d', { dueDate: '2026-10-12' }, ctx('sv', 'MMM d'), '12 okt'],
  ['sv ignores d MMM', { dueDate: '2026-05-01' }, ctx('sv', 'd MMM'), '1 maj'],
  ['sv other year', { dueDate: '2027-10-12' }, ctx('sv'), '12 okt 2027'],
  ['sv today time', { dueDate: '2026-10-05', dueTime: '14:00' }, ctx('sv'), 'Idag 14:00'],
  ['sv 12h', { dueDate: '2026-10-05', dueTime: '14:00' }, ctx('sv', 'd MMM', '12h'), 'Idag 2 em'],
  [
    'sv 12h morning',
    { dueDate: '2026-10-05', dueTime: '08:15' },
    ctx('sv', 'd MMM', '12h'),
    'Idag 8:15 fm',
  ],
  [
    'sv range same month',
    { dueDate: '2026-10-12', startDate: '2026-10-10' },
    ctx('sv'),
    '10–12 okt',
  ],
  [
    'sv range across months',
    { dueDate: '2026-11-02', startDate: '2026-10-30' },
    ctx('sv'),
    '30 okt – 2 nov',
  ],
  [
    'sv range other year',
    { dueDate: '2027-10-12', startDate: '2027-10-10' },
    ctx('sv'),
    '10–12 okt 2027',
  ],
  [
    'sv range across years',
    { dueDate: '2027-01-02', startDate: '2026-12-30' },
    ctx('sv'),
    '30 dec 2026 – 2 jan 2027',
  ],
];

describe('formatRelative (02 §8.3)', () => {
  it.each(rows)('%s', (_label, input, context, expected) => {
    expect(formatRelative(input, context)).toBe(expected);
  });

  it('every month has an EN and SV abbreviation', () => {
    const en = [];
    const sv = [];
    for (let m = 1; m <= 12; m++) {
      const dueDate = `2027-${String(m).padStart(2, '0')}-01`;
      en.push(formatRelative({ dueDate }, ctx('en')));
      sv.push(formatRelative({ dueDate }, ctx('sv')));
    }
    expect(en.map((s) => s.split(' ')[0])).toEqual([
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ]);
    expect(sv.map((s) => s.split(' ')[1])).toEqual([
      'jan',
      'feb',
      'mar',
      'apr',
      'maj',
      'jun',
      'jul',
      'aug',
      'sep',
      'okt',
      'nov',
      'dec',
    ]);
  });

  it('every weekday has an EN and SV short label', () => {
    // 2026-10-07 (+2) … 2026-10-11 (+6) cover Wed–Sun; from a Thursday, +4/+5 cover Mon/Tue.
    const days = ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    expect(days.map((d) => formatRelative({ dueDate: d }, ctx('en')))).toEqual([
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun',
    ]);
    expect(days.map((d) => formatRelative({ dueDate: d }, ctx('sv')))).toEqual([
      'ons',
      'tor',
      'fre',
      'lör',
      'sön',
    ]);
    const thu = { ...ctx('sv'), today: '2026-10-08' };
    expect(formatRelative({ dueDate: '2026-10-12' }, thu)).toBe('mån');
    expect(formatRelative({ dueDate: '2026-10-13' }, thu)).toBe('tis');
    expect(formatRelative({ dueDate: '2026-10-13' }, { ...thu, locale: 'en' })).toBe('Tue');
  });

  it('rejects invalid input', () => {
    expect(() => formatRelative({ dueDate: '2026-02-30' }, ctx('en'))).toThrow(RangeError);
    expect(() => formatRelative({ dueDate: '2026-10-05', dueTime: '7pm' }, ctx('en'))).toThrow(
      RangeError,
    );
  });
});

describe('formatTime', () => {
  it.each([
    ['00:00', 'en', '24h', '00:00'],
    ['14:00', 'en', '24h', '14:00'],
    ['14:00', 'en', '12h', '2 PM'],
    ['00:30', 'en', '12h', '12:30 AM'],
    ['11:59', 'en', '12h', '11:59 AM'],
    ['12:00', 'en', '12h', '12 PM'],
    ['23:05', 'sv', '12h', '11:05 em'],
    ['23:05', 'sv', '24h', '23:05'],
  ] as const)('%s %s %s → %s', (time, locale, format, expected) => {
    expect(formatTime(time, locale, format)).toBe(expected);
  });
});
