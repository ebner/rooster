import type { Weekday } from './iso.ts';

export type VocabLang = 'en' | 'sv';

/**
 * One phrase of the 02 §8.2 grammar. `abbr` entries are only active in title mode when the UI
 * language is `lang`; full English words are always active (02 §8.1).
 */
export interface VocabEntry<T> {
  readonly text: string;
  readonly lang: VocabLang;
  readonly abbr: boolean;
  readonly value: T;
}

function entries<const T>(
  lang: VocabLang,
  abbr: boolean,
  value: T,
  ...texts: string[]
): VocabEntry<T>[] {
  return texts.map((text) => ({ text, lang, abbr, value }));
}

function series<const T>(
  lang: VocabLang,
  abbr: boolean,
  values: readonly T[],
  texts: string,
): VocabEntry<T>[] {
  return texts.split(' ').flatMap((group, i) => {
    const value = values[i] as T;
    return entries(lang, abbr, value, ...group.split('/'));
  });
}

const WEEKDAY_VALUES: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];
const MONTH_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
// "may"/"maj" are full words, so the abbreviation series skips May.
const ABBR_MONTH_VALUES = [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12];
const ONE_TO_TEN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** Day offset from today. */
export const DAY_WORDS: readonly VocabEntry<number>[] = [
  ...entries('en', false, 0, 'today'),
  ...entries('en', true, 0, 'tod'),
  ...entries('en', false, 1, 'tomorrow'),
  ...entries('en', true, 1, 'tom', 'tmr'),
  ...entries('sv', false, 0, 'idag', 'i dag'),
  ...entries('sv', false, 1, 'imorgon', 'i morgon', 'imorn'),
  ...entries('sv', false, 2, 'övermorgon', 'i övermorgon'),
];

export const WEEKDAYS: readonly VocabEntry<Weekday>[] = [
  ...series(
    'en',
    false,
    WEEKDAY_VALUES,
    'sunday monday tuesday wednesday thursday friday saturday',
  ),
  ...series('en', true, WEEKDAY_VALUES, 'sun mon tue/tues wed thu/thur/thurs fri sat'),
  ...series('sv', false, WEEKDAY_VALUES, 'söndag måndag tisdag onsdag torsdag fredag lördag'),
  ...series('sv', true, WEEKDAY_VALUES, 'sön mån tis ons tor/tors fre lör'),
];

export const MONTHS: readonly VocabEntry<number>[] = [
  ...series(
    'en',
    false,
    MONTH_VALUES,
    'january february march april may june july august september october november december',
  ),
  ...series('en', true, ABBR_MONTH_VALUES, 'jan feb mar apr jun jul aug sep/sept oct nov dec'),
  ...series(
    'sv',
    false,
    MONTH_VALUES,
    'januari februari mars april maj juni juli augusti september oktober november december',
  ),
  ...series('sv', true, ABBR_MONTH_VALUES, 'jan feb mar apr jun jul aug sep okt nov dec'),
];

export type WeekdayPrefix = 'next' | 'this' | 'on';
export const WEEKDAY_PREFIXES: readonly VocabEntry<WeekdayPrefix>[] = [
  ...entries('en', false, 'next', 'next'),
  ...entries('en', false, 'this', 'this'),
  ...entries('en', false, 'on', 'on'),
  ...entries('sv', false, 'next', 'nästa'),
  ...entries('sv', false, 'on', 'på'),
];

/** Prepositions that belong to an explicit date ("on oct 12", "den 12 oktober"). */
export const DATE_PREFIXES: readonly VocabEntry<null>[] = [
  ...entries('en', false, null, 'on'),
  ...entries('sv', false, null, 'den'),
];

export const NEXT_WEEK: readonly VocabEntry<null>[] = [
  ...entries('en', false, null, 'next week'),
  ...entries('sv', false, null, 'nästa vecka'),
];

export const WEEKENDS: readonly VocabEntry<'this' | 'next'>[] = [
  ...entries('en', false, 'this', 'weekend', 'this weekend'),
  ...entries('en', false, 'next', 'next weekend'),
  ...entries('sv', false, 'this', 'helgen', 'i helgen'),
  ...entries('sv', false, 'next', 'nästa helg'),
];

export const NEXT_MONTH: readonly VocabEntry<null>[] = [
  ...entries('en', false, null, 'next month'),
  ...entries('sv', false, null, 'nästa månad'),
];

export const END_OF: readonly VocabEntry<'week' | 'month'>[] = [
  ...entries('en', false, 'week', 'end of week', 'end of the week'),
  ...entries('en', false, 'month', 'end of month', 'end of the month'),
  ...entries('en', true, 'week', 'eow'),
  ...entries('en', true, 'month', 'eom'),
  ...entries('sv', false, 'week', 'slutet av veckan', 'i slutet av veckan'),
  ...entries('sv', false, 'month', 'slutet av månaden', 'i slutet av månaden'),
];

export const RELATIVE_INTROS: readonly VocabEntry<null>[] = [
  ...entries('en', false, null, 'in'),
  ...entries('sv', false, null, 'om'),
];

export const NUMBER_WORDS: readonly VocabEntry<number>[] = [
  ...entries('en', false, 1, 'a', 'an'),
  ...series('en', false, ONE_TO_TEN, 'one two three four five six seven eight nine ten'),
  ...entries('sv', false, 1, 'ett'),
  ...series('sv', false, ONE_TO_TEN, 'en två tre fyra fem sex sju åtta nio tio'),
];

export type RelativeUnit = 'd' | 'w' | 'm';
export const UNITS: readonly VocabEntry<RelativeUnit>[] = [
  ...series('en', false, ['d', 'w', 'm'], 'day/days week/weeks month/months'),
  ...series('sv', false, ['d', 'w', 'm'], 'dag/dagar vecka/veckor månad/månader'),
];

export const TIME_CONNECTORS: readonly VocabEntry<null>[] = [
  ...entries('en', false, null, 'at', '@'),
  ...entries('sv', false, null, 'klockan'),
  ...entries('sv', true, null, 'kl', 'kl.'),
];

/**
 * Recurrence (P10) is not parsed yet, but a weekday or date inside a recurrence phrase must not
 * become a one-off due date ("Water plants every mon"). These words open a recurrence phrase.
 */
export const RECURRENCE_TRIGGERS: ReadonlySet<string> = new Set([
  'every',
  'each',
  'daily',
  'varje',
  'varannan',
  'var',
  'dagligen',
]);

/** Words that may sit between a recurrence trigger and the weekday/date it governs. */
export const RECURRENCE_FILLERS: ReadonlySet<string> = new Set([
  ...'and och or eller the on på other last first second third fourth sista första andra tredje fjärde annan'.split(
    ' ',
  ),
  ...'day days week weeks month months year years weekday weekdays dag dagar vecka veckor månad månader år vardag'.split(
    ' ',
  ),
  ...NUMBER_WORDS.map((e) => e.text),
  ...WEEKDAYS.map((e) => e.text),
]);
