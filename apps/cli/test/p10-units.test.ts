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
import { FAKE_ENV, fakeApi, ME, ORG } from './support/fake-api.ts';
import { cliHarness } from './support/fake-io.ts';

// OSC 52 sets the clipboard; U+202E reverses what follows.
const HOSTILE = '\u001b]52;c;Y3VybCBldmlsLnNoIHwgc2g=\u0007\u202e';
// biome-ignore lint/suspicious/noControlCharactersInRegex: looking for them is the point.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

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
    expect(applyRepeatFlag('2026-10-20', 'every 3 days after done', me, now)).toEqual({
      recurrence: 'FREQ=DAILY;INTERVAL=3',
      recurrenceBasis: 'completion',
    });
    expect(applyRepeatFlag(null, 'every mon 9:00', me, now)).toEqual({
      dueDate: '2026-10-12',
      dueTime: '09:00',
      dueTz: 'Europe/Stockholm',
      startDate: null,
      recurrence: 'FREQ=WEEKLY;BYDAY=MO',
      recurrenceBasis: 'due',
    });
    expect(applyRepeatFlag('2026-10-20', 'none', me, now)).toEqual({
      recurrence: null,
      recurrenceBasis: null,
    });
    for (const bad of ['tomorrow', '2026-10-12', 'banana']) {
      expect(() => applyRepeatFlag('2026-10-20', bad, me, now)).toThrow(/--repeat/);
    }
  });

  it('implicit anchors come from the due date, not today (today is Oct 9)', () => {
    expect(applyRepeatFlag('2026-11-01', 'monthly', me, now)).toEqual({
      recurrence: 'FREQ=MONTHLY;BYMONTHDAY=1',
      recurrenceBasis: 'due',
    });
    expect(applyRepeatFlag('2026-11-01', 'every 2 weeks', me, now).recurrence).toBe(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU',
    );
    expect(applyRepeatFlag('2026-12-24', 'yearly', me, now).recurrence).toBe(
      'FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=24',
    );
    // An explicit anchor stays as written.
    expect(applyRepeatFlag('2026-11-01', 'every mon', me, now).recurrence).toBe(
      'FREQ=WEEKLY;BYDAY=MO',
    );
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

describe('review finding 1: hostile server values in P10 text', () => {
  it('reminder, rule and size text never pass control or bidi characters through', () => {
    const hostile = {
      kind: 'relative' as const,
      offsetMinutes: HOSTILE as unknown as number,
      fireAt: HOSTILE as unknown as number,
      firedAt: null,
    };
    const view = reminderText(hostile, { dueTime: null }, ctx());
    expect(view.text).not.toMatch(UNSAFE);
    expect(view.dormant).toBe(true);
    expect(view.text).toBe('? · needs a due date');
    const absolute = { ...hostile, kind: 'absolute' as const, fireAt: Number.NaN };
    expect(reminderText(absolute, { dueTime: null }, ctx()).text).not.toMatch(UNSAFE);
    expect(ruleText(`FREQ=${HOSTILE}`, 'due', ctx())).not.toMatch(UNSAFE);
    expect(ruleText(HOSTILE as string, HOSTILE as never, ctx())).not.toMatch(UNSAFE);
    expect(sizeText(HOSTILE as unknown as number, 'en')).toBe('?');
  });

  it('show prints a hostile reminder and attachment cleaned', async () => {
    const id = '0192f3a0-0000-7000-8000-000000000001';
    const base = taskDto({ id });
    const api = fakeApi({
      'GET /api/v1/me': ME,
      'GET /api/v1/tasks/resolve': base,
      'GET /api/v1/tasks/*': {
        ...base,
        recurrence: `FREQ=${HOSTILE}`,
        recurrenceBasis: 'due',
        description: '',
        parentChain: [],
        subtasks: [],
        reminders: [
          {
            id: 'r',
            taskId: id,
            kind: 'relative',
            offsetMinutes: HOSTILE,
            remindAt: null,
            fireAt: HOSTILE,
            firedAt: null,
            createdAt: 0,
          },
        ],
        attachments: [{ id: 'a', taskId: id, filename: 12, mime: 'x', size: HOSTILE }],
      },
      'GET /api/v1/orgs/*/tags': [],
    });
    const cli = cliHarness({}, { fetch: api.fetch });
    try {
      const result = await cli.run(['show', '1'], { env: FAKE_ENV });
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/Reminders\s+\? · needs a due date/);
      expect(result.stdout).not.toMatch(UNSAFE);
    } finally {
      cli.cleanup();
    }
  });
});

function taskDto(fields: Record<string, unknown> = {}) {
  return {
    id: '0192f3a0-0000-7000-8000-000000000001',
    orgId: ORG.id,
    seq: 41,
    parentId: null,
    subtaskPosition: null,
    title: 'Report',
    hasDescription: false,
    assigneeId: ME.id,
    createdBy: ME.id,
    dueDate: '2026-11-01',
    dueTime: null,
    dueTz: null,
    startDate: null,
    completedAt: null,
    tagIds: [],
    counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
    placement: null,
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  };
}

describe('review finding 3: edit options read with real boundaries', () => {
  async function edit(argv: string[]) {
    const api = fakeApi({
      'GET /api/v1/me': ME,
      'GET /api/v1/tasks/resolve': taskDto(),
      'GET /api/v1/tasks/*': { ...taskDto(), description: '', parentChain: [], subtasks: [] },
      'PATCH /api/v1/tasks/*': (call: { body: unknown }) => ({
        task: taskDto(call.body as Record<string, unknown>),
        ignoredFields: [],
      }),
      'GET /api/v1/orgs/*/tags': [],
    });
    const cli = cliHarness({}, { fetch: api.fetch });
    try {
      const result = await cli.run(['edit', '41', ...argv], { env: FAKE_ENV });
      return { ...result, patches: api.calls.filter((c) => c.method === 'PATCH') };
    } finally {
      cli.cleanup();
    }
  }

  it('--title --no-remind is refused, never read as "clear my reminders"', async () => {
    const result = await edit(['--title', '--no-remind']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--title needs a value');
    expect(result.patches).toEqual([]);
  });

  it('a value that looks like a switch is passed with =', async () => {
    const result = await edit(['--title=--no-remind']);
    expect(result.code).toBe(0);
    expect(result.patches.map((c) => c.body)).toEqual([{ title: '--no-remind' }]);
  });

  it('--no-remind --remind (no value) is refused before anything is sent', async () => {
    for (const argv of [
      ['--no-remind', '--remind'],
      ['--remind', '--no-remind'],
    ]) {
      const result = await edit(argv);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('--remind needs a value');
      expect(result.patches).toEqual([]);
    }
  });

  it('--no-remind with a value after it clears, then adds', async () => {
    const result = await edit(['--no-remind', '--remind', '1h', '--remind=due']);
    expect(result.code).toBe(0);
    expect(result.patches.map((c) => c.body)).toEqual([
      { clearReminders: true, reminders: [{ offsetMinutes: 60 }, { offsetMinutes: 0 }] },
    ]);
  });

  it('after --, words are positional', async () => {
    const result = await edit(['--title', 'x', '--', '--no-remind']);
    expect(result.patches.map((c) => c.body)).toEqual([{ title: 'x' }]);
  });
});

describe('review finding 5: --repeat anchors on the due date', () => {
  it('edit --repeat monthly on a task due Nov 1 sends BYMONTHDAY=1 and keeps the date', async () => {
    const api = fakeApi({
      'GET /api/v1/me': { ...ME, timezone: 'Europe/Stockholm' },
      'GET /api/v1/tasks/resolve': taskDto(),
      'GET /api/v1/tasks/*': { ...taskDto(), description: '', parentChain: [], subtasks: [] },
      'PATCH /api/v1/tasks/*': (call: { body: unknown }) => ({
        task: taskDto(call.body as Record<string, unknown>),
        ignoredFields: [],
      }),
      'GET /api/v1/orgs/*/tags': [],
    });
    const cli = cliHarness({}, { fetch: api.fetch, now: () => now });
    try {
      const result = await cli.run(['edit', '41', '--repeat', 'monthly'], { env: FAKE_ENV });
      expect(result.code).toBe(0);
      expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        recurrence: 'FREQ=MONTHLY;BYMONTHDAY=1',
        recurrenceBasis: 'due',
      });
    } finally {
      cli.cleanup();
    }
  });
});
