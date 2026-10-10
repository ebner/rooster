import { dueInstant } from '@rooster/core/dates';
import { describe, expect, it } from 'vitest';
import type { Task } from '../src/api.ts';
import { rootCommand } from '../src/cli.ts';
import { completionEntries } from '../src/completion.ts';
import { applyDueFlags, applyRepeatFlag } from '../src/dates.ts';
import { CliError } from '../src/errors.ts';
import { stripAnsi } from '../src/output/color.ts';
import { type DateContext, renderRows, toRow } from '../src/output/format.ts';
import { reminderText, ruleText, sizeText } from '../src/output/schedule.ts';
import { parseRemindFlag, parseRemindFlags, splitReminderTokens } from '../src/reminders.ts';

const me = {
  timezone: 'Europe/Stockholm',
  locale: 'en' as const,
  weekStart: 1 as const,
  dateFormat: 'MMM d' as const,
  prefs: { allDayReminderTime: '08:30' } as never,
};
// Friday 2026-10-09, 12:00 in Stockholm.
const now = Date.UTC(2026, 9, 9, 10, 0);
const none = { dueDate: null, dueTime: null, dueTz: null, startDate: null };

const ctx = (locale: 'en' | 'sv' = 'en'): DateContext => ({
  today: '2026-10-09',
  nowMs: now,
  timezone: 'Europe/Stockholm',
  locale,
  dateFormat: locale === 'en' ? 'MMM d' : 'd MMM',
  timeFormat: '24h',
});

describe('--remind values (P10, 07 §4)', () => {
  it('relative tokens, with or without !, are minutes before the due moment', () => {
    expect(parseRemindFlag('15m', me, now)).toEqual({ offsetMinutes: 15 });
    expect(parseRemindFlag('!1h', me, now)).toEqual({ offsetMinutes: 60 });
    expect(parseRemindFlag(' 1D ', me, now)).toEqual({ offsetMinutes: 1440 });
    expect(parseRemindFlag('due', me, now)).toEqual({ offsetMinutes: 0 });
  });

  it('anything else is an absolute time in the user zone; a bare date uses the all-day time', () => {
    expect(parseRemindFlag('fri 14:00', me, now)).toEqual({
      at: dueInstant('2026-10-16', '14:00', 'Europe/Stockholm'),
    });
    expect(parseRemindFlag('2026-11-02 08:30', me, now)).toEqual({
      at: dueInstant('2026-11-02', '08:30', 'Europe/Stockholm'),
    });
    expect(parseRemindFlag('2026-11-02', me, now)).toEqual({
      at: dueInstant('2026-11-02', '08:30', 'Europe/Stockholm'),
    });
    expect(parseRemindFlag('imorgon 9:00', me, now)).toEqual({
      at: dueInstant('2026-10-10', '09:00', 'Europe/Stockholm'),
    });
  });

  it('refuses recurrence phrases, nonsense and offsets beyond four weeks', () => {
    for (const bad of ['every mon', 'whenever', '', '99999d', '!']) {
      expect(() => parseRemindFlag(bad, me, now)).toThrow(CliError);
    }
    try {
      parseRemindFlag('whenever', me, now);
    } catch (error) {
      expect((error as CliError).exitCode).toBe(5);
      expect((error as Error).message).toContain('--remind');
    }
  });

  it('collapses duplicates, keeping the order', () => {
    expect(parseRemindFlags(['1h', '!1h', 'due', '60m'], me, now)).toEqual([
      { offsetMinutes: 60 },
      { offsetMinutes: 0 },
    ]);
  });

  it('splits reminder tokens out of a picker phrase', () => {
    expect(splitReminderTokens('fri 14:00 !1h !15m !1h')).toEqual({
      phrase: 'fri 14:00',
      offsets: [60, 15],
    });
    expect(splitReminderTokens('!due')).toEqual({ phrase: '', offsets: [0] });
    expect(splitReminderTokens('every mon')).toEqual({ phrase: 'every mon', offsets: [] });
    // Not a token: glued to a word, or out of range.
    expect(splitReminderTokens('fri!1h !99999d').offsets).toEqual([]);
  });
});

describe('--due and --repeat with recurrence (P10, FR-REC-2)', () => {
  it('a recurrence phrase in --due sets the date and the rule; other dates keep the rule', () => {
    expect(applyDueFlags(none, { due: 'every mon' }, me, now)).toEqual({
      ...none,
      dueDate: '2026-10-12',
      recurrence: 'FREQ=WEEKLY;BYDAY=MO',
      recurrenceBasis: 'due',
    });
    const plain = applyDueFlags(none, { due: 'tomorrow' }, me, now);
    expect(plain).not.toHaveProperty('recurrence');
  });

  it('--repeat keeps a due date, takes the first occurrence without one, and none stops', () => {
    expect(applyRepeatFlag(true, 'every 3 days after done', me, now)).toEqual({
      recurrence: 'FREQ=DAILY;INTERVAL=3',
      recurrenceBasis: 'completion',
    });
    expect(applyRepeatFlag(false, 'every mon 9:00', me, now)).toEqual({
      dueDate: '2026-10-12',
      dueTime: '09:00',
      dueTz: 'Europe/Stockholm',
      startDate: null,
      recurrence: 'FREQ=WEEKLY;BYDAY=MO',
      recurrenceBasis: 'due',
    });
    expect(applyRepeatFlag(true, 'none', me, now)).toEqual({
      recurrence: null,
      recurrenceBasis: null,
    });
    for (const bad of ['tomorrow', '2026-10-12', 'banana']) {
      expect(() => applyRepeatFlag(true, bad, me, now)).toThrow(/--repeat/);
    }
  });
});

describe('rule, reminder and size text (the web sentences)', () => {
  it('describes rules in English and Swedish', () => {
    expect(ruleText('FREQ=WEEKLY;BYDAY=MO', 'due', ctx())).toBe('Weekly on Monday');
    expect(ruleText('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'due', ctx())).toBe('Every weekday');
    expect(ruleText('FREQ=DAILY;INTERVAL=3', 'completion', ctx())).toBe('3 days after completion');
    expect(ruleText('FREQ=MONTHLY;BYDAY=-1FR;COUNT=4', 'due', ctx())).toBe(
      'Monthly on the last Friday, 4 times',
    );
    expect(ruleText('FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=24', null, ctx())).toBe('Yearly on Dec 24');
    expect(ruleText('FREQ=WEEKLY;BYDAY=MO', 'due', ctx('sv'))).toBe('Varje vecka på måndag');
    // From a newer server: shown as stored rather than guessed at.
    expect(ruleText('FREQ=HOURLY', 'due', ctx())).toBe('FREQ=HOURLY');
  });

  it('describes reminders: resolved, dormant, absolute and sent', () => {
    const fireAt = dueInstant('2026-10-12', '13:00', 'Europe/Stockholm');
    const base = { kind: 'relative' as const, offsetMinutes: 60, fireAt, firedAt: null };
    expect(reminderText(base, { dueTime: '14:00' }, ctx())).toEqual({
      text: '1 h before · Mon 13:00',
      dormant: false,
      fired: false,
    });
    expect(reminderText({ ...base, offsetMinutes: 0 }, { dueTime: null }, ctx()).text).toBe(
      'On the day · Mon 13:00',
    );
    expect(reminderText({ ...base, fireAt: null }, { dueTime: null }, ctx())).toEqual({
      text: '1 h before · needs a due date',
      dormant: true,
      fired: false,
    });
    const absolute = { kind: 'absolute' as const, offsetMinutes: null, fireAt, firedAt: 1 };
    expect(reminderText(absolute, { dueTime: null }, ctx()).text).toBe('Mon 13:00 (sent)');
    expect(reminderText(base, { dueTime: '14:00' }, ctx('sv')).text).toBe('1 tim före · mån 13:00');
  });

  it('formats sizes', () => {
    expect(sizeText(512, 'en')).toBe('512 byte');
    expect(sizeText(12_800, 'en')).toBe('13 kB');
    expect(sizeText(3_565_158, 'en')).toBe('3.4 MB');
    expect(sizeText(3_565_158, 'sv')).toBe('3,4 MB');
  });
});

describe('rows mark repeating tasks and pending reminders', () => {
  const task = (fields: Partial<Task>) =>
    ({
      id: '0192f3a0-0000-7000-8000-000000000001',
      orgId: 'org',
      seq: 7,
      parentId: null,
      subtaskPosition: null,
      title: 'Water plants',
      hasDescription: false,
      assigneeId: 'me',
      createdBy: 'me',
      dueDate: '2026-10-12',
      dueTime: null,
      dueTz: null,
      startDate: null,
      completedAt: null,
      tagIds: [],
      counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
      placement: { groupId: 'g', position: 'a0' },
      createdAt: 0,
      updatedAt: 0,
      ...fields,
    }) as Task;

  it('↻ and 🔔 after the title, aligned', () => {
    const rows = [
      task({ recurrence: 'FREQ=WEEKLY;BYDAY=MO', recurrenceBasis: 'due', nextReminderAt: 1 }),
      task({ seq: 8, title: 'Plain', recurrence: null, nextReminderAt: null }),
    ].map((t) => toRow(t, { tags: new Map(), dates: ctx() }));
    const lines = renderRows(rows, 0, null).map(stripAnsi);
    expect(lines[0]).toMatch(/○ Water plants {2}↻ 🔔 {2}Mon$/);
    expect(lines[1]).toMatch(/○ Plain {15}Mon$/);
  });
});

describe('completion (P10 flags)', () => {
  it('lists --remind and --repeat, and --no-remind for edit only', async () => {
    const entries = await completionEntries(rootCommand);
    const flags = (path: string) => entries.find((e) => e.path === path)?.flags ?? [];
    expect(flags('add')).toEqual(expect.arrayContaining(['--remind', '--repeat']));
    expect(flags('add')).not.toContain('--no-remind');
    expect(flags('edit')).toEqual(expect.arrayContaining(['--remind', '--no-remind', '--repeat']));
    expect(flags('rm')).toContain('--occurrence');
  });
});
