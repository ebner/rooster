import { describe, expect, it } from 'vitest';
import { addDays } from '../src/dates.ts';
import {
  describeRule,
  firstOccurrence,
  formatRule,
  isValidRule,
  nextInstance,
  nextOccurrence,
  normalizeRule,
  parseRule,
  presetOf,
  recurrencePresets,
  weekdayCode,
} from '../src/recurrence.ts';

describe('parseRule / formatRule', () => {
  it.each([
    'FREQ=DAILY',
    'FREQ=DAILY;INTERVAL=3',
    'FREQ=WEEKLY;BYDAY=MO,TH',
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=4',
    'FREQ=MONTHLY;BYDAY=-1FR',
    'FREQ=MONTHLY;BYDAY=2TU',
    'FREQ=MONTHLY;BYMONTHDAY=31',
    'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29',
    'FREQ=DAILY;UNTIL=20261231',
  ])('round-trips %s', (raw) => {
    const rule = parseRule(raw);
    expect(rule).not.toBeNull();
    expect(formatRule(rule as NonNullable<typeof rule>)).toBe(raw);
    expect(isValidRule(raw)).toBe(true);
  });

  it('orders parts canonically', () => {
    const rule = parseRule('BYDAY=TH,MO;INTERVAL=1;FREQ=WEEKLY');
    expect(rule && formatRule(rule)).toBe('FREQ=WEEKLY;BYDAY=MO,TH');
  });

  it.each([
    '',
    'FREQ=HOURLY',
    'INTERVAL=2',
    'FREQ=DAILY;FREQ=DAILY',
    'FREQ=DAILY;INTERVAL=0',
    'FREQ=DAILY;INTERVAL=1000',
    'FREQ=DAILY;COUNT=2;UNTIL=20261231',
    'FREQ=WEEKLY;BYDAY=1MO',
    'FREQ=WEEKLY;BYDAY=MO,MO',
    'FREQ=MONTHLY;BYDAY=MO',
    'FREQ=MONTHLY;BYDAY=1MO,2TU',
    'FREQ=MONTHLY;BYDAY=5MO',
    'FREQ=MONTHLY;BYDAY=1MO;BYMONTHDAY=3',
    'FREQ=DAILY;BYDAY=MO',
    'FREQ=DAILY;BYMONTHDAY=3',
    'FREQ=MONTHLY;BYMONTH=3',
    'FREQ=YEARLY;BYMONTH=13',
    'FREQ=MONTHLY;BYMONTHDAY=32',
    'FREQ=DAILY;UNTIL=20260231',
    'FREQ=DAILY;UNTIL=2026-12-31',
    'FREQ=DAILY;COUNT=x',
    'FREQ=DAILY;X-FOO=1',
    'freq=daily',
    'x'.repeat(201),
  ])('rejects %j', (raw) => {
    expect(parseRule(raw)).toBeNull();
    expect(isValidRule(raw)).toBe(false);
  });
});

describe('normalizeRule', () => {
  // 2026-10-07 is a Wednesday.
  it.each([
    ['FREQ=DAILY', '2026-10-07', 'due', 'FREQ=DAILY'],
    ['FREQ=WEEKLY', '2026-10-07', 'due', 'FREQ=WEEKLY;BYDAY=WE'],
    ['FREQ=WEEKLY;INTERVAL=2', '2026-10-07', 'due', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE'],
    ['FREQ=WEEKLY;BYDAY=TH,MO', '2026-10-07', 'due', 'FREQ=WEEKLY;BYDAY=MO,TH'],
    ['FREQ=MONTHLY', '2026-01-31', 'due', 'FREQ=MONTHLY;BYMONTHDAY=31'],
    ['FREQ=MONTHLY;BYMONTHDAY=15', '2026-10-07', 'due', 'FREQ=MONTHLY;BYMONTHDAY=15'],
    ['FREQ=MONTHLY;BYDAY=-1FR', '2026-10-07', 'due', 'FREQ=MONTHLY;BYDAY=-1FR'],
    ['FREQ=YEARLY', '2028-02-29', 'due', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29'],
    ['FREQ=YEARLY;BYMONTHDAY=3', '2026-10-07', 'due', 'FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=3'],
    ['FREQ=YEARLY;BYMONTH=4', '2026-10-07', 'due', 'FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=7'],
    ['FREQ=DAILY;INTERVAL=1;COUNT=3', '2026-10-07', 'due', 'FREQ=DAILY;COUNT=3'],
    ['FREQ=WEEKLY;UNTIL=20261231', '2026-10-07', 'due', 'FREQ=WEEKLY;BYDAY=WE;UNTIL=20261231'],
    [
      'FREQ=WEEKLY;BYDAY=MO;INTERVAL=2;COUNT=5',
      '2026-10-07',
      'completion',
      'FREQ=WEEKLY;INTERVAL=2;COUNT=5',
    ],
    ['FREQ=MONTHLY;BYMONTHDAY=15', '2026-10-07', 'completion', 'FREQ=MONTHLY'],
    [
      'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=3;UNTIL=20300101',
      '2026-10-07',
      'completion',
      'FREQ=YEARLY;UNTIL=20300101',
    ],
  ] as const)('%s on %s (%s) → %s', (raw, due, basis, expected) => {
    expect(normalizeRule(raw, due, basis)).toBe(expected);
    // Idempotent: normalising a stored rule again changes nothing, whatever the due date.
    expect(normalizeRule(expected, '2027-03-15', basis)).toBe(expected);
  });

  it('returns null for an invalid rule or due date', () => {
    expect(normalizeRule('FREQ=HOURLY', '2026-10-07', 'due')).toBeNull();
    expect(normalizeRule('FREQ=DAILY', '2026-02-30', 'due')).toBeNull();
  });
});

describe('nextOccurrence, basis due', () => {
  it('AC-10.1 every mon, completed on the due Monday 2026-10-05 → 2026-10-12', () => {
    expect(nextOccurrence('FREQ=WEEKLY;BYDAY=MO', 'due', '2026-10-05', '2026-10-05')).toBe(
      '2026-10-12',
    );
  });

  it.each([
    // [rule, due, completedOn, expected]
    ['FREQ=DAILY', '2026-10-07', '2026-10-07', '2026-10-08'],
    ['FREQ=DAILY;INTERVAL=3', '2026-10-07', '2026-10-07', '2026-10-10'],
    // Completed early: the next one still follows the due date.
    ['FREQ=DAILY;INTERVAL=3', '2026-10-07', '2026-10-01', '2026-10-10'],
    ['FREQ=WEEKLY;BYDAY=MO,TH', '2026-10-05', '2026-10-05', '2026-10-08'],
    ['FREQ=WEEKLY;BYDAY=MO,TH', '2026-10-08', '2026-10-08', '2026-10-12'],
    ['FREQ=WEEKLY;BYDAY=MO,WE,FR', '2026-10-09', '2026-10-09', '2026-10-12'],
    // Weekdays: Friday → Monday.
    ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '2026-10-09', '2026-10-09', '2026-10-12'],
    ['FREQ=WEEKLY;BYDAY=SU', '2026-10-11', '2026-10-11', '2026-10-18'],
    // A due date that is not itself an occurrence.
    ['FREQ=WEEKLY;BYDAY=MO', '2026-10-07', '2026-10-07', '2026-10-12'],
    ['FREQ=MONTHLY;BYMONTHDAY=15', '2026-10-15', '2026-10-15', '2026-11-15'],
    ['FREQ=MONTHLY;BYMONTHDAY=15', '2026-10-20', '2026-10-20', '2026-11-15'],
    ['FREQ=MONTHLY;BYMONTHDAY=15', '2026-10-10', '2026-10-10', '2026-10-15'],
    ['FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=12', '2026-10-12', '2026-10-12', '2027-10-12'],
    ['FREQ=YEARLY;INTERVAL=2;BYMONTH=10;BYMONTHDAY=12', '2026-10-12', '2026-10-12', '2028-10-12'],
  ] as const)('%s due %s done %s → %s', (rule, due, done, expected) => {
    expect(nextOccurrence(rule, 'due', due, done)).toBe(expected);
  });

  it('anchors unanchored rules on the due date', () => {
    expect(nextOccurrence('FREQ=WEEKLY', 'due', '2026-10-07', '2026-10-07')).toBe('2026-10-14');
    expect(nextOccurrence('FREQ=MONTHLY', 'due', '2026-01-31', '2026-01-31')).toBe('2026-02-28');
    expect(nextOccurrence('FREQ=YEARLY', 'due', '2026-10-07', '2026-10-07')).toBe('2027-10-07');
  });

  it('clamps month ends without drifting (Jan 31 monthly)', () => {
    const rule = normalizeRule('FREQ=MONTHLY', '2026-01-31', 'due') as string;
    const dates: string[] = [];
    let due = '2026-01-31';
    for (let i = 0; i < 13; i++) {
      due = nextOccurrence(rule, 'due', due, due) as string;
      dates.push(due);
    }
    expect(dates).toEqual([
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
      '2026-07-31',
      '2026-08-31',
      '2026-09-30',
      '2026-10-31',
      '2026-11-30',
      '2026-12-31',
      '2027-01-31',
      '2027-02-28',
    ]);
    // Leap year: Feb 29.
    expect(nextOccurrence(rule, 'due', '2028-01-31', '2028-01-31')).toBe('2028-02-29');
    expect(nextOccurrence(rule, 'due', '2028-02-29', '2028-02-29')).toBe('2028-03-31');
  });

  it('every 3 months on the 30th', () => {
    const rule = 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=30';
    expect(nextOccurrence(rule, 'due', '2026-11-30', '2026-11-30')).toBe('2027-02-28');
    expect(nextOccurrence(rule, 'due', '2027-02-28', '2027-02-28')).toBe('2027-05-30');
  });

  it('yearly on Feb 29: Feb 28 in common years, back to the 29th in leap years', () => {
    const rule = normalizeRule('FREQ=YEARLY', '2028-02-29', 'due') as string;
    const dates: string[] = [];
    let due = '2028-02-29';
    for (let i = 0; i < 5; i++) {
      due = nextOccurrence(rule, 'due', due, due) as string;
      dates.push(due);
    }
    expect(dates).toEqual(['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29', '2033-02-28']);
    // 2100 is not a leap year.
    expect(nextOccurrence(rule, 'due', '2096-02-29', '2096-02-29')).toBe('2097-02-28');
    expect(nextOccurrence(rule, 'due', '2099-02-28', '2099-02-28')).toBe('2100-02-28');
  });

  it('the nth and the last weekday of the month', () => {
    // October 2026: Fridays 2, 9, 16, 23, 30; Tuesdays 6, 13, 20, 27.
    expect(nextOccurrence('FREQ=MONTHLY;BYDAY=-1FR', 'due', '2026-10-30', '2026-10-30')).toBe(
      '2026-11-27',
    );
    expect(nextOccurrence('FREQ=MONTHLY;BYDAY=-1FR', 'due', '2026-10-07', '2026-10-07')).toBe(
      '2026-10-30',
    );
    expect(nextOccurrence('FREQ=MONTHLY;BYDAY=2TU', 'due', '2026-10-13', '2026-10-13')).toBe(
      '2026-11-10',
    );
    expect(nextOccurrence('FREQ=MONTHLY;BYDAY=1MO', 'due', '2026-10-05', '2026-10-05')).toBe(
      '2026-11-02',
    );
    expect(nextOccurrence('FREQ=MONTHLY;BYDAY=4SU', 'due', '2026-10-25', '2026-10-25')).toBe(
      '2026-11-22',
    );
    // A month whose last day is the weekday itself (2027-01-31 is a Sunday).
    expect(nextOccurrence('FREQ=MONTHLY;BYDAY=-1SU', 'due', '2026-12-27', '2026-12-27')).toBe(
      '2027-01-31',
    );
    // Every other month on the last Friday.
    expect(
      nextOccurrence('FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR', 'due', '2026-10-30', '2026-10-30'),
    ).toBe('2026-12-25');
  });

  it('INTERVAL weeks with several weekdays keep the anchor week cadence (Monday weeks)', () => {
    const rule = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH';
    // Week of Mon 2026-10-05 is in cadence: Mon 5 → Thu 8 → Mon 19 → Thu 22 → Mon Nov 2.
    const dates: string[] = [];
    let due = '2026-10-05';
    for (let i = 0; i < 4; i++) {
      due = nextOccurrence(rule, 'due', due, due) as string;
      dates.push(due);
    }
    expect(dates).toEqual(['2026-10-08', '2026-10-19', '2026-10-22', '2026-11-02']);
    // A Sunday due date belongs to the week that started on the Monday before it.
    expect(
      nextOccurrence('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU', 'due', '2026-10-11', '2026-10-11'),
    ).toBe('2026-10-19');
    expect(
      nextOccurrence('FREQ=WEEKLY;INTERVAL=3;BYDAY=WE', 'due', '2026-10-07', '2026-10-07'),
    ).toBe('2026-10-28');
  });

  it('a late completion skips the missed occurrences', () => {
    // Every Monday, due Oct 5, completed on Wednesday Oct 21 → Mon Oct 26.
    expect(nextOccurrence('FREQ=WEEKLY;BYDAY=MO', 'due', '2026-10-05', '2026-10-21')).toBe(
      '2026-10-26',
    );
    // Completed on a Monday that is itself an occurrence: that very day.
    expect(nextOccurrence('FREQ=WEEKLY;BYDAY=MO', 'due', '2026-10-05', '2026-10-19')).toBe(
      '2026-10-19',
    );
    // Every 2 weeks on Mon/Thu, due Mon Oct 5, completed Fri Oct 16 (off-cadence week) → Mon 19.
    expect(
      nextOccurrence('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH', 'due', '2026-10-05', '2026-10-16'),
    ).toBe('2026-10-19');
    // … completed Tue Oct 20 → Thu Oct 22.
    expect(
      nextOccurrence('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH', 'due', '2026-10-05', '2026-10-20'),
    ).toBe('2026-10-22');
    expect(nextOccurrence('FREQ=DAILY;INTERVAL=3', 'due', '2026-10-01', '2026-10-08')).toBe(
      '2026-10-10',
    );
    expect(nextOccurrence('FREQ=DAILY;INTERVAL=3', 'due', '2026-10-01', '2026-10-07')).toBe(
      '2026-10-07',
    );
    expect(nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=15', 'due', '2026-01-15', '2026-10-20')).toBe(
      '2026-11-15',
    );
    expect(
      nextOccurrence('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1', 'due', '2026-01-01', '2026-05-02'),
    ).toBe('2026-07-01');
    expect(nextOccurrence('FREQ=MONTHLY;BYDAY=-1FR', 'due', '2026-01-30', '2026-10-31')).toBe(
      '2026-11-27',
    );
    expect(
      nextOccurrence(
        'FREQ=YEARLY;INTERVAL=2;BYMONTH=3;BYMONTHDAY=1',
        'due',
        '2020-03-01',
        '2026-10-07',
      ),
    ).toBe('2028-03-01');
    // Years late (2000-01-01 was a Saturday): no loop over every missed day.
    expect(nextOccurrence('FREQ=DAILY;INTERVAL=7', 'due', '2000-01-01', '2026-10-07')).toBe(
      '2026-10-10',
    );
  });

  it('COUNT: the instances left including this one; 1 ends the series', () => {
    expect(nextOccurrence('FREQ=DAILY;COUNT=2', 'due', '2026-10-07', '2026-10-07')).toBe(
      '2026-10-08',
    );
    expect(nextOccurrence('FREQ=DAILY;COUNT=1', 'due', '2026-10-07', '2026-10-07')).toBeNull();
  });

  it('UNTIL is inclusive', () => {
    expect(nextOccurrence('FREQ=DAILY;UNTIL=20261008', 'due', '2026-10-07', '2026-10-07')).toBe(
      '2026-10-08',
    );
    expect(
      nextOccurrence('FREQ=DAILY;UNTIL=20261008', 'due', '2026-10-08', '2026-10-08'),
    ).toBeNull();
    expect(
      nextOccurrence('FREQ=WEEKLY;BYDAY=MO;UNTIL=20261011', 'due', '2026-10-05', '2026-10-05'),
    ).toBeNull();
  });

  it('returns null for invalid input', () => {
    expect(nextOccurrence('nope', 'due', '2026-10-07', '2026-10-07')).toBeNull();
    expect(nextOccurrence('FREQ=DAILY', 'due', 'x', '2026-10-07')).toBeNull();
    expect(nextOccurrence('FREQ=DAILY', 'due', '2026-10-07', '2026-13-01')).toBeNull();
  });

  it('property: the next date is an occurrence, after the due date and not before completion', () => {
    let seed = 0xc0ffee;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const rules = [
      'FREQ=DAILY;INTERVAL=2',
      'FREQ=WEEKLY;BYDAY=MO,TH',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SA',
      'FREQ=MONTHLY;BYMONTHDAY=31',
      'FREQ=MONTHLY;BYDAY=-1FR',
      'FREQ=MONTHLY;INTERVAL=2;BYDAY=3WE',
      'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29',
    ];
    for (let i = 0; i < 500; i++) {
      const rule = rules[random(rules.length)] as string;
      const due = addDays('2024-01-01', random(1500));
      const done = addDays(due, random(120) - 30);
      const next = nextOccurrence(rule, 'due', due, done) as string;
      expect(next > due).toBe(true);
      expect(next >= done).toBe(true);
      // Nothing is skipped: no date between the lower bound and `next` is an occurrence, and
      // `next` itself is one (it reproduces from the day before).
      const lower = done > due ? done : addDays(due, 1);
      if (lower < next) {
        expect(nextOccurrence(rule, 'due', due, addDays(next, -1)) ?? '').toBe(next);
      }
      expect(nextOccurrence(rule, 'due', due, next)).toBe(next);
    }
  });
});

describe('nextOccurrence, basis completion', () => {
  it('AC-10.1 every 3 days after done, completed Oct 7 → Oct 10', () => {
    expect(nextOccurrence('FREQ=DAILY;INTERVAL=3', 'completion', '2026-10-01', '2026-10-07')).toBe(
      '2026-10-10',
    );
  });

  it.each([
    ['FREQ=DAILY', '2026-10-07', '2026-10-08'],
    ['FREQ=WEEKLY;INTERVAL=2', '2026-10-07', '2026-10-21'],
    ['FREQ=MONTHLY', '2026-01-31', '2026-02-28'],
    ['FREQ=MONTHLY;INTERVAL=13', '2026-01-31', '2027-02-28'],
    ['FREQ=YEARLY', '2028-02-29', '2029-02-28'],
    // BY parts are ignored with this basis.
    ['FREQ=WEEKLY;BYDAY=MO', '2026-10-07', '2026-10-14'],
  ] as const)('%s completed %s → %s', (rule, done, expected) => {
    expect(nextOccurrence(rule, 'completion', '2026-01-01', done)).toBe(expected);
  });

  it('applies the end conditions', () => {
    expect(
      nextOccurrence('FREQ=DAILY;COUNT=1', 'completion', '2026-10-01', '2026-10-07'),
    ).toBeNull();
    expect(
      nextOccurrence(
        'FREQ=DAILY;INTERVAL=3;UNTIL=20261009',
        'completion',
        '2026-10-01',
        '2026-10-07',
      ),
    ).toBeNull();
    expect(
      nextOccurrence(
        'FREQ=DAILY;INTERVAL=3;UNTIL=20261010',
        'completion',
        '2026-10-01',
        '2026-10-07',
      ),
    ).toBe('2026-10-10');
  });
});

describe('nextInstance', () => {
  it('shifts the start date and decrements COUNT', () => {
    expect(
      nextInstance(
        'FREQ=WEEKLY;BYDAY=MO;COUNT=3',
        'due',
        { dueDate: '2026-10-05', startDate: '2026-10-01' },
        '2026-10-05',
      ),
    ).toEqual({
      dueDate: '2026-10-12',
      startDate: '2026-10-08',
      recurrence: 'FREQ=WEEKLY;BYDAY=MO;COUNT=2',
    });
  });

  it('normalises the rule against the current due date (anchors never drift)', () => {
    expect(
      nextInstance('FREQ=MONTHLY', 'due', { dueDate: '2026-01-31', startDate: null }, '2026-01-31'),
    ).toEqual({ dueDate: '2026-02-28', startDate: null, recurrence: 'FREQ=MONTHLY;BYMONTHDAY=31' });
    expect(
      nextInstance(
        'FREQ=DAILY;INTERVAL=3;UNTIL=20261231',
        'completion',
        { dueDate: '2026-10-01', startDate: null },
        '2026-10-07',
      ),
    ).toEqual({
      dueDate: '2026-10-10',
      startDate: null,
      recurrence: 'FREQ=DAILY;INTERVAL=3;UNTIL=20261231',
    });
  });

  it('returns null when the series ends', () => {
    const current = { dueDate: '2026-10-05', startDate: null };
    expect(nextInstance('FREQ=WEEKLY;BYDAY=MO;COUNT=1', 'due', current, '2026-10-05')).toBeNull();
    expect(nextInstance('FREQ=DAILY;UNTIL=20261005', 'due', current, '2026-10-05')).toBeNull();
    expect(nextInstance('bad', 'due', current, '2026-10-05')).toBeNull();
  });
});

describe('firstOccurrence', () => {
  // 2026-10-07 is a Wednesday.
  it.each([
    ['FREQ=DAILY', 'due', '2026-10-07'],
    ['FREQ=WEEKLY;BYDAY=MO', 'due', '2026-10-12'],
    ['FREQ=WEEKLY;BYDAY=WE', 'due', '2026-10-07'],
    ['FREQ=WEEKLY;BYDAY=MO,TH', 'due', '2026-10-08'],
    ['FREQ=WEEKLY;INTERVAL=2', 'due', '2026-10-07'],
    ['FREQ=MONTHLY', 'due', '2026-10-07'],
    ['FREQ=MONTHLY;BYMONTHDAY=15', 'due', '2026-10-15'],
    ['FREQ=MONTHLY;BYMONTHDAY=5', 'due', '2026-11-05'],
    ['FREQ=MONTHLY;BYDAY=-1FR', 'due', '2026-10-30'],
    ['FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=1', 'due', '2027-10-01'],
    ['FREQ=DAILY;INTERVAL=3', 'completion', '2026-10-07'],
  ] as const)('%s (%s) from 2026-10-07 → %s', (rule, basis, expected) => {
    expect(firstOccurrence(rule, basis, '2026-10-07')).toBe(expected);
  });

  it('is null for an invalid rule or one that ends before it starts', () => {
    expect(firstOccurrence('FREQ=NOPE', 'due', '2026-10-07')).toBeNull();
    expect(firstOccurrence('FREQ=DAILY', 'due', 'today')).toBeNull();
    expect(
      firstOccurrence('FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=20261010', 'due', '2026-10-07'),
    ).toBeNull();
  });
});

describe('UI helpers', () => {
  it('weekdayCode', () => {
    expect(weekdayCode('2026-10-05')).toBe('MO');
    expect(weekdayCode('2026-10-11')).toBe('SU');
  });

  it('recurrencePresets are normalised against the due date', () => {
    const presets = recurrencePresets('2026-10-07');
    expect(presets).toEqual([
      { id: 'daily', rule: 'FREQ=DAILY' },
      { id: 'weekdays', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
      { id: 'weekly', rule: 'FREQ=WEEKLY;BYDAY=WE' },
      { id: 'monthly', rule: 'FREQ=MONTHLY;BYMONTHDAY=7' },
      { id: 'yearly', rule: 'FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=7' },
    ]);
    for (const p of presets) expect(normalizeRule(p.rule, '2026-10-07', 'due')).toBe(p.rule);
  });

  it('presetOf recognises presets, with or without an end condition', () => {
    expect(presetOf('FREQ=WEEKLY', '2026-10-07')).toBe('weekly');
    expect(presetOf('FREQ=WEEKLY;BYDAY=WE;COUNT=3', '2026-10-07')).toBe('weekly');
    expect(presetOf('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '2026-10-07')).toBe('weekdays');
    expect(presetOf('FREQ=MONTHLY', '2026-10-07')).toBe('monthly');
    expect(presetOf('FREQ=YEARLY;UNTIL=20300101', '2026-10-07')).toBe('yearly');
    expect(presetOf('FREQ=DAILY', '2026-10-07')).toBe('daily');
    expect(presetOf('FREQ=DAILY;INTERVAL=2', '2026-10-07')).toBeNull();
    expect(presetOf('FREQ=WEEKLY;BYDAY=MO', '2026-10-07')).toBeNull();
    expect(presetOf('bad', '2026-10-07')).toBeNull();
  });

  it('describeRule', () => {
    expect(describeRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=TH,MO;COUNT=4')).toEqual({
      basis: 'due',
      freq: 'WEEKLY',
      interval: 2,
      weekdays: ['MO', 'TH'],
      everyWeekday: false,
      end: { kind: 'count', count: 4 },
    });
    expect(describeRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toMatchObject({ everyWeekday: true });
    expect(describeRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR')).toMatchObject({
      everyWeekday: false,
    });
    expect(describeRule('FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20271231')).toEqual({
      basis: 'due',
      freq: 'MONTHLY',
      interval: 1,
      everyWeekday: false,
      nthWeekday: { nth: -1, weekday: 'FR' },
      end: { kind: 'until', until: '2027-12-31' },
    });
    expect(describeRule('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29')).toMatchObject({
      month: 2,
      monthDay: 29,
      end: { kind: 'never' },
    });
    expect(describeRule('FREQ=MONTHLY;BYMONTHDAY=15')).toMatchObject({ monthDay: 15 });
    expect(describeRule('FREQ=DAILY;INTERVAL=3', 'completion')).toEqual({
      basis: 'completion',
      freq: 'DAILY',
      interval: 3,
      everyWeekday: false,
      end: { kind: 'never' },
    });
    expect(describeRule('nope')).toBeNull();
  });
});
